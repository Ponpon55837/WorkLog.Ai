#!/usr/bin/env node
/**
 * `pnpm package:desktop [--dir] [--arch <arch>] [--compression store|normal|maximum] [--dmg-format UDZO|ULFO]
 *                       [--compare-compression] [--electron-dist <directory>] [--baseline]`
 *
 * Packages the desktop App for the host platform (a runtime is the host's own official Node binary, so each OS and
 * architecture builds natively; `--arch` must be the host's):
 *
 *   1. builds the runtime (scripts/desktop-runtime-spike/build.mjs) and stages runtime-bundle/{current,runtimes/<id>}
 *   2. builds the shell with --production and the SHA-256 of the runtime manifest, and checks the bundle has no test hooks
 *   3. stages a clean app directory (package.json + dist/, no dependencies)
 *   4. electron-builder packs the unpacked app (fuses, signing on macOS), then each installer target from that app
 *   5. verifies the runtime bundle INSIDE the packed app against its manifest (every file hashed), and on macOS runs
 *      `codesign --verify --deep --strict` (must pass) and `spctl --assess` (recorded only)
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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Arch, Platform, build } from "electron-builder";
import {
  ARCHITECTURES_BY_PLATFORM,
  COMPRESSION_CHOICES,
  DMG_FORMAT_CHOICES,
  PRODUCT_NAME,
  TARGETS_BY_PLATFORM,
  createBuilderConfig,
  pinnedElectronVersion,
} from "../electron-builder.config.mjs";
import { DEFAULT_COMPRESSION, DEFAULT_DMG_FORMAT, SIZE_GATES } from "./package-gates.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "../..");
const platformTag = `${process.platform}-${process.arch}`;
const workDirectory = join(repositoryRoot, "dist", "desktop-package", platformTag);
const resultsDirectory = join(desktopDirectory, "package-results");
const INSTALLER_EXTENSIONS = [".exe", ".dmg", ".zip"];
/** Files that only an auto-updater reads; this stage ships none (R4 §7.1), so any that appear are removed. */
const UPDATE_METADATA = /(^latest.*\.yml$|\.blockmap$)/;
const PLATFORMS = { win32: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX };

function parseOptions() {
  const { values } = parseArgs({
    options: {
      dir: { type: "boolean", default: false },
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
    name: "work-intelligence-desktop",
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

/** Builds every installer target from the already packed app, timing each one. */
async function buildInstallers({ options, paths, version, compression, dmgFormat, outputDirectory, packedApp }) {
  const timings = {};
  const config = createBuilderConfig({ ...paths, version, ...options, compression, dmgFormat, outputDirectory });
  for (const target of TARGETS_BY_PLATFORM[process.platform]) {
    const startedAt = Date.now();
    await build({
      targets: PLATFORMS[process.platform].createTarget(target, Arch[options.arch]),
      config,
      prepackaged: packedApp,
      publish: "never",
    });
    timings[target] = seconds(startedAt);
  }
  return { timings, ...collectInstallers(outputDirectory) };
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

/** macOS: the ad-hoc signature must verify (hard gate); Gatekeeper assessment and the runtime's own signature are recorded. */
function verifyMacSigning(packedApp) {
  const codesign = capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", packedApp]);
  if (codesign.exitCode !== 0) throw new Error(`codesign --verify --deep --strict failed:\n${codesign.output}`);
  const nodeBinary = join(resourcesDirectoryOf(packedApp), "runtime-bundle");
  const runtimeNode = findFile(nodeBinary, "node");
  return {
    codesignVerify: codesign,
    spctlAssess: capture("spctl", ["--assess", "--type", "execute", "-vv", packedApp]),
    runtimeNodeSignature: runtimeNode ? capture("codesign", ["--verify", "--strict", runtimeNode]) : null,
  };
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

async function main() {
  const options = parseOptions();
  const startedAt = Date.now();
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
  const timings = {};

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
  const macSigning = process.platform === "darwin" ? verifyMacSigning(packedApp) : null;
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
