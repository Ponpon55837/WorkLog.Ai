/**
 * Which processes the packaged smoke counts as an external browser (one the OS may start for `shell.openExternal`). No
 * Playwright import, so unit tests load it.
 */

/** The fields of a scanned process the classification reads. */
export interface BrowserCandidate {
  readonly commandLine: string;
  /** Known on Windows only; elsewhere the start of the command line names the executable. */
  readonly executable: string | undefined;
}

/**
 * Browsers the OS may start for `shell.openExternal`, matched against a process's executable (or the start of its command
 * line: a path whose last segment is the executable, then a space or the end): Safari, Chrome and Chromium (`Google
 * Chrome`, `chrome`, `google-chrome`, `chromium`), Edge (`msedge`) and Firefox, the `xdg-open` targets on Linux included.
 * Only the browsers' main executables: helpers such as macOS's `com.apple.WebKit.*` also serve other apps and end with
 * their browser. The App's own Chromium helpers are not browsers here: they carry the sandbox root in their command line.
 */
const BROWSER_COMMANDS =
  /(^|[\\/])(Safari|Google Chrome|google-chrome(-stable)?|chrome|chromium(-browser)?|msedge|firefox)(\.exe)?( |$)/i;
const FIREFOX_COMMAND = /(^|[\\/])firefox(\.exe)?( |$)/i;
const FIREFOX_BACKGROUND_TASK_TOKEN = "--backgroundtask";

/** A command line that names the Dashboard the App serves on `dashboardPort`. */
function namesDashboard(commandLine: string, dashboardPort: number | undefined): boolean {
  if (dashboardPort === undefined) return false;
  return [`127.0.0.1:${dashboardPort}`, `localhost:${dashboardPort}`].some((address) => commandLine.includes(address));
}

/**
 * Whether `candidate` is an external browser. One exception: Firefox in background-task mode (`firefox.exe
 * --backgroundtask …`) has no window and is not what `shell.openExternal` starts. On Windows the Task Scheduler runs the
 * "Firefox Default Browser Agent" this way (`--backgroundtask defaultagent do-task <id>`) whenever it is due, so it can
 * appear during any test on a machine with Firefox, CI runners included. It still counts when its command line names the
 * Dashboard (`dashboardPort`), since then the App may have started it.
 */
export function isExternalBrowser(candidate: BrowserCandidate, dashboardPort?: number): boolean {
  const command = candidate.executable ?? candidate.commandLine;
  if (!BROWSER_COMMANDS.test(command)) return false;
  return !isFirefoxBackgroundTask(candidate) || namesDashboard(candidate.commandLine, dashboardPort);
}

/** Whether `candidate` is Firefox in background-task mode (`firefox.exe --backgroundtask …`). */
function isFirefoxBackgroundTask(candidate: BrowserCandidate): boolean {
  return (
    FIREFOX_COMMAND.test(candidate.executable ?? candidate.commandLine) &&
    candidate.commandLine.split(/\s+/).includes(FIREFOX_BACKGROUND_TASK_TOKEN)
  );
}

/** Slack for creation times: `ps` reports whole seconds of elapsed time, so a start time is only that exact. */
const START_TOLERANCE_MS = 2_000;

/** The fields of a scanned process that the tree and the attribution logic read. */
export interface TreeProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly commandLine: string;
  /** Epoch milliseconds; undefined when the platform scan did not report it. */
  readonly startedAt?: number | undefined;
}

/** What was running when a test (or the worker's first test) began: told apart by creation time, else by pid and command. */
export interface BrowserSnapshot {
  readonly takenAt: number;
  readonly processes: ReadonlyArray<{ readonly pid: number; readonly commandLine: string }>;
}

/**
 * The processes of `snapshot` named in `rootPids` together with all their descendants (by parent pid). A root that is not in
 * the snapshot is not invented; its children still are found.
 */
export function descendantsOf<T extends { readonly pid: number; readonly ppid: number }>(
  snapshot: readonly T[],
  rootPids: Iterable<number>,
): T[] {
  const wanted = new Set(rootPids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of snapshot) {
      if (!wanted.has(candidate.pid) && wanted.has(candidate.ppid)) {
        wanted.add(candidate.pid);
        grew = true;
      }
    }
  }
  return snapshot.filter((candidate) => wanted.has(candidate.pid));
}

/**
 * Whether `candidate` was created clearly before `takenAt`, so the test that began at `takenAt` cannot have started it.
 * False when the creation time is unknown (the caller then falls back to pid plus command line).
 */
export function createdBefore(candidate: { readonly startedAt?: number | undefined }, takenAt: number): boolean {
  return candidate.startedAt !== undefined && candidate.startedAt + START_TOLERANCE_MS <= takenAt;
}

/** Whether `candidate` is one of the snapshot's processes: the same pid and command line. */
export function inSnapshot(candidate: TreeProcess, snapshot: BrowserSnapshot): boolean {
  return snapshot.processes.some((known) => known.pid === candidate.pid && known.commandLine === candidate.commandLine);
}

/** The candidates that appeared after `snapshot`: not created before it, and not in it by pid and command line. */
export function startedSince<T extends TreeProcess>(candidates: readonly T[], snapshot: BrowserSnapshot): T[] {
  return candidates.filter(
    (candidate) => !createdBefore(candidate, snapshot.takenAt) && !inSnapshot(candidate, snapshot),
  );
}

/** Whether `live` is still the process `known` was (a pid can be reused: compare creation times, else command lines). */
function sameProcess(known: TreeProcess, live: TreeProcess): boolean {
  if (known.pid !== live.pid) return false;
  if (known.startedAt !== undefined && live.startedAt !== undefined) {
    return Math.abs(known.startedAt - live.startedAt) <= START_TOLERANCE_MS;
  }
  return known.commandLine === live.commandLine;
}

/**
 * The members of a tree still alive in `live`. `tracked` holds the tree as it was before it was ended (the pids, so
 * orphans that no longer name a tracked parent are still found); every child of a tracked process that shows up later is
 * added to it, so the next call waits for those too. Returns the live processes of the tree; empty means it is gone.
 */
export function survivingTree<T extends TreeProcess>(tracked: Map<number, T>, live: readonly T[]): T[] {
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of live) {
      if (tracked.has(candidate.pid)) continue;
      const parent = tracked.get(candidate.ppid);
      if (!parent || !live.some((member) => sameProcess(parent, member))) continue;
      if (
        candidate.startedAt !== undefined &&
        parent.startedAt !== undefined &&
        candidate.startedAt < parent.startedAt
      ) {
        continue; // created before its supposed parent: the parent pid was reused
      }
      tracked.set(candidate.pid, candidate);
      grew = true;
    }
  }
  return live.filter((candidate) => {
    const known = tracked.get(candidate.pid);
    return known !== undefined && sameProcess(known, candidate);
  });
}

/**
 * Whether `candidate` belongs to a Firefox background task: its nearest ancestor that is a browser executable (walking
 * parent pids through `processes`) is Firefox in background-task mode whose command line does not name the Dashboard. Such
 * a task may start its own `-contentproc` children, which carry no `--backgroundtask` token. A child of a normal browser
 * main process, already running or not, is not excluded: `shell.openExternal` into a running browser shows up exactly as a
 * new child there. A parent created after its supposed child is a reused pid, and the walk stops there.
 */
export function inFirefoxBackgroundTask(
  candidate: TreeProcess & BrowserCandidate,
  processes: ReadonlyArray<TreeProcess & BrowserCandidate>,
  dashboardPort?: number,
): boolean {
  const visited = new Set<number>([candidate.pid]);
  let child = candidate;
  for (;;) {
    const parent = processes.find((member) => member.pid === child.ppid);
    if (!parent || visited.has(parent.pid)) return false;
    if (child.startedAt !== undefined && parent.startedAt !== undefined && child.startedAt < parent.startedAt) {
      return false; // created before its supposed parent: the parent pid was reused
    }
    if (BROWSER_COMMANDS.test(parent.executable ?? parent.commandLine)) {
      return isFirefoxBackgroundTask(parent) && !namesDashboard(parent.commandLine, dashboardPort);
    }
    visited.add(parent.pid);
    child = parent;
  }
}

/** Seconds from `ps` elapsed time (`[[dd-]hh:]mm:ss`); undefined when it does not parse. */
export function parseElapsedSeconds(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * One line for a failure message: pid, executable, the parent pid with its executable and the start of its command line
 * when the parent is still alive (`parent.executable` is what the caller resolved for it; `parent.alive` false prints
 * "gone"), creation time when known, and the start of the command line. The parent's command line tells, for example,
 * whether it was a Firefox background task.
 */
export function describeProcessLine(
  candidate: TreeProcess & { readonly executable: string | undefined },
  parent: {
    readonly alive: boolean;
    readonly executable: string | undefined;
    readonly commandLine?: string | undefined;
  },
  commandLimit: number,
): string {
  const parentCommand =
    parent.commandLine === undefined ? "" : ` (command: ${parent.commandLine.slice(0, commandLimit)})`;
  const parentText = !parent.alive
    ? `parent pid ${candidate.ppid} (gone)`
    : `parent pid ${candidate.ppid} ${parent.executable ?? "(executable unknown)"}${parentCommand}`;
  const started = candidate.startedAt === undefined ? "" : ` started ${new Date(candidate.startedAt).toISOString()}`;
  return `  pid ${candidate.pid} ${candidate.executable ?? "(executable unknown)"} [${parentText}]${started} ${candidate.commandLine.slice(0, commandLimit)}`;
}
