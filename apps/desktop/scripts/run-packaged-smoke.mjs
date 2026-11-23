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
 *
 * Evidence for a run that fails or hangs, under apps/desktop/packaged-smoke-logs/ (CI uploads it with `if: always()`):
 *   smoke.log   everything the children print, written as it arrives, with a `[packaged-smoke] phase=` line per phase;
 *   phase.txt   the phase running now, so a killed run still says where it was (timeout.txt: where the limit hit);
 *   app-logs/   each sandbox's logs folder (the shell's main log, which carries the backend's output too), copied every
 *               few seconds while the sandbox exists and once more when the spec removes it.
 * WI_PACKAGED_SMOKE_TIMEOUT_MINUTES (default 17, below the CI step's 20) bounds the whole run: on expiry the running
 * child's process tree (Playwright, the App, its backend, an installer) is killed, the phase is logged, and the run
 * still cleans up and exits non-zero.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { windowsCommandShell } from "@work-intelligence/shared/windows-system-tool";
import { packagedRuntimeNode } from "./packaged-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repositoryRoot = join(desktopRoot, "..", "..");
const require = createRequire(join(repositoryRoot, "package.json"));
const PRODUCT_NAME = "Work Intelligence";
const evidenceDirectory = join(desktopRoot, "packaged-smoke-logs");
const smokeLog = join(evidenceDirectory, "smoke.log");
const appLogDirectory = join(evidenceDirectory, "app-logs");
/** The prefix and userData folder of tests/packaged-smoke/helpers.ts createSandbox. */
const SANDBOX_PREFIX = "wi 打包 smoke ";
const SANDBOX_USER_DATA = "user data 数据";
const timeoutMinutes = Number(process.env.WI_PACKAGED_SMOKE_TIMEOUT_MINUTES ?? "17");
const startedAt = Date.now();

/** Specs that need the App and sandboxes only (phase one) and the ones that change or remove the installation (phase two). */
const APP_SPECS = [
  "app.spec.ts",
  "bundle.spec.ts",
  "launcher.spec.ts",
  "runtime-sqlite.spec.ts",
  "performance.spec.ts",
  // Shows the page files of the packaged asar in the repository's own Electron binary (the packaged App cannot be driven).
  "screenshots.spec.ts",
];
const LIFECYCLE_SPEC = "lifecycle.spec.ts";

let currentPhase = "start";
let currentChild;
let timedOut = false;
let hitTimeout = false;

function elapsed() {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`;
}

function note(line) {
  const text = `[packaged-smoke] ${line} (t=${elapsed()})\n`;
  process.stdout.write(text);
  appendFileSync(smokeLog, text);
}

function phase(name) {
  currentPhase = name;
  writeFileSync(join(evidenceDirectory, "phase.txt"), `${name}\n`);
  note(`phase=${name}`);
}

/** Copies every live sandbox's logs folder into app-logs/ (the specs copy it once more when they remove a sandbox). */
function collectAppLogs() {
  let names;
  try {
    names = readdirSync(os.tmpdir()).filter((name) => name.startsWith(SANDBOX_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const logs = join(os.tmpdir(), name, SANDBOX_USER_DATA, "logs");
    try {
      if (existsSync(logs)) cpSync(logs, join(appLogDirectory, name), { recursive: true, force: true });
    } catch {
      // A sandbox removed mid-copy: its spec keeps the final copy.
    }
  }
}

/** Ends a child and everything it started (Playwright, the App, its backend and helpers, an installer). */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), [
      "/T",
      "/F",
      "/PID",
      String(child.pid),
    ]);
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Runs a child with its output passed through and written to smoke.log as it arrives. On POSIX the child leads its own
 * process group, so the watchdog can end the whole tree.
 */
function run(command, args, options = {}) {
  if (timedOut) return Promise.resolve(1);
  const log = createWriteStream(smokeLog, { flags: "a" });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    currentChild = child;
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        target.write(chunk);
        log.write(chunk);
      });
    }
    child.on("error", (error) => {
      currentChild = undefined;
      log.end();
      reject(error);
    });
    child.on("close", (code) => {
      currentChild = undefined;
      log.end();
      resolve(code ?? 1);
    });
  });
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
async function prepareWindows() {
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
  const status = await runWindowsSetup(join(out, installer), ["/S", `/D=${installDirectory}`]);
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
        await runWindowsSetup(uninstaller, ["/S"]);
        await waitUntilGone(installDirectory, 60_000);
      }
      rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    },
  };
}

/** macOS: extracts the zip the way users do and finds the executable inside the .app. */
async function prepareMac() {
  const out = join(packageDirectory(), "out");
  const [zip] = filesOf(out, ".zip");
  const [dmg] = filesOf(out, ".dmg");
  if (!zip || !dmg) throw new Error(`no .zip and .dmg in ${out}; run \`pnpm package:desktop\` first`);
  const extractRoot = mkdtempSync(join(os.tmpdir(), "wi-packaged-zip-"));
  const status = await run("ditto", ["-x", "-k", join(out, zip), extractRoot]);
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
    ? run("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, ...playwrightArguments], {
        cwd: desktopRoot,
        env: environment,
      })
    : run(process.execPath, playwrightArguments, { cwd: desktopRoot, env: environment });
}

/**
 * DT-07 with the Node binary the packaged App ships (R33): the stress suite (tests/stress/) runs under it for a short
 * load. Opt-in through WI_PACKAGED_STRESS_SECONDS (CI sets it; a local run skips it). Runs before the lifecycle spec,
 * which uninstalls the App. The report goes next to the other package results.
 */
async function runtimeStress(executable) {
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
  // The screenshot spec runs the page in a plain Electron (the packaged App is closed to Playwright); a cached binary
  // makes this a no-op, otherwise it is the one download.
  phase("ensure-electron");
  const ensured = await run(process.execPath, [join(here, "ensure-electron.mjs")]);
  if (ensured !== 0) return ensured;
  phase(process.platform === "win32" ? "install" : "prepare");
  const app = await prepare();
  try {
    const environment = {
      ...process.env,
      ...app.environment,
      WORK_INTELLIGENCE_PACKAGED_EXE: app.executable,
      WORK_INTELLIGENCE_PACKAGED_LOG_DIR: appLogDirectory,
      // tests/packaged-smoke/helpers.ts never ends a process created before this (the CI step's shell, the runner).
      WORK_INTELLIGENCE_PACKAGED_RUN_STARTED_AT: String(startedAt),
    };
    phase(`app-specs (${APP_SPECS.join(", ")})`);
    const appStatus = await playwright(environment, APP_SPECS);
    phase("runtime-stress");
    const stressStatus = await runtimeStress(app.executable);
    // Linux has no installer; the lifecycle spec is skipped there rather than started to skip itself.
    if (process.platform !== "linux") phase(`lifecycle (${LIFECYCLE_SPEC})`);
    const lifecycleStatus = process.platform === "linux" ? 0 : await playwright(environment, [LIFECYCLE_SPEC]);
    return appStatus !== 0 ? appStatus : stressStatus !== 0 ? stressStatus : lifecycleStatus;
  } finally {
    // A timed-out run still uninstalls; the step's own limit stops a cleanup that hangs too.
    timedOut = false;
    phase("cleanup");
    await app.cleanup();
  }
}

rmSync(evidenceDirectory, { recursive: true, force: true });
mkdirSync(appLogDirectory, { recursive: true });
writeFileSync(smokeLog, "");
note(`started on ${process.platform}-${process.arch}, overall limit ${timeoutMinutes} min`);
const collector = setInterval(collectAppLogs, 5_000);
const watchdog = setTimeout(() => {
  timedOut = true;
  hitTimeout = true;
  note(`TIMEOUT after ${timeoutMinutes} min in phase=${currentPhase}; killing the process tree`);
  writeFileSync(join(evidenceDirectory, "timeout.txt"), `timed out after ${timeoutMinutes} min in ${currentPhase}\n`);
  collectAppLogs();
  killTree(currentChild);
}, timeoutMinutes * 60_000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    note(`${signal} in phase=${currentPhase}`);
    collectAppLogs();
    killTree(currentChild);
    process.exit(1);
  });
}

let status = 1;
try {
  status = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  appendFileSync(smokeLog, `${message}\n`);
} finally {
  clearTimeout(watchdog);
  clearInterval(collector);
  collectAppLogs();
}
if (hitTimeout && status === 0) status = 1;
note(`finished with exit ${status}`);
process.exitCode = status;
