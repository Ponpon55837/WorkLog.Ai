export type LegacyServicePlatform = "darwin" | "linux" | "win32";

export type LegacyServiceRunning = "running" | "stopped" | "unknown";

/** Whether the OS starts the service by itself (login): `unknown` when it cannot be told, never guessed. */
export type LegacyServiceEnabled = "enabled" | "disabled" | "unknown";

export interface LegacyServiceCommandResult {
  stdout: string;
  code: number;
}

export type LegacyServiceCommandRunner = (command: string, args: string[]) => Promise<LegacyServiceCommandResult>;

/** What `lstat` reports about the definition file; null from the injected function means "does not exist". */
export interface LegacyServiceFileStat {
  isSymbolicLink: boolean;
  isFile: boolean;
  size: number;
}

export interface DetectLegacyServiceOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  /** Numeric user id for `launchctl print gui/<uid>/…`; defaults to the current process uid, else 501. */
  uid?: number;
  /** Read-only command runner; defaults to a `execFile` runner with `windowsHide` and the detection deadline. */
  runCommand?: LegacyServiceCommandRunner;
  /** Reads the definition as text (a UTF-16 task file is decoded by the default reader). */
  readTextFile?: (path: string) => Promise<string>;
  /** `lstat` of the definition; must not follow symlinks and resolves null when the path does not exist. */
  lstatFile?: (path: string) => Promise<LegacyServiceFileStat | null>;
  /** Budget for the whole detection, commands included. Defaults to 2000 ms. */
  timeoutMs?: number;
}

export interface LegacyServiceFound {
  kind: "found";
  platform: LegacyServicePlatform;
  /** The definition file, or the task path (`\Work Intelligence`) when Windows had no XML copy and the task was queried. */
  definitionPath: string;
  definitionSource: "file" | "task-query";
  /** Name and content both match what `service:install` writes (and the file is a regular file, not a symlink). */
  recognised: boolean;
  /** Only parsed from a recognised definition. */
  repositoryRoot?: string;
  databasePath?: string;
  /** The service's backup folder, when the recognised definition names an absolute one. */
  backupDirectory?: string;
  /** SHA-256 of the recognised definition text (see `legacyDefinitionDigest`); only from a recognised definition. */
  definitionDigest?: string;
  /** From the definition when it names WORK_INTELLIGENCE_PORT, otherwise the server default (the definition never sets it). */
  port?: number;
  running: LegacyServiceRunning;
  /** Starts at the next login (launchd loaded with RunAtLoad, systemd enabled, a logon-triggered enabled task); absent means unknown. */
  enabled?: LegacyServiceEnabled;
  /** `cd <checkout> && pnpm service:uninstall`, quoted for the OS shell; only when the checkout is known. */
  removeCommand?: string;
  /** The raw OS commands that remove the service without the checkout. */
  fallbackRemoveCommand: string;
}

export type LegacyServiceDetection = { kind: "none" } | LegacyServiceFound;
