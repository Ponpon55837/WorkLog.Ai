#!/usr/bin/env node
/**
 * `pnpm package:desktop [--dir] [--skip-build] [--arch <arch>] [--compression store|normal|maximum]
 *                       [--dmg-format UDZO|ULFO] [--compare-compression] [--electron-dist <directory>] [--baseline]`
 *
 * Packages the desktop App for the host platform (a runtime is the host's own official Node binary, so each OS and
 * architecture builds natively; `--arch` must be the host's):
 *
 *   0. runs the workspace build (`pnpm build`, scripts/workspace-build.mjs) unless `--skip-build`, so a local package is
 *      one command; CI builds in its own step and passes `--skip-build`
 *   1. builds the runtime (scripts/desktop-runtime-spike/build.mjs) and stages runtime-bundle/{current,runtimes/<id>}
 *   2. builds the shell with --production and the SHA-256 of the runtime manifest, and checks the bundle has no test hooks
 *   3. stages a clean app directory (package.json + dist/, no dependencies)
 *   4. electron-builder packs the unpacked app and signs nothing; its afterPack hook (scripts/after-pack.mjs) flips the
 *      fuses and, on macOS, ad-hoc signs the app inside-out, identically on pull-request and release builds. Each
 *      installer target is then built from that app
 *   5. verifies the icon files parse (macOS: the packed icon.icns is the custom one), the runtime bundle INSIDE the packed
 *      app against its manifest (every file hashed) and the fuse wire read back from the binary; on macOS also
 *      `codesign --verify --deep --strict` on the app and on the extracted zip, `codesign --verify --strict` on the
 *      bundled node, relative in-app runtime symlinks (all must pass) and `spctl --assess` (recorded only)
 *   6. writes package-results/package-<platform>-<arch>.json (timings, sizes, gates) and fails on a size gate
 *
 * `--dir` stops after the unpacked app (Linux always does: it is a local check, not shipped). `--baseline` is the naive
 * build (all Electron locales, source maps, no production flag) used once to measure what the filtering saves.
 * Everything goes under dist/desktop-package/<platform>-<arch>/.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import fuses from "@electron/fuses";
import { Arch, Platform, build } from "electron-builder";
import {
  ARCHITECTURES_BY_PLATFORM,
  COMPRESSION_CHOICES,
  DMG_FORMAT_CHOICES,
  ICON_FILES,
  PRODUCT_NAME,
  TARGETS_BY_PLATFORM,
  createBuilderConfig,
  pinnedElectronVersion,
} from "../electron-builder.config.mjs";
import { APP_FUSES } from "./app-fuses.mjs";
import { verifyIconFiles } from "./icon-files.mjs";
import { DEFAULT_COMPRESSION, DEFAULT_DMG_FORMAT, SIZE_GATES } from "./package-gates.mjs";
import { runWorkspaceBuild } from "./workspace-build.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "../..");
const platformTag = `${process.platform}-${process.arch}`;
const workDirectory = join(repositoryRoot, "dist", "desktop-package", platformTag);
const resultsDirectory = join(desktopDirectory, "package-results");
const { FuseV1Options, getCurrentFuseWire } = fuses;
/** A fuse wire byte: the ASCII digit "1" (enabled) or "0" (disabled), as @electron/fuses writes it. */
const FUSE_ENABLED = 0x31;
const FUSE_DISABLED = 0x30;
const STAGED_PACKAGE_NAME = "work-intelligence-desktop";
const MIB = 1024 * 1024;
const INSTALLER_EXTENSIONS = [".exe", ".dmg", ".zip"];
/** Files that only an auto-updater reads; this stage ships none (R4 §7.1), so any that appear are removed. */
const UPDATE_METADATA = /(^latest.*\.yml$|\.blockmap$)/;
const PLATFORMS = { win32: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX };

function parseOptions() {
  const { values } = parseArgs({
    options: {
      dir: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      arch: { type: "string", default: process.arch },
      compression: { type: "string", default: DEFAULT_COMPRESSION },
      "dmg-format": { type: "string", default: DEFAULT_DMG_FORMAT },
      "compare-compression": { type: "boolean", default: false },
      "electron-dist": { type: "string" },
      baseline: { type: "boolean", default: false },
    },
  });
  if (!(process.platform in PLATFORMS)) throw new Error(`unsupported platform ${process.platform}`);
  if (!ARCHITECTURES_BY_PLATFORM[process.platform].includes(values.arch)) {
    throw new Error(`--arch must be one of ${ARCHITECTURES_BY_PLATFORM[process.platform].join(", ")}`);
  }
  if (values.arch !== process.arch) {
    throw new Error(
      `--arch ${values.arch} differs from the host (${process.arch}); the runtime is built natively per architecture`,
    );
  }
  if (!COMPRESSION_CHOICES.includes(values.compression)) {
    throw new Error(`--compression must be one of ${COMPRESSION_CHOICES.join(", ")}`);
  }
  if (!DMG_FORMAT_CHOICES.includes(values["dmg-format"])) {
    throw new Error(`--dmg-format must be one of ${DMG_FORMAT_CHOICES.join(", ")}`);
  }
  return {
    directoryOnly: values.dir || process.platform === "linux",
    skipBuild: values["skip-build"],
    arch: values.arch,
    compression: values.compression,
    dmgFormat: values["dmg-format"],
    compare: values["compare-compression"],
    electronDist: values["electron-dist"] ? resolve(values["electron-dist"]) : undefined,
    baseline: values.baseline,
  };
}

function seconds(startedAt) {
  return Number(((Date.now() - startedAt) / 1000).toFixed(1));
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
}

/** Runs a tool whose result is only recorded; returns its exit code and trimmed output. */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { exitCode: result.status, output: output.length > 2000 ? `${output.slice(0, 2000)}…` : output };
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Total bytes of the regular files below `path`; symbolic links count as zero (they are not followed). */
function directoryBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + directoryBytes(join(path, name)), 0);
}

/** Copies `current` and `runtimes/<id>` (without the verification cache and without bin/) of a launcher root. */
function stageRuntimeBundle(launcherRoot, bundleDirectory) {
  const runtimeId = readFileSync(join(launcherRoot, "current"), "utf8").trim();
  mkdirSync(bundleDirectory, { recursive: true });
  cpSync(join(launcherRoot, "current"), join(bundleDirectory, "current"));
  cpSync(join(launcherRoot, "runtimes", runtimeId), join(bundleDirectory, "runtimes", runtimeId), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !source.endsWith(".verified.json"),
  });
  const manifestPath = join(bundleDirectory, "runtimes", runtimeId, "runtime-manifest.json");
  return { runtimeId, manifestSha256: sha256OfFile(manifestPath) };
}

function stageAppDirectory(directory, version) {
  mkdirSync(directory, { recursive: true });
  cpSync(join(desktopDirectory, "dist"), join(directory, "dist"), { recursive: true });
  // No dependencies: the shell is a single bundle, so no node_modules is shipped.
  const manifest = {
    name: STAGED_PACKAGE_NAME,
    productName: PRODUCT_NAME,
    version,
    description: "Local-first work records for coding agents.",
    author: PRODUCT_NAME,
    license: "MIT",
    type: "module",
    main: "dist/main/index.mjs",
  };
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The unpacked app directory electron-builder wrote (`win-unpacked`, `linux-unpacked`, `mac-arm64/<product>.app`, …). */
function findPackedApp(outputDirectory) {
  for (const name of readdirSync(outputDirectory)) {
    const path = join(outputDirectory, name);
    if (name.endsWith("-unpacked")) return path;
    if (name.startsWith("mac") && statSync(path).isDirectory()) return join(path, `${PRODUCT_NAME}.app`);
  }
  throw new Error(`no unpacked app found in ${outputDirectory}`);
}

function resourcesDirectoryOf(packedApp) {
  return process.platform === "darwin" ? join(packedApp, "Contents", "Resources") : join(packedApp, "resources");
}

/** Removes update metadata (none is wanted) and lists the installers left in `outputDirectory`. */
function collectInstallers(outputDirectory) {
  const removed = [];
  const installers = [];
  for (const name of readdirSync(outputDirectory)) {
    const path = join(outputDirectory, name);
    if (!statSync(path).isFile()) continue;
    if (UPDATE_METADATA.test(name)) {
      rmSync(path);
      removed.push(name);
    } else if (INSTALLER_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      installers.push({ file: name, bytes: statSync(path).size });
    }
  }
  return { installers, removed };
}

async function packUnpackedApp(options, paths, version) {
  const config = createBuilderConfig({ ...paths, version, ...options, outputDirectory: paths.outputDirectory });
  await build({
    targets: PLATFORMS[process.platform].createTarget("dir", Arch[options.arch]),
    config,
    publish: "never",
  });
  return findPackedApp(paths.outputDirectory);
}

/**
 * Builds every installer target from the already packed app, timing each one. Each `build()` gets a config of its own:
 * electron-builder normalizes `files` in place (merged entries become null), so a reused config fails the next build.
 */
async function buildInstallers({ options, paths, version, compression, dmgFormat, outputDirectory, packedApp }) {
  const timings = {};
  for (const target of TARGETS_BY_PLATFORM[process.platform]) {
    const startedAt = Date.now();
    await build({
      targets: PLATFORMS[process.platform].createTarget(target, Arch[options.arch]),
      config: createBuilderConfig({ ...paths, version, ...options, compression, dmgFormat, outputDirectory }),
      prepackaged: packedApp,
      publish: "never",
    });
    timings[target] = seconds(startedAt);
  }
  return { timings, ...collectInstallers(outputDirectory) };
}

/** One line in the CI log for each verification, so the log itself shows what was checked. */
function logStep(message) {
  console.log(`[package] ${message}`);
}

/** Hashes the packed runtime bundle against its manifest with the same code the App runs at start. */
async function verifyPackedRuntime(packedApp, expected) {
  const bundle = join(resourcesDirectoryOf(packedApp), "runtime-bundle");
  const current = readFileSync(join(bundle, "current"), "utf8").trim();
  if (current !== expected.runtimeId)
    throw new Error(`runtime-bundle/current is ${current}, expected ${expected.runtimeId}`);
  const manifestSha256 = sha256OfFile(join(bundle, "runtimes", current, "runtime-manifest.json"));
  if (manifestSha256 !== expected.manifestSha256)
    throw new Error("the packed runtime manifest differs from the one the shell was built with");
  const { verifyRuntime } = await import(
    pathToFileURL(join(repositoryRoot, "packages/desktop-core/dist/index.js")).href
  );
  // Content only: the build machine's ACLs say nothing about the installed App (a Windows runner's workspace inherits
  // Authenticated Users Modify); the installed copy gets the real ACL check at first launch.
  const verified = await verifyRuntime(bundle, current, { useCache: false, checkAcl: false });
  if (existsSync(join(bundle, "runtimes", current, ".verified.json")))
    throw new Error("a verification cache was packed");
  return {
    runtimeId: current,
    manifestSha256,
    files: verified.fileCount,
    hashed: verified.hashedCount,
    acl: verified.acl,
  };
}

/** The icon sources must parse, and on macOS the packed .app must carry the custom icns, not Electron's default. */
function verifyIcons(packedApp) {
  const icons = verifyIconFiles();
  if (process.platform === "darwin") {
    const packedIcon = join(resourcesDirectoryOf(packedApp), "icon.icns");
    if (!existsSync(packedIcon) || !readFileSync(packedIcon).equals(readFileSync(ICON_FILES.icns)))
      throw new Error(`${packedIcon} is not the custom icon.icns`);
  }
  return icons;
}

/** macOS: the signature must verify (hard gate), the seal must be ad-hoc; Gatekeeper assessment is only recorded. */
function verifyMacSigning(packedApp) {
  const codesign = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", packedApp]);
  if (codesign.exitCode !== 0) throw new Error(`codesign --verify --deep --strict failed:\n${codesign.output}`);
  // The seal must be the ad-hoc one the afterPack hook made after the fuses, not Electron's original (broken) signature.
  const details = capture("codesign", ["--display", "--verbose=2", packedApp]);
  if (!/Signature=adhoc/.test(details.output)) throw new Error(`the app is not ad-hoc signed:\n${details.output}`);
  const runtimeNode = findFile(join(resourcesDirectoryOf(packedApp), "runtime-bundle"), "node");
  if (!runtimeNode) throw new Error("no node binary found in the packed runtime bundle");
  // The official Node binary must keep its own, untouched signature.
  const runtimeNodeSignature = capture("codesign", ["--verify", "--strict", runtimeNode]);
  if (runtimeNodeSignature.exitCode !== 0)
    throw new Error(`the bundled node binary no longer verifies:\n${runtimeNodeSignature.output}`);
  return {
    codesignVerify: codesign,
    spctlAssess: capture("spctl", ["--assess", "--type", "execute", "-vv", packedApp]),
    runtimeNodeSignature,
    runtimeSymlinks: verifyRuntimeSymlinks(packedApp),
  };
}

/** Every symbolic link in the runtime bundle must be relative and resolve to a path inside the .app. */
function verifyRuntimeSymlinks(packedApp) {
  const appRoot = realpathSync(packedApp);
  const links = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) throw new Error(`${path} is an absolute symbolic link (${target})`);
        const resolved = resolve(dirname(path), target);
        const inside = relative(appRoot, existsSync(resolved) ? realpathSync(resolved) : resolved);
        if (inside.startsWith("..") || isAbsolute(inside))
          throw new Error(`${path} points outside the app (${target})`);
        links.push(relative(packedApp, path));
      }
    }
  };
  visit(join(resourcesDirectoryOf(packedApp), "runtime-bundle"));
  return links;
}

/** macOS: the shipped zip, extracted, must verify like the packed app (what users get, not what we built). */
function verifyShippedZip(installers) {
  const zip = installers.find((installer) => installer.file.endsWith(".zip"));
  if (!zip) throw new Error("no zip installer to verify");
  const extractDirectory = mkdtempSync(join(tmpdir(), "worklog-zip-"));
  try {
    run("ditto", ["-x", "-k", join(workDirectory, "out", zip.file), extractDirectory], "zip extraction");
    const extractedApp = join(extractDirectory, `${PRODUCT_NAME}.app`);
    const codesign = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
    if (codesign.exitCode !== 0)
      throw new Error(`codesign --verify --deep --strict failed on the extracted zip:\n${codesign.output}`);
    return { file: zip.file, codesignVerify: codesign };
  } finally {
    rmSync(extractDirectory, { recursive: true, force: true });
  }
}

/** The executable whose fuse wire is read: the .app on macOS (the library resolves its framework), else the binary. */
function electronBinaryOf(packedApp) {
  if (process.platform === "darwin") return packedApp;
  if (process.platform === "win32") return join(packedApp, `${PRODUCT_NAME}.exe`);
  // On Linux electron-builder names the executable after the staged package.json `name`.
  return join(packedApp, STAGED_PACKAGE_NAME);
}

/** Reads the fuse wire back from the packed binary and requires every fuse of APP_FUSES to be set as configured. */
async function verifyFuses(packedApp) {
  const wire = await getCurrentFuseWire(electronBinaryOf(packedApp));
  const checks = Object.entries(APP_FUSES).map(([name, enabled]) => {
    const expected = enabled ? FUSE_ENABLED : FUSE_DISABLED;
    const actual = wire[FuseV1Options[name.charAt(0).toUpperCase() + name.slice(1)]];
    return { name, expected, actual, passed: actual === expected };
  });
  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0)
    throw new Error(
      `fuses differ from the configuration: ${failed.map((check) => `${check.name}=${check.actual}`).join(", ")}`,
    );
  return checks;
}

function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

function measurePackedApp(packedApp) {
  const resources = resourcesDirectoryOf(packedApp);
  const unpackedBytes = directoryBytes(packedApp);
  const frameworks = process.platform === "darwin" ? join(packedApp, "Contents", "Frameworks") : null;
  return {
    unpackedBytes,
    asarBytes: statSync(join(resources, "app.asar")).size,
    runtimeBundleBytes: directoryBytes(join(resources, "runtime-bundle")),
    // The Electron framework: the macOS Frameworks folder, elsewhere everything outside resources/.
    electronFrameworkBytes: frameworks ? directoryBytes(frameworks) : unpackedBytes - directoryBytes(resources),
  };
}

function evaluateGates(sizes, installers) {
  const limits = SIZE_GATES[platformTag];
  if (!limits) return [{ name: "gates defined", passed: false, actual: platformTag, limit: "a SIZE_GATES entry" }];
  const checks = ["unpackedBytes", "runtimeBundleBytes", "asarBytes"].map((name) => ({
    name,
    actual: sizes[name],
    limit: limits[name],
    passed: limits[name] > 0 && sizes[name] <= limits[name],
  }));
  for (const installer of installers) {
    checks.push({
      name: `installer ${installer.file}`,
      actual: installer.bytes,
      limit: limits.installerBytes,
      passed: installer.bytes <= limits.installerBytes,
    });
  }
  return checks;
}

const TARGET_EXTENSIONS = { nsis: ".exe", dmg: ".dmg", zip: ".zip" };

/** Prints the default and the alternative compression side by side: one row per installer target and variant. */
function printComparison(options, installers, targetSeconds, comparison) {
  const variants = [
    { label: `${options.compression} / ${options.dmgFormat} (default)`, installers, seconds: targetSeconds },
    {
      label: `${comparison.compression} / ${comparison.dmgFormat}`,
      installers: comparison.installers,
      seconds: comparison.targetSeconds,
    },
  ];
  const rows = [["target", "variant", "file", "MiB", "build s"]];
  for (const target of TARGETS_BY_PLATFORM[process.platform]) {
    for (const variant of variants) {
      const installer = variant.installers.find((entry) => entry.file.endsWith(TARGET_EXTENSIONS[target]));
      rows.push([
        target,
        variant.label,
        installer?.file ?? "(none)",
        installer ? (installer.bytes / MIB).toFixed(2) : "-",
        String(variant.seconds[target]),
      ]);
    }
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  console.log(`\nCompression comparison (${platformTag}, NSIS/zip compression and DMG format):`);
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join("  "));
}

async function main() {
  const options = parseOptions();
  const startedAt = Date.now();
  const buildSeconds = runWorkspaceBuild({ repositoryRoot, skip: options.skipBuild });
  logStep(buildSeconds === undefined ? "build skipped (--skip-build)" : `build ${buildSeconds} s`);
  const version = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
  const launcherRoot = join(workDirectory, "runtime-root");
  const paths = {
    stageDirectory: join(workDirectory, "app"),
    runtimeBundleDirectory: join(workDirectory, "runtime-bundle"),
    outputDirectory: join(workDirectory, "out"),
    electronDist: options.electronDist,
  };
  rmSync(workDirectory, { recursive: true, force: true });
  mkdirSync(workDirectory, { recursive: true });
  const timings = buildSeconds === undefined ? {} : { buildSeconds };

  let step = Date.now();
  run(
    process.execPath,
    [join(repositoryRoot, "scripts/desktop-runtime-spike/build.mjs"), "--runtime", "node", "--out", launcherRoot],
    "runtime build",
  );
  const runtime = stageRuntimeBundle(launcherRoot, paths.runtimeBundleDirectory);
  timings.runtimeBuildSeconds = seconds(step);

  step = Date.now();
  const shellArguments = options.baseline ? [] : ["--production", "--bundled-runtime-sha256", runtime.manifestSha256];
  run(process.execPath, [join(desktopDirectory, "scripts/build.mjs"), ...shellArguments], "shell build");
  if (!options.baseline)
    run(process.execPath, [join(desktopDirectory, "scripts/check-production-bundle.mjs")], "production bundle check");
  stageAppDirectory(paths.stageDirectory, version);
  timings.shellBuildSeconds = seconds(step);

  step = Date.now();
  const packedApp = await packUnpackedApp(options, paths, version);
  timings.electronBuilderPackSeconds = seconds(step);

  step = Date.now();
  const packedRuntime = await verifyPackedRuntime(packedApp, runtime);
  logStep(
    `packed runtime ${packedRuntime.runtimeId} verified: ${packedRuntime.files} files, ${packedRuntime.hashed} hashed`,
  );
  const icons = verifyIcons(packedApp);
  logStep("icons verified");
  const fuses = await verifyFuses(packedApp);
  logStep(
    `fuses read back: ${fuses.map((check) => `${check.name}=${check.actual === FUSE_ENABLED ? "on" : "off"}`).join(" ")}`,
  );
  const macSigning = process.platform === "darwin" ? verifyMacSigning(packedApp) : null;
  if (macSigning) {
    logStep("codesign --verify --deep --strict passed; Signature=adhoc; bundled node signature verifies");
    logStep(
      `symbolic links in the runtime bundle: ${macSigning.runtimeSymlinks.length}, all relative and inside the app`,
    );
    logStep(`spctl --assess exit ${macSigning.spctlAssess.exitCode} (recorded only)`);
  }
  timings.verifySeconds = seconds(step);

  let installers = [];
  let updateMetadataRemoved = [];
  let comparison = null;
  if (!options.directoryOnly) {
    const common = { options, paths, version, packedApp };
    const built = await buildInstallers({
      ...common,
      compression: options.compression,
      dmgFormat: options.dmgFormat,
      outputDirectory: paths.outputDirectory,
    });
    installers = built.installers;
    updateMetadataRemoved = built.removed;
    if (process.platform === "darwin") {
      macSigning.shippedZip = verifyShippedZip(installers);
      logStep(`extracted ${macSigning.shippedZip.file} passes codesign --verify --deep --strict`);
    }
    timings.targetSeconds = built.timings;
    if (options.compare) {
      const alternative = {
        compression: options.compression === "maximum" ? "normal" : "maximum",
        dmgFormat: options.dmgFormat === "ULFO" ? "UDZO" : "ULFO",
      };
      const compared = await buildInstallers({
        ...common,
        ...alternative,
        outputDirectory: join(workDirectory, "out-compare"),
      });
      comparison = { ...alternative, targetSeconds: compared.timings, installers: compared.installers };
      printComparison(options, installers, built.timings, comparison);
    }
  }
  timings.totalSeconds = seconds(startedAt);

  const sizes = { ...measurePackedApp(packedApp), installers };
  const gates = evaluateGates(sizes, installers);
  const results = {
    platform: process.platform,
    arch: options.arch,
    appVersion: version,
    electronVersion: pinnedElectronVersion(),
    mode: options.directoryOnly ? "dir" : "installers",
    settings: { compression: options.compression, dmgFormat: options.dmgFormat, baseline: options.baseline },
    timings,
    sizes,
    runtime: { ...runtime, packed: packedRuntime },
    icons,
    fuses,
    macSigning,
    updateMetadataRemoved,
    comparison,
    gates: { passed: gates.every((check) => check.passed), checks: gates },
  };
  mkdirSync(resultsDirectory, { recursive: true });
  const resultsPath = join(resultsDirectory, `package-${platformTag}.json`);
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ resultsPath, timings, sizes, gatesPassed: results.gates.passed }, null, 2));
  if (!results.gates.passed) {
    throw new Error(
      `size gates exceeded: ${gates
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(", ")}`,
    );
  }
}

await main();
