/**
 * How plugin scripts use the Work Intelligence desktop App, when one is installed. The App writes
 * `desktop-integration.json` (see packages/desktop-core/src/integration/record.ts) into the config directory; this file
 * reads it with no dependencies, because it ships inside the plugin, the MCPB and the standalone package, none of which
 * carry node_modules. The validation rules are the App's, and tests/server/desktop-integration.test.ts keeps both
 * implementations in agreement.
 *
 * The record is untrusted input: any process of this user can write the config directory. So a record is used only when
 * it is exactly what the App writes (strict fields, normalized absolute paths, launcher path = `<runtimeRoot>/bin/<shim>`)
 * and the shim on disk is a regular file whose real path really is that shim (a symlink, or a `bin` directory that
 * points elsewhere, is refused). Anything else means "no desktop App", and the caller falls back to its own way.
 */
import { spawn } from "node:child_process";
import console from "node:console";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
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
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\\\\)/;
const WINDOWS_SHIM_NAME = "work-intelligence-launcher.cmd";
const POSIX_SHIM_NAME = "work-intelligence-launcher";
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
    ? WINDOWS_ABSOLUTE_PATH.test(value) && win32.normalize(value) === value
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

/** The validated record of this user, or undefined when there is none or it is not valid. */
export function readDesktopIntegration({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  try {
    const file = join(configDirectory(environment, home), INTEGRATION_RECORD_FILE_NAME);
    return parseDesktopIntegration(readFileSync(file, "utf8"), platform);
  } catch {
    return undefined;
  }
}

function sameRealPath(a, b, platform) {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether the shim is a regular file that really sits at `<runtimeRoot>/bin/<shim>` (no symlink in the way). */
function isGenuineShim(record, platform) {
  try {
    if (!lstatSync(record.launcherPath).isFile()) return false;
    const expected = join(realpathSync(record.runtimeRoot), "bin", basename(record.launcherPath));
    return sameRealPath(realpathSync(record.launcherPath), expected, platform);
  } catch {
    return false;
  }
}

/** `%SystemRoot%\System32\cmd.exe`, never found through PATH or ComSpec (any process that starts us can set those). */
function windowsCommandShell(environment) {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "systemroot");
  const root = key === undefined ? undefined : environment[key];
  return win32.join(
    root !== undefined && WINDOWS_ABSOLUTE_PATH.test(root) ? win32.normalize(root) : "C:\\Windows",
    "System32",
    "cmd.exe",
  );
}

/**
 * How to run the desktop launcher for a plugin command: `{ command, args, windowsVerbatimArguments }` for `spawn` with
 * no shell, or undefined when the command has no launcher action or no usable desktop App is installed. A `.cmd` cannot
 * be spawned directly on Windows, so it runs through System32's cmd.exe with the quoting `/s` expects; a path with `%`
 * (cmd would expand it) is refused rather than escaped.
 */
export function resolveDesktopLauncher(command, options = {}) {
  const action = LAUNCHER_ACTIONS[command];
  const platform = options.platform ?? process.platform;
  const record = action === undefined ? undefined : readDesktopIntegration({ ...options, platform });
  if (record === undefined || !isGenuineShim(record, platform)) return undefined;
  if (platform !== "win32") return { command: record.launcherPath, args: [action], windowsVerbatimArguments: false };
  if (record.launcherPath.includes("%")) return undefined;
  return {
    command: windowsCommandShell(options.environment ?? process.env),
    args: ["/d", "/s", "/c", `""${record.launcherPath}" ${action}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * The App executable to hand a Dashboard request to, or undefined. A developer who names a checkout with
 * WORK_INTELLIGENCE_HOME keeps that checkout's dashboard: the App is not asked.
 */
export function resolveDesktopApp(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.WORK_INTELLIGENCE_HOME?.trim()) return undefined;
  const record = readDesktopIntegration(options);
  try {
    return record !== undefined && statSync(record.appExecutable).isFile() ? record.appExecutable : undefined;
  } catch {
    return undefined;
  }
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
 * Runs the launcher with stdin and stdout passed through (for `mcp`, stdout stays the MCP protocol alone) and sets this
 * process's exit code from it. A hook never blocks the Agent: its stderr is dropped, it is stopped after
 * {@link HOOK_TIMEOUT_MS}, and it exits 0 whatever the launcher did.
 */
export function runDesktopLauncher(launcher, { hook, timeoutMs = HOOK_TIMEOUT_MS }) {
  const child = spawn(launcher.command, launcher.args, {
    stdio: ["inherit", "inherit", hook ? "ignore" : "inherit"],
    windowsHide: true,
    windowsVerbatimArguments: launcher.windowsVerbatimArguments,
  });
  const timer = hook ? setTimeout(() => child.kill(), timeoutMs) : undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    clearTimeout(timer);
    if (!hook) console.error(`Work Intelligence plugin: ${error.message}`);
    process.exitCode = hook ? 0 : 1;
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    process.exitCode = hook ? 0 : (code ?? (signal ? 1 : 0));
  });
}
