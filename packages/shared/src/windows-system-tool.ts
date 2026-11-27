import path from "node:path";

export type WindowsEnvironment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

const SYSTEM32 = "System32";
const POWERSHELL_DIRECTORY = ["WindowsPowerShell", "v1.0"] as const;
const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const BARE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

export function windowsSystemRoot(env: WindowsEnvironment = process.env): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "systemroot");
  const value = key === undefined ? undefined : env[key];
  return value !== undefined && ABSOLUTE_WINDOWS_PATH.test(value)
    ? path.win32.normalize(value)
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

export function windowsSystem32Directory(env: WindowsEnvironment = process.env): string {
  return path.win32.join(windowsSystemRoot(env), SYSTEM32);
}

/**
 * Always the System32 file, never a bare name: PATH may hold Git for Windows/MSYS look-alikes (their `whoami.exe`
 * rejects `/user`). `name` must be a plain file name.
 */
export function windowsSystemTool(name: string, env: WindowsEnvironment = process.env): string {
  if (!BARE_FILE_NAME.test(name) || name.startsWith(".")) {
    throw new RangeError(`a Windows system tool is named by its file name only, not "${name}"`);
  }
  return path.win32.join(windowsSystem32Directory(env), name);
}

export function windowsPowerShell(env: WindowsEnvironment = process.env): string {
  return path.win32.join(windowsSystem32Directory(env), ...POWERSHELL_DIRECTORY, "powershell.exe");
}

/** `ComSpec` is deliberately not read: any process starting the App could point it at another program. */
export function windowsCommandShell(env: WindowsEnvironment = process.env): string {
  return windowsSystemTool("cmd.exe", env);
}
