import { windowsSystem32Directory } from "@work-intelligence/shared/windows-system-tool";

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export interface ChildEnvironmentInput {
  readonly platform: NodeJS.Platform;
  readonly parentEnvironment: EnvironmentRecord;
  readonly desktopValues?: Readonly<Record<string, string>>;
}

const POSIX_ALLOWED = new Set(["HOME", "TMPDIR", "LANG", "TZ"]);
const POSIX_PREFIXES = ["LC_"] as const;
const WINDOWS_ALLOWED = [
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "ComSpec",
  "PATHEXT",
];
const WINDOWS_ALLOWED_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  WINDOWS_ALLOWED.map((name) => [name.toLowerCase(), name]),
);

const POSIX_FIXED_PATH = "/usr/bin:/bin";
const DESKTOP_VALUE_NAME = /^WORK_INTELLIGENCE_[A-Z0-9_]+$/;

function isAllowedPosixName(name: string): boolean {
  return POSIX_ALLOWED.has(name) || POSIX_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function posixEnvironment(parent: EnvironmentRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && value !== "" && isAllowedPosixName(name)) result[name] = value;
  }
  result.PATH = POSIX_FIXED_PATH;
  return result;
}

function windowsEnvironment(parent: EnvironmentRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    const canonical = WINDOWS_ALLOWED_BY_LOWERCASE.get(name.toLowerCase());
    // Windows env names are case-insensitive: one canonical spelling, so `SYSTEMROOT` and `SystemRoot` collapse.
    if (canonical !== undefined && value !== undefined && value !== "") result[canonical] = value;
  }
  result.PATH = windowsSystem32Directory(result);
  return result;
}

export function buildChildEnvironment(input: ChildEnvironmentInput): Record<string, string> {
  const base =
    input.platform === "win32"
      ? windowsEnvironment(input.parentEnvironment)
      : posixEnvironment(input.parentEnvironment);
  for (const [name, value] of Object.entries(input.desktopValues ?? {})) {
    if (!DESKTOP_VALUE_NAME.test(name)) {
      throw new RangeError(`the App may only set WORK_INTELLIGENCE_* variables for the backend, not ${name}`);
    }
    base[name] = value;
  }
  return base;
}
