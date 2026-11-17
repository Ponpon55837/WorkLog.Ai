import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_FLAG, isSettledRepairFailure } from "@work-intelligence/desktop-core";
import { windowsPowerShell, windowsSystemTool } from "@work-intelligence/shared/windows-system-tool";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  allowBuiltinUsersToWrite,
  securePrivateDirectory,
} from "../../../../scripts/desktop-runtime-spike/secure-directory.mjs";
import {
  freePort,
  portIsFree,
  powershellArguments,
  processIsAlive,
  profileDirectories,
} from "../support/process-tools.js";
import {
  descendantsOf,
  describeProcessLine,
  isExternalBrowser,
  parseElapsedSeconds,
  startedSince,
  survivingTree,
  type BrowserSnapshot,
} from "./browser-process.js";
import { isStrictPackagedRun, STRICT_OPT_IN_VARIABLE } from "./installer-profile.js";

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
/** How much of a launch's stdout, stderr and log a failure message quotes. */
const DIAGNOSTIC_TAIL_CHARS = 2_000;
/** How long processes that hold a sandbox may exit by themselves before they are terminated. */
const HOLDER_GRACE_MS = 5_000;
const HOLDER_TERMINATE_MS = 5_000;
const HOLDER_COMMAND_LIMIT = 160;
const BROWSER_TERMINATE_MS = 5_000;
/** How long the whole tree of an ended browser (content processes included) may take to be gone. */
const BROWSER_TREE_EXIT_MS = 10_000;
/**
 * What was running before a test: when the scan was taken (a process created earlier is never blamed on the test), and
 * pid plus command line (a pid can be reused) for platforms that report no creation time.
 */
export type BrowserBaseline = BrowserSnapshot;

/** The App's main pid of every launch, per sandbox root, and the processes seen below them (see `removeSandbox`). */
const launchedPids = new Map<string, number[]>();
const knownProcesses = new Map<string, ProcessInfo[]>();
/**
 * The browsers running before the first sandbox of this worker: every later browser is ended by the `removeSandbox` of the
 * test that started it, so one scan serves every test (a process scan costs a CIM query on Windows).
 */
let browsersBeforeTests: BrowserBaseline | undefined;
/** Sandbox roots with a launch that may have opened a browser (interactive, not `--quit`). */
const browserOpeningLaunches = new Set<string>();

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
  /** The exit once it happened, for a failure message; undefined while the process runs. */
  exit(): AppExit | undefined;
  /** The ends of what the process wrote so far. */
  output(): { readonly stdout: string; readonly stderr: string };
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
  /** When the process was created, in epoch milliseconds (CIM `CreationDate`; `ps` elapsed time, to the second); undefined if unknown. */
  readonly startedAt?: number | undefined;
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
  browsersBeforeTests ??= browserBaseline();
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
  // A launch without `--user-data-dir` (the installer test) installs its runtime under `%LOCALAPPDATA%` of this home.
  securePrivateDirectory(profileDirectories(home).LOCALAPPDATA ?? home);
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

/**
 * Removes the sandbox. Anything still holding it blocks the removal on Windows (EPERM), so first every process that names
 * the sandbox root in its command line or lives under it, or that descends from a launch of this sandbox (the App's own
 * helpers, or an external browser the OS started for the Dashboard, which inherits the sandbox profile), gets a few
 * seconds to exit by itself and is then terminated. If the removal still fails, the error lists who holds the sandbox.
 */
export async function removeSandbox(sandbox: PackagedSandbox): Promise<void> {
  const { browsers, survivors } = await settleBrowsersStartedSince(
    browsersBeforeTests ?? { takenAt: 0, processes: [] },
    sandbox.root,
    sandbox.port,
  );
  try {
    await pollUntil(
      () => (sandboxHolders(sandbox).length === 0 ? true : undefined),
      "the sandbox released",
      HOLDER_GRACE_MS,
    );
  } catch {
    terminateProcesses(sandboxHolders(sandbox));
    await pollUntil(
      () => (sandboxHolders(sandbox).length === 0 ? true : undefined),
      "the sandbox processes ended",
      HOLDER_TERMINATE_MS,
    ).catch(() => undefined);
  }
  try {
    rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    const holders = describeProcesses(sandboxHolders(sandbox));
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${sandbox.root} could not be removed: ${cause}\n${
        holders.length > 0 ? `still holding it:\n${holders.join("\n")}` : "no process was found holding it"
      }`,
      { cause: error },
    );
  } finally {
    launchedPids.delete(sandbox.root);
    knownProcesses.delete(sandbox.root);
  }
  // A process of an ended browser that outlived it fails this test, the one that caused it, not a later one.
  if (survivors.length > 0) {
    throw new Error(
      `processes of a browser this test started were still running ${BROWSER_TREE_EXIT_MS / 1000} s after it was ended:\n${survivors.join("\n")}`,
    );
  }
  // A background launch (and `--quit`) must open no browser: the list names what appeared (ended on a strict run).
  const opened = browserOpeningLaunches.delete(sandbox.root);
  if (!opened && browsers.length > 0) {
    throw new Error(`a launch that may not open a browser started one:\n${browsers.join("\n")}`);
  }
}

/** The browsers running now, outside the sandbox (the App's own helpers name its root on their command line). */
export function browserProcesses(
  sandboxRoot?: string,
  dashboardPort?: number,
  processes: readonly ProcessInfo[] = listProcesses(),
): ProcessInfo[] {
  return processes.filter(
    (candidate) =>
      candidate.pid !== process.pid &&
      isExternalBrowser(candidate, dashboardPort) &&
      !(sandboxRoot !== undefined && candidate.commandLine.includes(sandboxRoot)),
  );
}

/** The browsers running now, to be told apart from the ones a test starts. */
export function browserBaseline(sandboxRoot?: string): BrowserBaseline {
  const takenAt = Date.now();
  return { takenAt, processes: browserProcesses(sandboxRoot).map(({ pid, commandLine }) => ({ pid, commandLine })) };
}

/**
 * The browsers that appeared after `baseline` (not in it by pid and command line, and, where the platform reports it, not
 * created before it): an external browser the OS started for the Dashboard is outside the App's process tree and carries
 * no sandbox path, so `sandboxHolders` cannot find it. On a strict run (CI, or the opt-in; see `isStrictPackagedRun`) they
 * are ended, and then the whole process tree of each (taken from the scan before the kill, plus any later child of it) is
 * waited for: a child (Firefox's `-contentproc`) may outlive its main process, and must not be found, and blamed, by the
 * next test. `survivors` describes what still ran after `BROWSER_TREE_EXIT_MS`. Elsewhere one of them may be a browser the
 * developer opened during the test, so they are only listed in a warning and added to the baseline (each is reported once).
 * `browsers` describes each browser found.
 */
export async function settleBrowsersStartedSince(
  baseline: BrowserBaseline,
  sandboxRoot?: string,
  dashboardPort?: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ browsers: string[]; survivors: string[] }> {
  const found = new Map<number, string>();
  const started = (processes: readonly ProcessInfo[]) =>
    startedSince(browserProcesses(sandboxRoot, dashboardPort, processes), baseline);
  if (!isStrictPackagedRun(environment)) {
    const processes = listProcesses();
    const targets = started(processes);
    if (targets.length === 0) return { browsers: [], survivors: [] };
    const descriptions = targets.map((target) => describeProcess(target, processes));
    console.warn(
      `browsers appeared during the test and are left running (they end only with CI=true or ${STRICT_OPT_IN_VARIABLE}=1):\n${descriptions.join("\n")}`,
    );
    browsersBeforeTests = {
      takenAt: baseline.takenAt,
      processes: [...baseline.processes, ...targets.map(({ pid, commandLine }) => ({ pid, commandLine }))],
    };
    return { browsers: descriptions, survivors: [] };
  }
  // The tree of every browser ended, as it was just before: pid to process.
  const tree = new Map<number, ProcessInfo>();
  try {
    await pollUntil(
      () => {
        const processes = listProcesses();
        const targets = started(processes);
        if (targets.length === 0) return true;
        for (const member of descendantsOf(
          processes,
          targets.map(({ pid }) => pid),
        )) {
          if (!tree.has(member.pid)) tree.set(member.pid, member);
        }
        for (const target of targets) found.set(target.pid, describeProcess(target, processes));
        terminateProcesses(targets);
        return undefined;
      },
      "the browsers ended",
      BROWSER_TERMINATE_MS,
    );
  } catch {
    // Still listed after the grace period: they are reported below and the tree wait names them as survivors.
  }
  if (tree.size === 0) return { browsers: [...found.values()], survivors: [] };
  const signalled = new Set<number>();
  let last: ProcessInfo[] = [];
  try {
    await pollUntil(
      () => {
        const processes = listProcesses();
        last = survivingTree(tree, processes).filter((member) => member.pid !== process.pid);
        if (last.length === 0) return true;
        // Members that are not browsers themselves (or whose main process is already gone) are ended once as well.
        terminateProcesses(last.filter((member) => !signalled.has(member.pid)));
        for (const member of last) signalled.add(member.pid);
        return undefined;
      },
      "the browser process tree ended",
      BROWSER_TREE_EXIT_MS,
    );
    last = [];
  } catch {
    // Reported through `survivors`: the test that ended the browsers fails, not a later one.
  }
  const snapshot = last.length > 0 ? listProcesses() : [];
  return {
    browsers: [...found.values()],
    survivors: last.map((member) => describeProcess(member, snapshot)),
  };
}

/** Remembers the process tree of a launch while it is alive: once its main process ends, its children are orphans. */
function rememberTree(sandbox: PackagedSandbox, pid: number): void {
  const tree = processTree(pid);
  const known = knownProcesses.get(sandbox.root) ?? [];
  const seen = new Set(known.map((candidate) => candidate.pid));
  knownProcesses.set(sandbox.root, [...known, ...tree.filter((candidate) => !seen.has(candidate.pid))]);
}

/**
 * The live processes that may hold the sandbox: the command line or the executable references its root, or it is (still,
 * same pid and command line) a process remembered from a launch's tree.
 */
function sandboxHolders(sandbox: PackagedSandbox): ProcessInfo[] {
  const processes = listProcesses();
  const remembered = knownProcesses.get(sandbox.root) ?? [];
  const live = new Set(
    (launchedPids.get(sandbox.root) ?? []).flatMap((pid) =>
      processTree(pid, processes).map((candidate) => candidate.pid),
    ),
  );
  return processes.filter(
    (candidate) =>
      candidate.pid !== process.pid &&
      (candidate.commandLine.includes(sandbox.root) ||
        (candidate.executable !== undefined && isInside(sandbox.root, candidate.executable)) ||
        live.has(candidate.pid) ||
        remembered.some((known) => known.pid === candidate.pid && known.commandLine === candidate.commandLine)),
  );
}

/** `describeProcess` for each of `candidates`, with one process scan for all. */
function describeProcesses(candidates: readonly ProcessInfo[]): string[] {
  if (candidates.length === 0) return [];
  const processes = listProcesses();
  return candidates.map((candidate) => describeProcess(candidate, processes));
}

/** One line per process: pid, parent pid and the parent's executable while it is alive, creation time, command. */
function describeProcess(candidate: ProcessInfo, processes: readonly ProcessInfo[] = listProcesses()): string {
  const parent = processes.find((member) => member.pid === candidate.ppid);
  return describeProcessLine(
    candidate,
    { alive: parent !== undefined, executable: parent ? executablePathOf(parent.pid, processes) : undefined },
    HOLDER_COMMAND_LIMIT,
  );
}

/** Windows: `taskkill /T /F` by absolute System32 path (the tree goes with the root); elsewhere SIGKILL. */
function terminateProcesses(targets: readonly ProcessInfo[]): void {
  for (const target of targets) {
    try {
      if (process.platform === "win32") {
        execFileSync(windowsSystemTool("taskkill.exe"), ["/PID", String(target.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(target.pid, "SIGKILL");
      }
    } catch {
      // Already gone (a child of an earlier target) or not ours to end: the next scan tells.
    }
  }
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
  /**
   * Interactive launches are for tests of what only an interactive launch does: it opens the Dashboard in the external
   * browser and shows the repair window. Every other launch is `--background` (the login item's mode: tray only, a
   * notification instead of a window, no browser), so the machine running the tests is left alone.
   */
  readonly interactive?: boolean;
  /**
   * The launch may make the App open the Dashboard although it is `--background`: a second launch hands over to the
   * running first instance, which opens it. Arguments are unchanged; only the "no browser appeared" check knows.
   */
  readonly opensDashboard?: boolean;
}

/** Starts the App and returns at once; `exited` settles when the process ends (`close`, so stderr is complete). */
export function startApp(
  sandbox: PackagedSandbox,
  extra: readonly string[] = [],
  options: StartOptions = {},
): RunningApp {
  const mode = options.interactive ? [] : [BACKGROUND_FLAG];
  const args = options.defaultUserData ? [...extra, ...mode] : launchArguments(sandbox, [...extra, ...mode]);
  const child: ChildProcess = spawn(packagedExecutable(), args, {
    env: appEnvironment(sandbox, options.environment),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  launchedPids.set(sandbox.root, [...(launchedPids.get(sandbox.root) ?? []), child.pid ?? 0]);
  // `--quit` is interactive only so that it is not `--background`; it opens nothing.
  if ((options.interactive && !extra.includes("--quit")) || options.opensDashboard) {
    browserOpeningLaunches.add(sandbox.root);
  }
  let stdout = "";
  let stderr = "";
  let ended: AppExit | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-EXIT_STDERR_LIMIT);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-EXIT_STDERR_LIMIT);
  });
  const exited = new Promise<AppExit>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      ended = { code, signal, stderr };
      resolveExit(ended);
    });
  });
  // A rejected `exited` nobody awaits must not crash the runner.
  exited.catch(() => undefined);
  return {
    pid: child.pid ?? 0,
    exited,
    hasExited: () => ended !== undefined,
    exit: () => ended,
    output: () => ({ stdout, stderr }),
    kill: () => {
      if (ended === undefined) child.kill("SIGKILL");
    },
  };
}

/** Starts the App and waits for it to end by itself (a second launch, a refused switch, `--quit`). */
export async function runToExit(
  sandbox: PackagedSandbox,
  extra: readonly string[] = [],
  timeoutMs = 30_000,
  options: StartOptions = {},
): Promise<AppExit> {
  const app = startApp(sandbox, extra, options);
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
  }, "MANAGED with a healthy backend").catch((error: unknown) => {
    // A timeout alone says nothing: the log tail shows which step the launch was in (runtime, owner, backend).
    const tail = readLog(sandbox).slice(since).split("\n").slice(-12).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; log tail:\n${tail}`);
  });
}

/** `<exe> --quit`: asks the running instance to quit (exit 0), or exits 0 at once when none runs. */
export function quitCommand(sandbox: PackagedSandbox): Promise<AppExit> {
  // Bare `--quit`, as the installer sends it: it opens nothing, so the launch mode does not matter.
  return runToExit(sandbox, ["--quit"], 30_000, { interactive: true });
}

/** Quits the way an installer does and waits for the main process to end; kills it only if that fails. */
export async function stopApp(sandbox: PackagedSandbox, app: RunningApp | undefined): Promise<void> {
  if (!app) return;
  if (!app.hasExited()) {
    rememberTree(sandbox, app.pid);
    await quitCommand(sandbox).catch(() => undefined);
    await Promise.race([app.exited.catch(() => undefined), sleep(30_000)]);
    app.kill();
  }
  await app.exited.catch(() => undefined);
}

function windowsProcesses(): ProcessInfo[] {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath,CommandLine,@{n='StartedAt';e={if($_.CreationDate){[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}else{$null}}} | ConvertTo-Json -Compress";
  const output = execFileSync(windowsPowerShell(), powershellArguments(script), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const parsed = JSON.parse(output) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    ProcessId: number;
    ParentProcessId: number;
    WorkingSetSize: number | null;
    ExecutablePath: string | null;
    CommandLine: string | null;
    StartedAt: number | null;
  }>;
  return rows.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    rssBytes: row.WorkingSetSize ?? 0,
    commandLine: row.CommandLine ?? "",
    executable: row.ExecutablePath ?? undefined,
    startedAt: row.StartedAt ?? undefined,
  }));
}

function posixProcesses(): ProcessInfo[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,etime=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const scannedAt = Date.now();
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const elapsed = parseElapsedSeconds(match[4] ?? "");
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      commandLine: match[5] ?? "",
      executable: undefined,
      startedAt: elapsed === undefined ? undefined : scannedAt - elapsed * 1000,
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

/**
 * `path` as the file system names it: `realpathSync.native` (long names instead of 8.3 ones, the real letter case, links
 * resolved) without the `\\?\` (or `\\?\UNC\`) prefix Windows may add; `path` itself when it cannot be resolved.
 */
export function resolvedPath(path: string): string {
  let resolved = path;
  try {
    resolved = realpathSync.native(path);
  } catch {
    // Gone or unreadable: compare it as given.
  }
  if (process.platform !== "win32" || !resolved.startsWith("\\\\?\\")) return resolved;
  return resolved.startsWith("\\\\?\\UNC\\") ? `\\\\${resolved.slice(8)}` : resolved.slice(4);
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

/**
 * What a failure message needs when a launch never got where it should: whether the process still runs or how it
 * ended, the ends of its stdout and stderr, every process of the packaged App (its executable or command line names the
 * program directory), and which of `logFiles` exist, with their last lines. A launch that wrote no log at all is then
 * told apart from one that wrote it elsewhere, exited at once (say, as a second instance) or hangs.
 */
export function describeLaunch(app: RunningApp, logFiles: readonly string[]): string {
  const ended = app.exit();
  const { stdout, stderr } = app.output();
  const program = programDirectory(packagedExecutable());
  const appProcesses = listProcesses().filter(
    (candidate) =>
      candidate.commandLine.toLowerCase().includes(program.toLowerCase()) ||
      (candidate.executable !== undefined && isInside(program, candidate.executable)),
  );
  const logs = [...new Set(logFiles)].map((file) => {
    try {
      const tail = readFileSync(file, "utf8").split("\n").slice(-6).join("\n");
      return `  ${file}:\n${tail}`;
    } catch {
      return `  ${file}: (none)`;
    }
  });
  return [
    ended
      ? `the App (pid ${app.pid}) exited with code ${String(ended.code)}, signal ${String(ended.signal)}`
      : `the App (pid ${app.pid}) is still running`,
    `stdout tail:\n${stdout.slice(-DIAGNOSTIC_TAIL_CHARS) || "(empty)"}`,
    `stderr tail:\n${stderr.slice(-DIAGNOSTIC_TAIL_CHARS) || "(empty)"}`,
    `App processes:\n${describeProcesses(appProcesses).join("\n") || "  (none)"}`,
    `log files:\n${logs.join("\n")}`,
  ].join("\n");
}
