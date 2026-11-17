import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { LaunchPlan } from "../runtime/launch-plan.js";
import type { EnvironmentRecord } from "./child-environment.js";

/** The part of a `ChildProcess` the supervisor uses; the real object satisfies it and tests pass a fake. */
export type SupervisedChild = Pick<
  ChildProcess,
  "pid" | "exitCode" | "signalCode" | "send" | "kill" | "on" | "off" | "stdout" | "stderr"
>;

export interface HealthResponse {
  readonly status: number;
  /** A response header by lower-case name. */
  header(name: string): string | undefined;
}

/** Everything the supervisor touches outside itself, injected so every branch runs in a unit test on any OS. */
export interface BackendSupervisorDependencies {
  /** Plans how to run the verified runtime's `serve` action with `argv` and exactly the environment `env`. */
  planLaunch(argv: readonly string[], env: EnvironmentRecord): Promise<LaunchPlan>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): SupervisedChild;
  /** Whether `127.0.0.1:port` can be bound right now. */
  isPortFree(port: number): Promise<boolean>;
  /** One GET of the health URL with `headers`, ending after `timeoutMs`; rejects on a connection error. */
  fetchHealth(url: string, headers: Readonly<Record<string, string>>, timeoutMs: number): Promise<HealthResponse>;
  /** A fresh unpredictable per-spawn secret. */
  randomRunId(): string;
  /** A fresh unpredictable health challenge. */
  randomChallenge(): string;
  /** `fs.realpathSync.native`, so a Windows 8.3 name or a symlinked path compares equal to the real executable. */
  realpath(path: string): string;
  /** Creates `path` (and its parents) when it is missing; used for the fixed working directory before every spawn. */
  ensureDirectory?(path: string): Promise<void>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  readonly platform: NodeJS.Platform;
  readonly parentEnvironment: EnvironmentRecord;
}

/** How long each step may take, in milliseconds. */
export interface BackendTimeouts {
  /** Child process start to its `hello`. */
  readonly helloMs: number;
  readonly preflightMs: number;
  /** One preflight that also runs `PRAGMA quick_check`, which reads the whole database. */
  readonly quickCheckMs: number;
  /** `start` sent to `ready` (a schema migration happens here). */
  readonly readyMs: number;
  /** One HTTP readiness request. */
  readonly healthMs: number;
  /** After the IPC `shutdown`, before escalating. */
  readonly gracefulMs: number;
  /** After SIGTERM (POSIX only), before the final kill. */
  readonly terminateMs: number;
  /** After the final kill, for the exit event. */
  readonly killMs: number;
  /** How long to poll for the port to become free after exit. */
  readonly portReleaseMs: number;
  readonly pollMs: number;
}

export const DEFAULT_BACKEND_TIMEOUTS: BackendTimeouts = {
  helloMs: 10_000,
  preflightMs: 15_000,
  quickCheckMs: 300_000,
  readyMs: 60_000,
  healthMs: 5_000,
  gracefulMs: 10_000,
  terminateMs: 3_000,
  killMs: 3_000,
  portReleaseMs: 5_000,
  pollMs: 100,
};

/** What the preflight found, handed to `beforeStart` so the caller can persist intent before anything can write. */
export interface BackendPreflightSummary {
  readonly identity: DesktopDatabaseIdentity;
  readonly schemaVersion: number | undefined;
  /** True when opening will write the schema: an empty file gets one, an older one is migrated. */
  readonly willMigrate: boolean;
}
