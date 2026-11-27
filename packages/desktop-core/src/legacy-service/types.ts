export type LegacyServicePlatform = "darwin" | "linux" | "win32";

export type LegacyServiceRunning = "running" | "stopped" | "unknown";

export type LegacyServiceEnabled = "enabled" | "disabled" | "unknown";

export interface LegacyServiceCommandResult {
  stdout: string;
  code: number;
}

export type LegacyServiceCommandRunner = (command: string, args: string[]) => Promise<LegacyServiceCommandResult>;

export interface LegacyServiceFileStat {
  isSymbolicLink: boolean;
  isFile: boolean;
  size: number;
}

export interface DetectLegacyServiceOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  uid?: number;
  runCommand?: LegacyServiceCommandRunner;
  readTextFile?: (path: string) => Promise<string>;
  lstatFile?: (path: string) => Promise<LegacyServiceFileStat | null>;
  timeoutMs?: number;
}

export interface LegacyServiceFound {
  kind: "found";
  platform: LegacyServicePlatform;
  definitionPath: string;
  definitionSource: "file" | "task-query";
  recognised: boolean;
  repositoryRoot?: string;
  databasePath?: string;
  backupDirectory?: string;
  definitionDigest?: string;
  port?: number;
  running: LegacyServiceRunning;
  enabled?: LegacyServiceEnabled;
}

export type LegacyServiceDetection = { kind: "none" } | { kind: "unknown" } | LegacyServiceFound;
