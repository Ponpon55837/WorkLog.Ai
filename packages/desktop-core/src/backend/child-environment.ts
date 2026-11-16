/** Environment of the parent (or any record): names to optional values. */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export interface ChildEnvironmentInput {
  readonly platform: NodeJS.Platform;
  /** Where allowed values are copied from; normally `process.env`. */
  readonly parentEnvironment: EnvironmentRecord;
  /** Values the desktop App sets on purpose; every name must be `WORK_INTELLIGENCE_*`. */
  readonly desktopValues?: Readonly<Record<string, string>>;
}

/** Variable names the child may inherit on POSIX (exact names; `LC_*` is matched by prefix). */
const POSIX_ALLOWED = new Set(["HOME", "TMPDIR", "LANG", "TZ"]);
const POSIX_PREFIXES = ["LC_"] as const;
/** The same on Windows, keyed by lower-case name because Windows treats names case-insensitively. */
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
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";
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
    // The canonical spelling is used for the copy, so a parent's `SYSTEMROOT` and `SystemRoot` collapse into one entry.
    if (canonical !== undefined && value !== undefined && value !== "") result[canonical] = value;
  }
  result.PATH = `${result.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT}\\System32`;
  return result;
}

/**
 * The environment a backend child starts with (R4 section 5.1, C-08): an allowlist copy of a few OS variables, a fixed
 * minimal PATH, and the `WORK_INTELLIGENCE_*` values the App chose. Everything else is dropped, notably `NODE_OPTIONS`
 * (it can load code or change TLS trust), `NODE_PATH`, `ELECTRON_*` (the launch plan adds its own when the runtime
 * needs them) and the user's PATH (it may hold another `node`). Pure: the parent environment and platform are inputs.
 */
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
