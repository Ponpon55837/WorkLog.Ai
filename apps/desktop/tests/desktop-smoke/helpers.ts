import { _electron, type ElectronApplication, type TestInfo } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isSettledRepairFailure } from "@work-intelligence/desktop-core";
import { windowsPowerShell } from "@work-intelligence/shared/windows-system-tool";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  computeInstanceProof,
} from "@work-intelligence/shared/instance-proof";

import {
  freePort,
  portIsFree,
  powershellArguments,
  processIsAlive,
  profileDirectories,
} from "../support/process-tools.js";

export { freePort, portIsFree, processIsAlive, profileDirectories };

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..", "..");

export const mainEntry = join(desktopRoot, "dist", "main", "index.mjs");
/** The path of the Electron binary (the `electron` package exports it). */
export const electronBinary: string = require("electron") as string;

/** What the main process shows through its non-packaged test hook. */
export interface MainSnapshot {
  owner: string;
  backend: { pid: number; port: number; execPath: string; runId: string } | null;
  repairWindowOpen: boolean;
  secondInstanceCount: number;
  lastSecondInstanceDecision: string | null;
  openedExternal: string[];
  recentErrors: string[];
  /** Titles of the "ready again" notifications the App tried to show. */
  notifications: string[];
  logFile: string;
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly port: number;
  readonly emptyBin: string;
  readonly runtimeRoot: string;
}

/** The runtime the smoke script built; the specs never build one themselves. */
export function runtimeRootFromEnvironment(): string {
  const value = process.env.WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT;
  if (!value) throw new Error("WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT is not set; run `pnpm test:desktop-smoke`.");
  return value;
}

/** Synthetic data only: a database created by the real store in a temporary folder, never anything of the developer's. */
export async function createSandbox(options: { withDatabase: boolean }): Promise<Sandbox> {
  // `.native` expands Windows 8.3 short names (`RUNNER~1`) and macOS `/var` -> `/private/var`, so every path the test
  // derives matches what the App and its child report.
  const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "wi-desktop-smoke-")));
  const home = join(root, "home");
  const dataDirectory = join(root, "data");
  const emptyBin = join(root, "empty-bin");
  // The per-user folders a real profile always has; appEnvironment points every profile variable at one of them, and
  // Windows resolves known folders (Roaming and Local AppData) only when they exist.
  for (const directory of [...Object.values(profileDirectories(home)), dataDirectory, emptyBin]) {
    mkdirSync(directory, { recursive: true });
  }
  // Under the isolated home, where the product keeps it, so the repair page shows it as `~/…`.
  const databasePath = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (options.withDatabase) new WorkIntelligenceStore(databasePath).close();
  const port = await freePort();
  const runtimeRoot = runtimeRootFromEnvironment();
  writeFileSync(
    join(dataDirectory, "desktop-settings.json"),
    `${JSON.stringify(
      {
        configVersion: 1,
        installId: "synthetic-install-id",
        desired: {
          databasePath,
          port,
          launchAtLogin: false,
          backupDirectory: join(home, ".work-intelligence", "backups"),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, home, dataDirectory, databasePath, port, emptyBin, runtimeRoot };
}

export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The environment the app runs in: an isolated home, the test switches, and a PATH without any Node. */
export function appEnvironment(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith("WORK_INTELLIGENCE_") || name === "ELECTRON_RUN_AS_NODE" || name === "NODE_OPTIONS") continue;
    base[name] = value;
  }
  const systemDirectory = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : sandbox.emptyBin;
  return {
    ...base,
    ...profileDirectories(sandbox.home),
    PATH: process.platform === "win32" ? systemDirectory : sandbox.emptyBin,
    WORK_INTELLIGENCE_DESKTOP_DATA_DIR: sandbox.dataDirectory,
    WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT: sandbox.runtimeRoot,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL: "1",
    ...extra,
  };
}

/**
 * Linux runs only as a regression check (V1 ships on Windows and macOS). There Chromium's OS sandbox needs either root-less
 * user namespaces, which Ubuntu 24.04's AppArmor policy blocks for an unpackaged binary, or a setuid `chrome-sandbox`,
 * which a downloaded test binary does not have; as root it refuses to start at all. So only the test's Linux launch
 * turns the OS sandbox off. The renderer settings under test (`sandbox`, `contextIsolation`, CSP) are unchanged, and
 * Windows and macOS keep the full OS sandbox.
 */
export function launchArguments(): string[] {
  return [mainEntry, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
}

const closedApplications = new WeakSet<ElectronApplication>();

export async function launchApp(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
  extraArguments: readonly string[] = [],
): Promise<ElectronApplication> {
  const launched = await _electron.launch({
    executablePath: electronBinary,
    args: [...launchArguments(), ...extraArguments],
    env: appEnvironment(sandbox, extra),
    timeout: 60_000,
  });
  launched.on("close", () => closedApplications.add(launched));
  return launched;
}

export interface ElectronExit {
  /** The Electron main process, so a test can look for anything it left behind. */
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last of what the process wrote to stderr, so a failed exit explains itself in the test report. */
  readonly stderr: string;
}

const EXIT_STDERR_LIMIT = 16 * 1024;

/**
 * Starts an Electron that is expected to end by itself (a second instance, a launch that cannot start) and resolves with
 * how it ended. It is killed and the promise rejects (with its stderr) if it is still running after `timeoutMs`.
 */
export function runToExit(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
  timeoutMs = 20_000,
  extraArguments: readonly string[] = [],
): Promise<ElectronExit> {
  const child: ChildProcess = spawn(electronBinary, [...launchArguments(), ...extraArguments], {
    env: appEnvironment(sandbox, extra),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-EXIT_STDERR_LIMIT);
  });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`Electron did not exit within ${timeoutMs} ms; stderr:\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    // `close`, not `exit`: stderr is fully read by then.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ pid: child.pid ?? 0, code, signal, stderr });
    });
  });
}

/**
 * Windows only: the processes still running that `pid` started (Windows keeps the parent id after the parent ends) or
 * whose command line names `marker` (the sandbox root), as "name pid" lines. Electron's helpers (GPU, network, the
 * Crashpad handler) are such children.
 */
export function windowsLeftovers(pid: number, marker: string): string[] {
  if (!Number.isInteger(pid) || pid <= 0 || marker.length === 0) throw new Error("a pid and a marker are required");
  const script = [
    `Get-CimInstance Win32_Process | Where-Object {`,
    `  $_.ProcessId -ne $PID -and ($_.ParentProcessId -eq ${pid} -or`,
    `  ($_.CommandLine -and $_.CommandLine.Contains($env:WI_SMOKE_MARKER)))`,
    `} | ForEach-Object { '{0} {1}' -f $_.Name, $_.ProcessId }`,
  ].join("\n");
  // The marker, a path, goes in through the environment, as the script itself goes in encoded: no command-line quoting.
  const output = execFileSync(windowsPowerShell(), powershellArguments(script), {
    encoding: "utf8",
    env: { ...process.env, WI_SMOKE_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function readSnapshot(app: ElectronApplication): Promise<MainSnapshot> {
  return app.evaluate(
    () =>
      (
        globalThis as unknown as { __workIntelligenceDesktopTest: { snapshot(): unknown } }
      ).__workIntelligenceDesktopTest.snapshot() as never,
  );
}

/** A NEEDS_REPAIR the App will not leave by itself (no retry, no reinstall pending), or undefined. */
export function settledRepairFailure(snapshot: MainSnapshot): string | undefined {
  const latest = snapshot.recentErrors.at(-1);
  return snapshot.owner === "NEEDS_REPAIR" && latest !== undefined && isSettledRepairFailure(latest)
    ? `the App settled in NEEDS_REPAIR with errors=${snapshot.recentErrors.join(",")}`
    : undefined;
}

/**
 * Polls the hook until `done` holds, then returns that snapshot. With `failFast`, a state that can no longer reach `done`
 * (see {@link settledRepairFailure}) fails at once with the real error codes instead of waiting for the timeout.
 */
export async function waitForSnapshot(
  app: ElectronApplication,
  done: (snapshot: MainSnapshot) => boolean,
  timeoutMs = 45_000,
  failFast: (snapshot: MainSnapshot) => string | undefined = () => undefined,
): Promise<MainSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: MainSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await readSnapshot(app);
    if (done(last)) return last;
    const failure = failFast(last);
    if (failure !== undefined) throw new Error(failure);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `condition not met in ${timeoutMs} ms; last owner=${last?.owner} errors=${last?.recentErrors.join(",")}`,
  );
}

/** Waits until the App is MANAGED with a running backend; a deterministic NEEDS_REPAIR fails at once. */
export function waitForManagedSnapshot(app: ElectronApplication, timeoutMs = 45_000): Promise<MainSnapshot> {
  return waitForSnapshot(
    app,
    (state) => state.owner === "MANAGED" && state.backend !== null,
    timeoutMs,
    settledRepairFailure,
  );
}

/** The health endpoint must prove the answering process is the child this App started (HMAC of a fresh challenge). */
export async function healthProofIsValid(port: number, runId: string): Promise<boolean> {
  const challenge = `smoke-challenge-${Date.now()}-abcdefghij`;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { [INSTANCE_CHALLENGE_HEADER]: challenge },
  });
  return (
    response.status === 200 && response.headers.get(INSTANCE_PROOF_HEADER) === computeInstanceProof(runId, challenge)
  );
}

/** Keeps the main log with the test result so a CI failure can be read afterwards. */
export function attachLog(testInfo: TestInfo, sandbox: Sandbox): void {
  try {
    const text = readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
    writeFileSync(testInfo.outputPath("desktop-main.log"), text);
  } catch {
    // No log was written: nothing to attach.
  }
}

export function readMainLog(sandbox: Sandbox): string {
  try {
    return readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
  } catch {
    return "";
  }
}

/** Quits the way a user does (the confirmation is auto-answered), so the backend is stopped and not left behind. */
export async function closeQuietly(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  if (closedApplications.has(app)) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;
  await app.close().catch(() => undefined);
}
