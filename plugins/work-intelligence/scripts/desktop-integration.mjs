/**
 * How plugin scripts use the Work Intelligence desktop App, when one is installed. The App writes
 * `desktop-integration.json` (see packages/desktop-core/src/integration/record.ts) into the config directory; this file
 * reads it with no dependencies, because it ships inside the plugin, the MCPB and the standalone package, none of which
 * carry node_modules (so it cannot import @work-intelligence/shared or the zod schema of record.ts). The record rules are
 * the App's; tests/desktop-core/integration-record.test.ts feeds one table of cases to both parsers to keep them equal.
 *
 * Threat model. A process running as the same OS user can already rewrite the Agents' own configs (~/.claude.json,
 * ~/.codex/config.toml) and `plugin-link.json`, so a same-user writer of the record is not a new privilege boundary.
 * The record must not widen it either: it is refused when another user or a network share could control what it names.
 * It is used only when it is exactly what the App writes (strict fields, normalized absolute paths, launcher path =
 * `<runtimeRoot>/bin/<shim>`; on Windows only drive-letter paths, never `\\server\share`, `\\?\` or `\\.\`, which would
 * send NTLM credentials to a remote host), and on POSIX the record, its directory, the runtime root, its `bin`
 * directory and the shim are real (lstat, no symlinks) entries owned by this user that nobody else can write. The App
 * writes canonical (real) paths for the runtime root and its executable, which is what lets that no-symlink walk
 * pass when the install or the user data folder is reached through a symlink (macOS `/var` -> `/private/var`). The
 * runtime pointer `current` must exist and the App executable is a regular file. Windows file ACLs are checked by the
 * launcher itself (runtime/windows-acl.ts), not here. Anything else means "no desktop App": the caller falls back to
 * its own way and the plugin keeps working.
 */
import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

export const INTEGRATION_RECORD_FILE_NAME = "desktop-integration.json";
/** Asks the App to open the Dashboard (see packages/desktop-core/src/shell/launch-command.ts). */
export const OPEN_DASHBOARD_FLAG = "--open-dashboard";
/** Plugin command -> action of the fixed launcher shim. The dashboard is not an action: the App itself opens it. */
export const LAUNCHER_ACTIONS = {
  mcp: "mcp",
  "finalize-reminder": "claude-finalize-reminder",
  "codex-finalize-reminder": "codex-finalize-reminder",
};

const RECORD_KEYS = ["version", "launcherPath", "runtimeRoot", "appExecutable", "appVersion", "writtenAt"];
const MAX_PATH_LENGTH = 4096;
const MAX_TEXT_LENGTH = 128;
/** A drive-letter path only: `\\server\share`, `\\?\` and `\\.\` are refused (a UNC path makes Windows send NTLM credentials). */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const WINDOWS_SHIM_NAME = "work-intelligence-launcher.cmd";
const POSIX_SHIM_NAME = "work-intelligence-launcher";
/** The shared runtime id charset (packages/desktop-core/src/runtime/paths.ts). */
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Same rule as the runtime verifier (ADR-15): POSIX refuses world-writable entries. Group write is allowed because a
 * umask-002 system with a private user group creates the App's folders as 775.
 */
const WORLD_WRITABLE = 0o002;
/** A hook run through the launcher is stopped after this long; the launcher verifies a runtime in well under a second. */
export const HOOK_TIMEOUT_MS = 25_000;
/** Set by an Electron host (an Agent app may be one); the App must start as an App, and the shim sets them itself. */
const ELECTRON_VARIABLES = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR"];

/** `WORK_INTELLIGENCE_CONFIG_DIR`, else `~/.work-intelligence`; also where `plugin-link.json` lives. */
export function configDirectory(environment = process.env, home = homedir()) {
  return environment.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || join(home, ".work-intelligence");
}

function isNonEmptyText(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function isNormalizedAbsolutePath(value, platform) {
  if (!isNonEmptyText(value, MAX_PATH_LENGTH) || value.includes("\0")) return false;
  return platform === "win32"
    ? WINDOWS_DRIVE_PATH.test(value) && win32.normalize(value) === value
    : value.startsWith("/") && posix.normalize(value) === value;
}

/** The record in `text`, or undefined when it is not JSON or breaks any rule. */
export function parseDesktopIntegration(text, platform = process.platform) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => keys.includes(key))) return undefined;
  if (value.version !== 1) return undefined;
  const paths = platform === "win32" ? win32 : posix;
  const shim = platform === "win32" ? WINDOWS_SHIM_NAME : POSIX_SHIM_NAME;
  for (const key of ["launcherPath", "runtimeRoot", "appExecutable"]) {
    if (!isNormalizedAbsolutePath(value[key], platform)) return undefined;
  }
  if (!isNonEmptyText(value.appVersion, MAX_TEXT_LENGTH) || !isNonEmptyText(value.writtenAt, MAX_TEXT_LENGTH)) {
    return undefined;
  }
  if (value.launcherPath !== paths.join(value.runtimeRoot, "bin", shim)) return undefined;
  return value;
}

/** The uid every POSIX entry must belong to; undefined on Windows, where ACLs are the launcher's job. */
function expectedUid({ platform, uid }) {
  return platform === "win32" ? undefined : (uid ?? process.getuid?.());
}

/** Whether `path` is itself (lstat: no symlink) the `kind` of entry, and on POSIX owned by `uid` and not world-writable. */
function isTrustedEntry(path, kind, uid) {
  try {
    const stat = lstatSync(path);
    if (!(kind === "directory" ? stat.isDirectory() : stat.isFile())) return false;
    return uid === undefined || (stat.uid === uid && (stat.mode & WORLD_WRITABLE) === 0);
  } catch {
    return false;
  }
}

/**
 * The validated record of this user, or undefined when there is none, it is not valid, or on POSIX the record file or
 * its directory is a symlink, belongs to another user or can be written by others.
 */
export function readDesktopIntegration({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
  uid,
} = {}) {
  try {
    const directory = configDirectory(environment, home);
    const file = join(directory, INTEGRATION_RECORD_FILE_NAME);
    const owner = expectedUid({ platform, uid });
    if (!isTrustedEntry(directory, "directory", owner) || !isTrustedEntry(file, "file", owner)) return undefined;
    return parseDesktopIntegration(readFileSync(file, "utf8"), platform);
  } catch {
    return undefined;
  }
}

function sameRealPath(a, b, platform) {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether the shim really sits at `<runtimeRoot>/bin/<shim>` (no symlink in the way) and, on POSIX, the runtime root,
 * `bin` and the shim are owned by this user and not writable by anyone else.
 */
function isGenuineShim(record, platform, uid) {
  const owner = expectedUid({ platform, uid });
  if (
    !isTrustedEntry(record.runtimeRoot, "directory", owner) ||
    !isTrustedEntry(dirname(record.launcherPath), "directory", owner) ||
    !isTrustedEntry(record.launcherPath, "file", owner)
  ) {
    return false;
  }
  try {
    const expected = join(realpathSync(record.runtimeRoot), "bin", basename(record.launcherPath));
    return sameRealPath(realpathSync(record.launcherPath), expected, platform);
  } catch {
    return false;
  }
}

/** The first line of a small file, or undefined; the shim reads the same line (a trailing CR dropped). */
function firstLine(file) {
  try {
    return readFileSync(file, "utf8").split("\n", 1)[0].replace(/\r$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the fixed shim would fail right now, or undefined. It repeats the shim's own checks (`current`, the runtime's
 * `runtime-launch.txt`, the executable and `launcher.mjs` exist). A fallback after the shim failed could not replay the
 * host's first MCP message, which the child may already have consumed from the inherited stdin, so the decision is made
 * before the start and stdin stays untouched.
 */
function launcherProblem(record) {
  const pointer = join(record.runtimeRoot, "current");
  if (!isTrustedEntry(pointer, "file", undefined)) return `${pointer} is missing or not a regular file`;
  const id = firstLine(pointer);
  if (id === undefined || !RUNTIME_ID.test(id)) return `${pointer} does not name a runtime`;
  const runtime = join(record.runtimeRoot, "runtimes", id);
  const launchFile = join(runtime, "runtime-launch.txt");
  const executable = firstLine(launchFile);
  if (executable === undefined) return `${launchFile} is missing or empty`;
  if (!existsSync(join(runtime, executable)) || !existsSync(join(runtime, "launcher.mjs"))) {
    return `the runtime ${id} is incomplete`;
  }
  return undefined;
}

/** `%SystemRoot%\System32\<name>`, never found through PATH or ComSpec (any process that starts us can set those). */
function windowsSystemTool(name, environment) {
  const key = Object.keys(environment).find((variable) => variable.toLowerCase() === "systemroot");
  const root = key === undefined ? undefined : environment[key];
  return win32.join(
    root !== undefined && WINDOWS_DRIVE_PATH.test(root) ? win32.normalize(root) : "C:\\Windows",
    "System32",
    name,
  );
}

/**
 * How to run the desktop launcher for a plugin command: `{ command, args, windowsVerbatimArguments }` for `spawn` with
 * no shell, or undefined when the command has no launcher action, no usable desktop App is installed, or its runtime is
 * not ready (then `onProblem` gets the reason, so the caller can say why it fell back). A `.cmd` cannot be spawned
 * directly on Windows, so it runs through System32's cmd.exe with the quoting `/s` expects; a path with `%` (cmd would
 * expand it) is refused rather than escaped.
 */
export function resolveDesktopLauncher(command, options = {}) {
  const action = LAUNCHER_ACTIONS[command];
  const platform = options.platform ?? process.platform;
  const record = action === undefined ? undefined : readDesktopIntegration({ ...options, platform });
  if (record === undefined || !isGenuineShim(record, platform, options.uid)) return undefined;
  const problem = launcherProblem(record);
  if (problem !== undefined) {
    options.onProblem?.(problem);
    return undefined;
  }
  if (platform !== "win32") return { command: record.launcherPath, args: [action], windowsVerbatimArguments: false };
  if (record.launcherPath.includes("%")) return undefined;
  return {
    command: windowsSystemTool("cmd.exe", options.environment ?? process.env),
    args: ["/d", "/s", "/c", `""${record.launcherPath}" ${action}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * The App executable to hand a Dashboard request to, or undefined. A developer who names a checkout with
 * WORK_INTELLIGENCE_HOME keeps that checkout's dashboard: the App is not asked. The executable must be a regular file
 * (not a symlink); inside a macOS bundle that is `<X>.app/Contents/MacOS/<X>`.
 */
export function resolveDesktopApp(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.WORK_INTELLIGENCE_HOME?.trim()) return undefined;
  const record = readDesktopIntegration(options);
  return record !== undefined && isTrustedEntry(record.appExecutable, "file", undefined)
    ? record.appExecutable
    : undefined;
}

/**
 * Starts the App detached with `--open-dashboard`, whether or not it runs: a running App opens the Dashboard at its
 * current port (the second launch exits at once), an App that is not running starts, manages its backend and opens it.
 * Resolves true once the process exists, false when it could not be started.
 */
export function openDashboardInApp(appExecutable, { environment = process.env, spawnProcess = spawn } = {}) {
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !ELECTRON_VARIABLES.includes(name.toUpperCase())),
  );
  return new Promise((resolve) => {
    try {
      const child = spawnProcess(appExecutable, [OPEN_DASHBOARD_FLAG], {
        detached: true,
        stdio: "ignore",
        env: childEnvironment,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Stops the launcher. On Windows the child is `cmd.exe /c shim.cmd`, and killing it would orphan the launcher it
 * started, so the whole tree goes with System32's `taskkill /T /F`; if that cannot run or fails, the child alone is
 * killed. Nothing is done once the child has exited, because its pid may already belong to another process.
 */
function stopLauncher(child, { platform, environment, spawnProcess }, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== "win32" || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    const taskkill = windowsSystemTool("taskkill.exe", environment);
    const killer = spawnProcess(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill());
    killer.once("exit", (code) => {
      if (code !== 0) child.kill();
    });
  } catch {
    child.kill();
  }
}

/**
 * Runs the launcher with stdin and stdout passed through (for `mcp`, stdout stays the MCP protocol alone) and sets the
 * exit code of `host` (this process) from it. A hook never blocks the Agent: its stderr is dropped, it is stopped after
 * {@link HOOK_TIMEOUT_MS}, and it exits 0 whatever the launcher did, including when it cannot even be started. For `mcp`
 * a start failure exits 1 with one line on stderr.
 */
export function runDesktopLauncher(
  launcher,
  {
    hook,
    timeoutMs = HOOK_TIMEOUT_MS,
    platform = process.platform,
    environment = process.env,
    spawnProcess = spawn,
    host = process,
  },
) {
  const fail = (message) => {
    if (!hook) console.error(`Work Intelligence plugin: ${message}`);
    host.exitCode = hook ? 0 : 1;
  };
  let child;
  try {
    child = spawnProcess(launcher.command, launcher.args, {
      stdio: ["inherit", "inherit", hook ? "ignore" : "inherit"],
      windowsHide: true,
      windowsVerbatimArguments: launcher.windowsVerbatimArguments,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const context = { platform, environment, spawnProcess };
  const timer = hook ? setTimeout(() => stopLauncher(child, context), timeoutMs) : undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    host.on(signal, () => stopLauncher(child, context, signal));
  }
  child.on("error", (error) => {
    clearTimeout(timer);
    fail(error.message);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    host.exitCode = hook ? 0 : (code ?? (signal ? 1 : 0));
  });
}
