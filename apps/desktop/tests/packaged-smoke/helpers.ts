import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { isSettledRepairFailure } from "@work-intelligence/desktop-core";
import { windowsPowerShell } from "@work-intelligence/shared/windows-system-tool";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  allowBuiltinUsersToWrite,
  securePrivateDirectory,
} from "../../../../scripts/desktop-runtime-spike/secure-directory.mjs";
import { freePort, portIsFree, processIsAlive, profileDirectories } from "../support/process-tools.js";

/**
 * Black-box helpers for the packaged App: it is only spawned, and read through its log, its HTTP port, the process list
 * and files. The App has no test hook and no test environment switch; `--user-data-dir` isolates its userData and its
 * single-instance lock, and the log lines in apps/desktop/src/main/log.ts are the contract. The environment variables
 * read here belong to the tests and the runner script, never to the App.
 */

export { portIsFree, processIsAlive, profileDirectories };

/** `productName` of the App: Electron's default userData folder is `<per-user app data>/<productName>`. */
export const PRODUCT_NAME = "Work Intelligence";

const POLL_MS = 10;
const EXIT_STDERR_LIMIT = 16 * 1024;

export interface PackagedSandbox {
  readonly root: string;
  readonly home: string;
  readonly userData: string;
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly port: number;
  readonly emptyBin: string;
  readonly logFile: string;
}

export interface RunningApp {
  /** The main process. */
  readonly pid: number;
  readonly exited: Promise<AppExit>;
  hasExited(): boolean;
  kill(): void;
}

export interface AppExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface BackendInfo {
  readonly pid: number;
  readonly port: number;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly commandLine: string;
  /** Known on Windows only; use {@link executablePathOf} elsewhere. */
  readonly executable: string | undefined;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run \`pnpm test:desktop-packaged\`.`);
  return value;
}

/** The App under test: the installed exe on Windows, the .app's executable on macOS, the unpacked binary on Linux. */
export function packagedExecutable(): string {
  return requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_EXE");
}

/** The folder a user sees as "the program": the install directory, the `.app`, or the unpacked directory. */
export function programDirectory(executable: string): string {
  return process.platform === "darwin" ? dirname(dirname(dirname(executable))) : dirname(executable);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Calls `read` every few milliseconds until it returns a defined value; a timeout names what never happened. */
export async function pollUntil<T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

/**
 * Synthetic data only. The folder name has spaces and Chinese characters, as real profile paths do; the database is made
 * by the real store inside an isolated home, and the settings file is the one the App itself writes.
 */
export async function createSandbox(options: {
  withDatabase: boolean;
  /** Windows only: leave `userData` writable for BUILTIN\Users, so the App must refuse the runtime it puts under it. */
  unsafeUserData?: boolean;
}): Promise<PackagedSandbox> {
  // `.native` expands Windows 8.3 names and macOS `/var`, so every path matches what the App and its child report.
  const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "wi 打包 smoke ")));
  const home = join(root, "home 用户");
  const userData = join(root, "user data 数据");
  const emptyBin = join(root, "empty-bin");
  for (const directory of [...Object.values(profileDirectories(home)), userData, emptyBin]) {
    mkdirSync(directory, { recursive: true });
  }
  // The runtime root is `<userData>/runtime`. A Windows runner's temp folder grants BUILTIN\Users write access, which the
  // App's ACL check refuses, so userData gets the ACL of the real per-user root: inherited by the folders the App adds.
  if (options.unsafeUserData) allowBuiltinUsersToWrite(userData);
  else securePrivateDirectory(userData);
  const databasePath = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
  const backupDirectory = join(home, ".work-intelligence", "backups");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (options.withDatabase) new WorkIntelligenceStore(databasePath).close();
  const port = await freePort();
  writeFileSync(
    join(userData, "desktop-settings.json"),
    `${JSON.stringify(
      {
        configVersion: 1,
        installId: "synthetic-install-id",
        desired: { databasePath, port, launchAtLogin: false, backupDirectory },
      },
      null,
      2,
    )}\n`,
  );
  return {
    root,
    home,
    userData,
    databasePath,
    backupDirectory,
    port,
    emptyBin,
    logFile: join(userData, "logs", "desktop-main.log"),
  };
}

export function removeSandbox(sandbox: PackagedSandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** An isolated home and a PATH without Node (System32 only on Windows, an empty folder elsewhere). */
export function appEnvironment(
  sandbox: PackagedSandbox,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
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
    ...overrides,
  };
}

/** Linux is a local regression check only: Chromium's OS sandbox cannot start for an unpackaged root-owned binary. */
export function launchArguments(sandbox: PackagedSandbox, extra: readonly string[] = []): string[] {
  return [`--user-data-dir=${sandbox.userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extra];
}

/** How a launch differs from the default: `defaultUserData` omits `--user-data-dir` (see the installer upgrade test). */
export interface StartOptions {
  readonly defaultUserData?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Starts the App and returns at once; `exited` settles when the process ends (`close`, so stderr is complete). */
export function startApp(
  sandbox: PackagedSandbox,
  extra: readonly string[] = [],
  options: StartOptions = {},
): RunningApp {
  const args = options.defaultUserData ? extra : launchArguments(sandbox, extra);
  const child: ChildProcess = spawn(packagedExecutable(), args, {
    env: appEnvironment(sandbox, options.environment),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let done = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-EXIT_STDERR_LIMIT);
  });
  const exited = new Promise<AppExit>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      done = true;
      resolveExit({ code, signal, stderr });
    });
  });
  // A rejected `exited` nobody awaits must not crash the runner.
  exited.catch(() => undefined);
  return {
    pid: child.pid ?? 0,
    exited,
    hasExited: () => done,
    kill: () => {
      if (!done) child.kill("SIGKILL");
    },
  };
}

/** Starts the App and waits for it to end by itself (a second launch, a refused switch, `--quit`). */
export async function runToExit(
  sandbox: PackagedSandbox,
  extra: readonly string[] = [],
  timeoutMs = 30_000,
): Promise<AppExit> {
  const app = startApp(sandbox, extra);
  const timer = setTimeout(() => app.kill(), timeoutMs);
  try {
    const exit = await app.exited;
    if (exit.signal === "SIGKILL")
      throw new Error(`the App did not exit within ${timeoutMs} ms; stderr:\n${exit.stderr}`);
    return exit;
  } finally {
    clearTimeout(timer);
  }
}

export function readLog(sandbox: PackagedSandbox): string {
  try {
    return readFileSync(sandbox.logFile, "utf8");
  } catch {
    return "";
  }
}

export function logLines(sandbox: PackagedSandbox, pattern: RegExp): string[] {
  return readLog(sandbox)
    .split("\n")
    .filter((line) => pattern.test(line));
}

export function waitForLog(sandbox: PackagedSandbox, pattern: RegExp, timeoutMs = 60_000): Promise<string> {
  return pollUntil(() => logLines(sandbox, pattern).at(-1), `the log line ${pattern}`, timeoutMs);
}

/** The newest `backend started` line of the log, or undefined. */
export function backendFromLog(sandbox: PackagedSandbox): BackendInfo | undefined {
  const line = logLines(sandbox, /\[shell\] backend started pid=\d+ port=\d+/).at(-1);
  const match = line ? /pid=(\d+) port=(\d+)/.exec(line) : null;
  return match ? { pid: Number(match[1]), port: Number(match[2]) } : undefined;
}

export async function healthStatus(port: number): Promise<number | undefined> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
  } catch {
    return undefined;
  }
}

/**
 * Waits until this launch is MANAGED with a backend answering `GET /api/health` 200. `since` is the log length before the
 * launch, so a line of an earlier launch in the same sandbox does not count.
 */
export async function waitForManaged(sandbox: PackagedSandbox, since = 0): Promise<BackendInfo> {
  return pollUntil(async () => {
    const log = readLog(sandbox).slice(since);
    // A refusal the App will not retry or reinstall away: fail now with the real code, not after the timeout.
    for (const [, code] of log.matchAll(/\[shell\] no automatic retry after (\w+) \(deterministic\)/g)) {
      if (code && isSettledRepairFailure(code)) throw new Error(`the App settled in NEEDS_REPAIR with ${code}`);
    }
    if (!/\[shell\] owner MANAGED/.test(log)) return undefined;
    const match = /\[shell\] backend started pid=(\d+) port=(\d+)/.exec(log);
    if (!match) return undefined;
    const backend = { pid: Number(match[1]), port: Number(match[2]) };
    return (await healthStatus(backend.port)) === 200 ? backend : undefined;
  }, "MANAGED with a healthy backend");
}

/** `<exe> --quit`: asks the running instance to quit (exit 0), or exits 0 at once when none runs. */
export function quitCommand(sandbox: PackagedSandbox): Promise<AppExit> {
  return runToExit(sandbox, ["--quit"], 30_000);
}

/** Quits the way an installer does and waits for the main process to end; kills it only if that fails. */
export async function stopApp(sandbox: PackagedSandbox, app: RunningApp | undefined): Promise<void> {
  if (!app) return;
  if (!app.hasExited()) {
    await quitCommand(sandbox).catch(() => undefined);
    await Promise.race([app.exited.catch(() => undefined), sleep(30_000)]);
    app.kill();
  }
  await app.exited.catch(() => undefined);
}

function windowsProcesses(): ProcessInfo[] {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  // -EncodedCommand passes the script without any command-line quoting.
  const output = execFileSync(
    windowsPowerShell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    ProcessId: number;
    ParentProcessId: number;
    WorkingSetSize: number | null;
    ExecutablePath: string | null;
    CommandLine: string | null;
  }>;
  return rows.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    rssBytes: row.WorkingSetSize ?? 0,
    commandLine: row.CommandLine ?? "",
    executable: row.ExecutablePath ?? undefined,
  }));
}

function posixProcesses(): ProcessInfo[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      commandLine: match[4] ?? "",
      executable: undefined,
    });
  }
  return processes;
}

/** Every process of the machine (Windows: CIM `Win32_Process`; macOS and Linux: `ps`). */
export function listProcesses(): ProcessInfo[] {
  return process.platform === "win32" ? windowsProcesses() : posixProcesses();
}

/** The executable a process runs: CIM `ExecutablePath` on Windows, `/proc/<pid>/exe` on Linux, `ps -o comm=` on macOS. */
export function executablePathOf(pid: number, processes: readonly ProcessInfo[] = []): string | undefined {
  try {
    if (process.platform === "win32") return processes.find((candidate) => candidate.pid === pid)?.executable;
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The process `rootPid` and all its descendants. */
export function processTree(rootPid: number, processes: readonly ProcessInfo[] = listProcesses()): ProcessInfo[] {
  const wanted = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of processes) {
      if (!wanted.has(candidate.pid) && wanted.has(candidate.ppid)) {
        wanted.add(candidate.pid);
        grew = true;
      }
    }
  }
  return processes.filter((candidate) => wanted.has(candidate.pid));
}

/** Whether `candidate` lies under `directory` (case-insensitive on Windows). */
export function isInside(directory: string, candidate: string): boolean {
  const separator = process.platform === "win32" ? "\\" : "/";
  const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

/**
 * Processes still running that belong to a test, as "pid command" lines: their command line names one of `markers` (the
 * sandbox root, which Chromium's `--user-data-dir` and the backend's runtime path contain; the program directory, which
 * every Electron helper's path starts with) or, on Windows, their executable lies under it.
 */
export function leftoverProcesses(markers: readonly string[]): string[] {
  return listProcesses()
    .filter(
      (candidate) =>
        candidate.pid !== process.pid &&
        markers.some(
          (marker) =>
            candidate.commandLine.includes(marker) ||
            (candidate.executable !== undefined && candidate.executable.toLowerCase().startsWith(marker.toLowerCase())),
        ),
    )
    .map((candidate) => `${candidate.pid} ${candidate.commandLine.slice(0, 160)}`);
}

/**
 * Where Electron would put userData without `--user-data-dir`, for the product name and the package name, under the
 * profile `environment` describes (the real one of the developer, or a sandbox home). The tests assert none of these is
 * created by a run.
 */
export function defaultUserDataDirectories(environment: Readonly<Record<string, string | undefined>>): string[] {
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const base =
    process.platform === "win32"
      ? (environment.APPDATA ?? join(home, "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (environment.XDG_CONFIG_HOME ?? join(home, ".config"));
  return [PRODUCT_NAME, "work-intelligence-desktop"].map((name) => join(base, name));
}

/**
 * The fixed launcher root a packaged App uses when it is NOT given `--user-data-dir` (Windows
 * `%LOCALAPPDATA%\WorkIntelligence\runtime`, macOS `~/Library/Application Support/WorkIntelligence/runtime`); empty on
 * Linux, which has none. The tests always pass `--user-data-dir`, so none of these may be created by a run.
 */
export function defaultRuntimeRoots(environment: Readonly<Record<string, string | undefined>>): string[] {
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  if (process.platform === "win32") {
    return [join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "WorkIntelligence", "runtime")];
  }
  if (process.platform === "darwin")
    return [join(home, "Library", "Application Support", "WorkIntelligence", "runtime")];
  return [];
}
