#!/usr/bin/env node
/**
 * `pnpm test:desktop-packaged`: the packaged-App smoke test. It tests what a user gets, never the unpackaged build:
 *
 *   Windows  the NSIS installer from dist/desktop-package/win32-x64/out, run silently (`/S`, per user) into a temp
 *            folder (`/D=`), and the INSTALLED exe. Phase two upgrades over the running App and uninstalls.
 *   macOS    the .app inside the zip (extracted with `ditto -x -k`, as a user's browser and Finder do), started through
 *            Contents/MacOS/<exe> and not `open`. Phase two checks the DMG (mounted read-only, no Finder window).
 *   Linux    the unpacked directory of `pnpm package:desktop --dir`, under `xvfb-run -a` and with `--no-sandbox` (local
 *            regression check only; V1 ships on Windows and macOS).
 *
 * Needs `pnpm package:desktop` (or `--dir`) first. Playwright then runs apps/desktop/playwright.packaged.config.ts with the
 * executable in WORK_INTELLIGENCE_PACKAGED_EXE (read by the tests only, never by the App). Every test works in a temp
 * sandbox with its own userData, home and database: nothing of the developer's data is read or written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { windowsCommandShell } from "@work-intelligence/shared/windows-system-tool";
import { packagedRuntimeNode } from "./packaged-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repositoryRoot = join(desktopRoot, "..", "..");
const require = createRequire(join(repositoryRoot, "package.json"));
const PRODUCT_NAME = "Work Intelligence";

/** Specs that need the App and sandboxes only (phase one) and the ones that change or remove the installation (phase two). */
const APP_SPECS = [
  "app.spec.ts",
  "bundle.spec.ts",
  "launcher.spec.ts",
  "runtime-sqlite.spec.ts",
  "performance.spec.ts",
];
const LIFECYCLE_SPEC = "lifecycle.spec.ts";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function filesOf(directory, suffix) {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(suffix)) : [];
}

function packageDirectory() {
  return join(repositoryRoot, "dist", "desktop-package", `${process.platform}-${process.arch}`);
}

/**
 * NSIS reads `/D=` raw and last, so the command line is built by hand and passed through cmd without Node's quoting.
 * A setup is a GUI program, which cmd does not wait for unless `start /wait` runs it (and returns its exit code).
 */
function runWindowsSetup(file, args) {
  const commandLine = `"start /wait "" ${[`"${file}"`, ...args].join(" ")}"`;
  return run(windowsCommandShell(), ["/d", "/s", "/c", commandLine], { windowsVerbatimArguments: true });
}

async function waitUntilGone(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path) && Date.now() < deadline) await delay(500);
  return !existsSync(path);
}

/** Windows: installs the newest installer into a temp folder and returns what the tests need and how to clean up. */
function prepareWindows() {
  const out = join(packageDirectory(), "out");
  const [installer] = filesOf(out, "-setup.exe");
  if (!installer) throw new Error(`no NSIS installer in ${out}; run \`pnpm package:desktop\` first`);
  // A per-user install is registered under the user's profile: refuse to replace a real installation on a dev machine.
  const defaultInstall = join(process.env.LOCALAPPDATA ?? "", "Programs", PRODUCT_NAME);
  if (!process.env.CI && existsSync(defaultInstall)) {
    throw new Error(
      `${PRODUCT_NAME} is installed at ${defaultInstall}; the installer test would replace it. Uninstall it first.`,
    );
  }
  const installRoot = mkdtempSync(join(os.tmpdir(), "wi-packaged-install-"));
  const installDirectory = join(installRoot, PRODUCT_NAME);
  const status = runWindowsSetup(join(out, installer), ["/S", `/D=${installDirectory}`]);
  if (status !== 0) throw new Error(`the installer exited ${status}`);
  const executable = join(installDirectory, `${PRODUCT_NAME}.exe`);
  if (!existsSync(executable)) throw new Error(`${executable} was not installed`);
  return {
    executable,
    environment: {
      WORK_INTELLIGENCE_PACKAGED_INSTALLER: join(out, installer),
      WORK_INTELLIGENCE_PACKAGED_INSTALL_DIR: installDirectory,
    },
    async cleanup() {
      // The lifecycle spec uninstalls; this only covers a run that stopped before it.
      const uninstaller = join(installDirectory, `Uninstall ${PRODUCT_NAME}.exe`);
      if (existsSync(uninstaller)) {
        runWindowsSetup(uninstaller, ["/S"]);
        await waitUntilGone(installDirectory, 60_000);
      }
      rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    },
  };
}

/** macOS: extracts the zip the way users do and finds the executable inside the .app. */
function prepareMac() {
  const out = join(packageDirectory(), "out");
  const [zip] = filesOf(out, ".zip");
  const [dmg] = filesOf(out, ".dmg");
  if (!zip || !dmg) throw new Error(`no .zip and .dmg in ${out}; run \`pnpm package:desktop\` first`);
  const extractRoot = mkdtempSync(join(os.tmpdir(), "wi-packaged-zip-"));
  const status = run("ditto", ["-x", "-k", join(out, zip), extractRoot]);
  if (status !== 0) throw new Error(`ditto failed (exit ${status})`);
  const [bundle] = filesOf(extractRoot, ".app");
  if (!bundle) throw new Error("the zip holds no .app");
  const macOsDirectory = join(extractRoot, bundle, "Contents", "MacOS");
  const [executableName] = readdirSync(macOsDirectory);
  return {
    executable: join(macOsDirectory, executableName),
    environment: { WORK_INTELLIGENCE_PACKAGED_DMG: join(out, dmg) },
    cleanup: () => rmSync(extractRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
  };
}

function prepareLinux() {
  // electron-builder names the Linux binary after the staged app's package name.
  const stagedPackage = JSON.parse(readFileSync(join(packageDirectory(), "app", "package.json"), "utf8"));
  const executable = join(packageDirectory(), "out", "linux-unpacked", stagedPackage.name);
  if (!existsSync(executable)) throw new Error(`${executable} is missing; run \`pnpm package:desktop --dir\` first`);
  return { executable, environment: {}, cleanup: () => undefined };
}

function prepare() {
  if (process.platform === "win32") return prepareWindows();
  if (process.platform === "darwin") return prepareMac();
  if (process.platform === "linux") return prepareLinux();
  throw new Error(`unsupported platform ${process.platform}`);
}

function playwright(environment, specs) {
  const cli = require.resolve("@playwright/test/cli");
  const playwrightArguments = [
    cli,
    "test",
    "-c",
    join(desktopRoot, "playwright.packaged.config.ts"),
    ...specs,
    ...process.argv.slice(2),
  ];
  const needsDisplay = process.platform === "linux" && !process.env.DISPLAY;
  return needsDisplay
    ? run("xvfb-run", ["-a", process.execPath, ...playwrightArguments], { cwd: desktopRoot, env: environment })
    : run(process.execPath, playwrightArguments, { cwd: desktopRoot, env: environment });
}

/**
 * DT-07 with the Node binary the packaged App ships (R33): the stress suite (tests/stress/) runs under it for a short
 * load. Opt-in through WI_PACKAGED_STRESS_SECONDS (CI sets it; a local run skips it). Runs before the lifecycle spec,
 * which uninstalls the App. The report goes next to the other package results.
 */
function runtimeStress(executable) {
  const seconds = process.env.WI_PACKAGED_STRESS_SECONDS;
  if (!seconds) return 0;
  const { nodePath, runtimeId } = packagedRuntimeNode(executable);
  process.stdout.write(`[packaged-stress] runtime ${runtimeId}, ${seconds}s load\n`);
  return run(
    process.execPath,
    [
      join(repositoryRoot, "scripts", "run-sqlite-stress-with-node.mjs"),
      "--node",
      nodePath,
      "--copy-to",
      join(desktopRoot, "package-results", `package-sqlite-stress-${process.platform}-${process.arch}.json`),
    ],
    { cwd: repositoryRoot, env: { ...process.env, WI_SQLITE_STRESS_SECONDS: seconds } },
  );
}

async function main() {
  const app = prepare();
  try {
    const environment = {
      ...process.env,
      ...app.environment,
      WORK_INTELLIGENCE_PACKAGED_EXE: app.executable,
    };
    const appStatus = playwright(environment, APP_SPECS);
    const stressStatus = runtimeStress(app.executable);
    // Linux has no installer; the lifecycle spec is skipped there rather than started to skip itself.
    const lifecycleStatus = process.platform === "linux" ? 0 : playwright(environment, [LIFECYCLE_SPEC]);
    return appStatus !== 0 ? appStatus : stressStatus !== 0 ? stressStatus : lifecycleStatus;
  } finally {
    await app.cleanup();
  }
}

let status = 1;
try {
  status = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
process.exitCode = status;
