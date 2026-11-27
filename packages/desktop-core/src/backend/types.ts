import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { LaunchPlan } from "../runtime/launch-plan.js";
import type { EnvironmentRecord } from "./child-environment.js";

export type SupervisedChild = Pick<
  ChildProcess,
  "pid" | "exitCode" | "signalCode" | "send" | "kill" | "on" | "off" | "stdout" | "stderr"
>;

export interface HealthResponse {
  readonly status: number;
  header(name: string): string | undefined;
}

export interface BackendSupervisorDependencies {
  planLaunch(argv: readonly string[], env: EnvironmentRecord): Promise<LaunchPlan>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): SupervisedChild;
  isPortFree(port: number): Promise<boolean>;
  probePort?(port: number): Promise<{ readonly free: true } | { readonly free: false; readonly code: string }>;
  fetchHealth(url: string, headers: Readonly<Record<string, string>>, timeoutMs: number): Promise<HealthResponse>;
  randomRunId(): string;
  randomChallenge(): string;
  realpath(path: string): string;
  killTree?(pid: number): void | Promise<void>;
  ensureDirectory?(path: string): Promise<void>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  readonly platform: NodeJS.Platform;
  readonly parentEnvironment: EnvironmentRecord;
}

export interface BackendTimeouts {
  readonly helloMs: number;
  readonly preflightMs: number;
  readonly quickCheckMs: number;
  readonly readyMs: number;
  readonly healthMs: number;
  readonly copyMs: number;
  readonly gracefulMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
  readonly portReleaseMs: number;
  readonly pollMs: number;
  readonly monitorMs: number;
}

export const DEFAULT_BACKEND_TIMEOUTS: BackendTimeouts = {
  helloMs: 10_000,
  preflightMs: 15_000,
  quickCheckMs: 300_000,
  readyMs: 60_000,
  healthMs: 5_000,
  copyMs: 600_000,
  gracefulMs: 10_000,
  terminateMs: 3_000,
  killMs: 3_000,
  portReleaseMs: 5_000,
  pollMs: 100,
  monitorMs: 60_000,
};

export interface BackendPreflightSummary {
  readonly identity: DesktopDatabaseIdentity;
  readonly schemaVersion: number | undefined;
  readonly willMigrate: boolean;
}
