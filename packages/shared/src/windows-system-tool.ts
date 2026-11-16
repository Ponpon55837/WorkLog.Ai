import path from "node:path";

/** The environment the helpers read; a plain record so tests can inject any spelling of the variable names. */
export type WindowsEnvironment = Readonly<Record<string, string | undefined>>;

/** Used when `SystemRoot` is missing, empty or not an absolute Windows path. */
export const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

const SYSTEM32 = "System32";
const POWERSHELL_DIRECTORY = ["WindowsPowerShell", "v1.0"] as const;
/** A drive-letter or UNC path; a rooted path without a drive (`\\Windows`) depends on the current drive. */
const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const BARE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `%SystemRoot%`, read case-insensitively (a plain object may hold `SYSTEMROOT`; `process.env` on Windows already
 * ignores case). A value that is not a drive-qualified absolute path falls back to `C:\Windows`, so a malformed variable can
 * never turn a system tool into a relative path.
 */
export function windowsSystemRoot(env: WindowsEnvironment = process.env): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "systemroot");
  const value = key === undefined ? undefined : env[key];
  return value !== undefined && ABSOLUTE_WINDOWS_PATH.test(value)
    ? path.win32.normalize(value)
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

/** `%SystemRoot%\System32`, the only directory Windows system tools are started from. */
export function windowsSystem32Directory(env: WindowsEnvironment = process.env): string {
  return path.win32.join(windowsSystemRoot(env), SYSTEM32);
}

/**
 * The absolute path of a Windows system tool, such as `whoami.exe`, `icacls.exe` or `taskkill.exe`.
 *
 * A bare tool name is resolved through PATH, and a user's PATH often holds Git for Windows or MSYS, whose coreutils ship
 * their own `whoami.exe` (it rejects `/user`) and other look-alikes. Product code and scripts therefore always spawn the
 * file under System32 and never a bare name, `.exe` suffix or not. `name` must be a plain file name; a path is refused.
 */
export function windowsSystemTool(name: string, env: WindowsEnvironment = process.env): string {
  if (!BARE_FILE_NAME.test(name) || name.startsWith(".")) {
    throw new RangeError(`a Windows system tool is named by its file name only, not "${name}"`);
  }
  return path.win32.join(windowsSystem32Directory(env), name);
}

/** Windows PowerShell 5.1, which every supported Windows ships, under System32. */
export function windowsPowerShell(env: WindowsEnvironment = process.env): string {
  return path.win32.join(windowsSystem32Directory(env), ...POWERSHELL_DIRECTORY, "powershell.exe");
}

/**
 * The command interpreter: always `System32\cmd.exe`. `ComSpec` is deliberately not read, because any process that
 * starts the App can set it to another program; `SystemRoot` already finds the real cmd.exe on every Windows install.
 */
export function windowsCommandShell(env: WindowsEnvironment = process.env): string {
  return windowsSystemTool("cmd.exe", env);
}
