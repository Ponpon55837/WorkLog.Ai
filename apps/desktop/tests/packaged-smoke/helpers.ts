import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
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
  inFirefoxBackgroundTask,
  isExternalBrowser,
  parseElapsedSeconds,
  startedSince,
  survivingTree,
  type BrowserSnapshot,
} from "./browser-process.js";
import { isStrictPackagedRun, STRICT_OPT_IN_VARIABLE } from "./installer-profile.js";

export { portIsFree, processIsAlive, profileDirectories };

export const PRODUCT_NAME = "Work Intelligence";

const POLL_MS = 10;
const EXIT_STDERR_LIMIT = 16 * 1024;
const DIAGNOSTIC_TAIL_CHARS = 2_000;
const HOLDER_GRACE_MS = 5_000;
const HOLDER_TERMINATE_MS = 5_000;
const HOLDER_COMMAND_LIMIT = 160;
const BROWSER_TERMINATE_MS = 5_000;
const BROWSER_TREE_EXIT_MS = 10_000;
export type BrowserBaseline = BrowserSnapshot;

const launchedPids = new Map<string, number[]>();
const knownProcesses = new Map<string, ProcessInfo[]>();
let browsersBeforeTests: BrowserBaseline | undefined;
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
  readonly pid: number;
  readonly exited: Promise<AppExit>;
  hasExited(): boolean;
  exit(): AppExit | undefined;
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
  readonly executable: string | undefined;
  readonly startedAt?: number | undefined;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run \`pnpm test:desktop-packaged\`.`);
  return value;
}

export function packagedExecutable(): string {
  return requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_EXE");
}

export function programDirectory(executable: string): string {
  return process.platform === "darwin" ? dirname(dirname(dirname(executable))) : dirname(executable);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

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

export async function createSandbox(options: {
  withDatabase: boolean;
  unsafeUserData?: boolean;
}): Promise<PackagedSandbox> {
  // `.native` expands Windows 8.3 names and macOS `/var`, so every path matches what the App reports.
  const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "wi 打包 smoke ")));
  browsersBeforeTests ??= browserBaseline();
  const home = join(root, "home 用户");
  const userData = join(root, "user data 数据");
  const emptyBin = join(root, "empty-bin");
  for (const directory of [...Object.values(profileDirectories(home)), userData, emptyBin]) {
    mkdirSync(directory, { recursive: true });
  }
  // A Windows runner's temp folder grants BUILTIN\Users write access, which the App's ACL check refuses.
  if (options.unsafeUserData) allowBuiltinUsersToWrite(userData);
  else securePrivateDirectory(userData);
  const databasePath = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
  const backupDirectory = join(home, ".work-intelligence", "backups");
  // A launch without `--user-data-dir` installs its runtime under this home's %LOCALAPPDATA%.
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

function keepSandboxLogs(sandbox: PackagedSandbox): void {
  const target = process.env.WORK_INTELLIGENCE_PACKAGED_LOG_DIR;
  const logs = dirname(sandbox.logFile);
  if (!target || !existsSync(logs)) return;
  try {
    cpSync(logs, join(target, basename(sandbox.root)), { recursive: true, force: true });
  } catch {
    // Evidence only: a log that cannot be copied never fails the test.
  }
}

export async function removeSandbox(sandbox: PackagedSandbox): Promise<void> {
  keepSandboxLogs(sandbox);
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
  if (survivors.length > 0) {
    throw new Error(
      `processes of a browser this test started were still running ${BROWSER_TREE_EXIT_MS / 1000} s after it was ended:\n${survivors.join("\n")}`,
    );
  }
  const opened = browserOpeningLaunches.delete(sandbox.root);
  if (!opened && browsers.length > 0) {
    throw new Error(`a launch that may not open a browser started one:\n${browsers.join("\n")}`);
  }
}

export function browserProcesses(
  sandboxRoot?: string,
  dashboardPort?: number,
  processes: readonly ProcessInfo[] = listProcesses(),
): ProcessInfo[] {
  return processes.filter(
    (candidate) =>
      candidate.pid !== process.pid &&
      isExternalBrowser(candidate, dashboardPort) &&
      !inFirefoxBackgroundTask(candidate, processes, dashboardPort) &&
      !(sandboxRoot !== undefined && candidate.commandLine.includes(sandboxRoot)),
  );
}

export function browserBaseline(sandboxRoot?: string): BrowserBaseline {
  const takenAt = Date.now();
  return { takenAt, processes: browserProcesses(sandboxRoot).map(({ pid, commandLine }) => ({ pid, commandLine })) };
}

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
  // Taken before the kill: a child (Firefox's `-contentproc`) may outlive its main process.
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
    // Still listed after the grace period: reported below as survivors.
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
        terminateProcesses(last.filter((member) => !signalled.has(member.pid)));
        for (const member of last) signalled.add(member.pid);
        return undefined;
      },
      "the browser process tree ended",
      BROWSER_TREE_EXIT_MS,
    );
    last = [];
  } catch {
    // Reported through `survivors`: the test that ended the browsers fails.
  }
  const snapshot = last.length > 0 ? listProcesses() : [];
  return {
    browsers: [...found.values()],
    survivors: last.map((member) => describeProcess(member, snapshot)),
  };
}

// Once a launch's main process ends its children are orphans, so the tree is remembered while it is alive.
function rememberTree(sandbox: PackagedSandbox, pid: number): void {
  const tree = processTree(pid);
  const known = knownProcesses.get(sandbox.root) ?? [];
  const seen = new Set(known.map((candidate) => candidate.pid));
  knownProcesses.set(sandbox.root, [...known, ...tree.filter((candidate) => !seen.has(candidate.pid))]);
}

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

function describeProcesses(candidates: readonly ProcessInfo[]): string[] {
  if (candidates.length === 0) return [];
  const processes = listProcesses();
  return candidates.map((candidate) => describeProcess(candidate, processes));
}

function describeProcess(candidate: ProcessInfo, processes: readonly ProcessInfo[] = listProcesses()): string {
  const parent = processes.find((member) => member.pid === candidate.ppid);
  return describeProcessLine(
    candidate,
    {
      alive: parent !== undefined,
      executable: parent ? executablePathOf(parent.pid, processes) : undefined,
      commandLine: parent?.commandLine,
    },
    HOLDER_COMMAND_LIMIT,
  );
}

// Everything older than the run (the CI runner, the developer's programs) is never ended by a test.
const RUN_STARTED_AT = Number(process.env.WORK_INTELLIGENCE_PACKAGED_RUN_STARTED_AT) || Date.now();

// Windows reuses pids and keeps a dead parent's pid as `ppid`, so a walked tree can reach the runner's processes;
// `taskkill /T` on one of them would end the CI job with no log.
function protectedProcesses(processes: readonly ProcessInfo[]): Set<number> {
  const kept = new Set<number>([0, 4, process.pid]);
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  let current = byPid.get(process.pid);
  while (current && !kept.has(current.ppid)) {
    kept.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  for (const candidate of processes) {
    if (candidate.startedAt !== undefined && candidate.startedAt < RUN_STARTED_AT) kept.add(candidate.pid);
  }
  return kept;
}

function terminateProcesses(candidates: readonly ProcessInfo[]): void {
  if (candidates.length === 0) return;
  const kept = protectedProcesses(listProcesses());
  const targets = candidates.filter((candidate) => !kept.has(candidate.pid));
  for (const skipped of candidates.filter((candidate) => kept.has(candidate.pid))) {
    console.warn(`[packaged-smoke] not ending protected pid ${skipped.pid}: ${skipped.commandLine.slice(0, 200)}`);
  }
  for (const target of targets) {
    console.warn(
      `[packaged-smoke] ending pid ${target.pid} (ppid ${target.ppid}): ${target.commandLine.slice(0, 200)}`,
    );
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
      // Already gone or not ours to end: the next scan tells.
    }
  }
}

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

// Linux is a local regression check only: Chromium's OS sandbox cannot start for an unpackaged root-owned binary.
export function launchArguments(sandbox: PackagedSandbox, extra: readonly string[] = []): string[] {
  return [`--user-data-dir=${sandbox.userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extra];
}

export interface StartOptions {
  readonly defaultUserData?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly opensDashboard?: boolean;
}

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
  // A failed spawn has no pid, and pid 0's "tree" is every process on Windows.
  if (child.pid !== undefined) launchedPids.set(sandbox.root, [...(launchedPids.get(sandbox.root) ?? []), child.pid]);
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

export async function waitForManaged(sandbox: PackagedSandbox, since = 0): Promise<BackendInfo> {
  return pollUntil(async () => {
    const log = readLog(sandbox).slice(since);
    for (const [, code] of log.matchAll(/\[shell\] no automatic retry after (\w+) \(deterministic\)/g)) {
      if (code && isSettledRepairFailure(code)) throw new Error(`the App settled in NEEDS_REPAIR with ${code}`);
    }
    if (!/\[shell\] owner MANAGED/.test(log)) return undefined;
    const match = /\[shell\] backend started pid=(\d+) port=(\d+)/.exec(log);
    if (!match) return undefined;
    const backend = { pid: Number(match[1]), port: Number(match[2]) };
    return (await healthStatus(backend.port)) === 200 ? backend : undefined;
  }, "MANAGED with a healthy backend").catch((error: unknown) => {
    const tail = readLog(sandbox).slice(since).split("\n").slice(-12).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; log tail:\n${tail}`);
  });
}

export function quitCommand(sandbox: PackagedSandbox): Promise<AppExit> {
  return runToExit(sandbox, ["--quit"], 30_000, { interactive: true });
}

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

export function listProcesses(): ProcessInfo[] {
  return process.platform === "win32" ? windowsProcesses() : posixProcesses();
}

export function executablePathOf(pid: number, processes: readonly ProcessInfo[] = []): string | undefined {
  try {
    if (process.platform === "win32") return processes.find((candidate) => candidate.pid === pid)?.executable;
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function processTree(rootPid: number, processes: readonly ProcessInfo[] = listProcesses()): ProcessInfo[] {
  return descendantsOf(processes, [rootPid]);
}

// `realpathSync.native` without the `\\?\` (or `\\?\UNC\`) prefix Windows may add.
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

export function isInside(directory: string, candidate: string): boolean {
  const separator = process.platform === "win32" ? "\\" : "/";
  const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

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

export function defaultRuntimeRoots(environment: Readonly<Record<string, string | undefined>>): string[] {
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  if (process.platform === "win32") {
    return [join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "WorkIntelligence", "runtime")];
  }
  if (process.platform === "darwin")
    return [join(home, "Library", "Application Support", "WorkIntelligence", "runtime")];
  return [];
}

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
