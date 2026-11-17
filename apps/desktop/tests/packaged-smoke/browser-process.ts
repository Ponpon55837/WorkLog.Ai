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
  const backgroundTask =
    FIREFOX_COMMAND.test(command) && candidate.commandLine.split(/\s+/).includes(FIREFOX_BACKGROUND_TASK_TOKEN);
  return !backgroundTask || namesDashboard(candidate.commandLine, dashboardPort);
}
