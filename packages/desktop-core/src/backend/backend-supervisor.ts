import { StringDecoder } from "node:string_decoder";
import {
  DESKTOP_CHILD_PROTOCOL_VERSION,
  type DesktopBackendActivity,
  type DesktopCopyResultMessage,
  type DesktopFacts,
  type DesktopHelloMessage,
  type DesktopBackupRootsResultMessage,
  type DesktopInspectResultMessage,
  type DesktopMaintainResultMessage,
  type DesktopMaintenanceHintMessage,
  type DesktopRestoreResultMessage,
  type DesktopPreflightResultMessage,
  type DesktopReadyMessage,
} from "@work-intelligence/schema";
import { normalizePathForCompare } from "@work-intelligence/shared/file-identity";
import { portFailureCode } from "@work-intelligence/shared/port-failure";
import {
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  verifyInstanceProof,
} from "@work-intelligence/shared/instance-proof";
import { runtimeErrorCode } from "../runtime/errors.js";
import type { LaunchPlan } from "../runtime/launch-plan.js";
import { compareDatabaseIdentity } from "../db-source/identity-compare.js";
import type { DatabaseIdentity } from "../db-source/types.js";
import { ChildChannel, type MessageOfType } from "./child-channel.js";
import { buildChildEnvironment } from "./child-environment.js";
import { BackendFailure, backendErrorCode, type BackendErrorCode } from "./errors.js";
import { LineCollector, LineRingBuffer, SecretMasker } from "./ring-buffer.js";
import {
  DEFAULT_BACKEND_TIMEOUTS,
  type BackendPreflightSummary,
  type BackendSupervisorDependencies,
  type BackendTimeouts,
  type SupervisedChild,
} from "./types.js";

export interface BackendStartRequest {
  /** 1-65535, already validated by the caller; the real bind stays the authority. */
  readonly port: number;
  /** The only database this start may open. */
  readonly databasePath: string;
  readonly expectedIdentity?: DatabaseIdentity;
  readonly backupDirectory?: string;
  readonly allowSchemaMigration?: boolean;
  /** Runs after a passing preflight and before `start` is sent, i.e. before anything can write the database. */
  readonly beforeStart?: (summary: BackendPreflightSummary) => Promise<void>;
  readonly desktop?: DesktopFacts;
  readonly environment?: Readonly<Record<string, string>>;
}

export type BackendActivityReport =
  | {
      readonly status: "known";
      readonly busy: readonly DesktopBackendActivity[];
      /** An uploaded import file waits unread; a restart discards it, so it is no reason to refuse a change. */
      readonly pendingImport: boolean;
    }
  | { readonly status: "unknown" };

/** `runId` is a secret of this main process: never log or persist it. */
export interface BackendInfo {
  readonly runId: string;
  readonly pid: number;
  readonly port: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly databaseIdentity: DatabaseIdentity;
  readonly execPath: string;
  readonly projectCount?: number;
}

export interface BackendStopReport {
  readonly graceful: boolean;
  readonly forced: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly exited: boolean;
  readonly portReleased: boolean;
  readonly wasRunning: boolean;
}

export type BackendStartResult =
  | { readonly status: "started"; readonly info: BackendInfo }
  /** A verified child already runs; no second one was started. The request is not compared: stop first to change it. */
  | { readonly status: "already-running"; readonly info: BackendInfo }
  | {
      readonly status: "failed";
      readonly code: BackendErrorCode;
      readonly detail: string;
      readonly stopped: BackendStopReport;
      readonly recentOutput: readonly string[];
    };

export type DatabasePreviewResult =
  | {
      readonly outcome: "checked";
      readonly preflight: DesktopPreflightResultMessage;
      readonly willMigrate: boolean;
    }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

export type DatabaseCopyOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopCopyResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

export type BackupInspectOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopInspectResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

/**
 * `failed`: the request never reached the child (database untouched). `unknown`: sent but no verdict came, so the
 * database may or may not have been replaced: the caller must look at the files.
 */
export type DatabaseRestoreOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopRestoreResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string }
  | { readonly outcome: "unknown"; readonly code: BackendErrorCode; readonly detail: string };

export type BackupRootsOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopBackupRootsResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

export type DatabaseMaintainOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopMaintainResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string }
  | { readonly outcome: "unknown"; readonly code: BackendErrorCode; readonly detail: string };

export type MaintenanceHintReport =
  | { readonly status: "unknown" }
  | ({ readonly status: "known" } & Omit<DesktopMaintenanceHintMessage, "type" | "requestId">);

export interface BackendExitEvent {
  readonly code: BackendErrorCode;
  readonly detail: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly info: BackendInfo;
  readonly recentOutput: readonly string[];
}

export interface BackendSupervisorOptions {
  readonly dependencies: BackendSupervisorDependencies;
  readonly timeouts?: Partial<BackendTimeouts>;
  readonly outputLines?: number;
  readonly log?: (line: string) => void;
  /** The directory the child starts in: fixed and writable by the user, never inherited from the parent process. */
  readonly workingDirectory?: string;
}

interface ActiveChild {
  readonly child: SupervisedChild;
  readonly channel: ChildChannel;
  readonly output: LineRingBuffer;
  readonly masker: SecretMasker;
  readonly port: number;
  readonly plannedExecutable: string;
  info: BackendInfo | undefined;
  readonly kind: "backend" | "preview";
  databaseIdentity?: DatabaseIdentity;
  healthTimer?: unknown;
}

const DESKTOP_IPC_ARGV = ["--desktop-ipc"] as const;
const HEALTH_ATTEMPTS = 3;
const HEALTH_RETRY_MS = 100;
/** Health checks in a row that must fail before a running backend is called stuck: a slow minute is not a hang. */
const MONITOR_STRIKES = 3;
const DEFAULT_OUTPUT_LINES = 200;
const ACTIVITY_QUERY_TIMEOUT_MS = 2000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
export const WORKING_DIRECTORY_FAILURE = "the working directory could not be created";

const NOT_RUNNING: BackendStopReport = {
  graceful: true,
  forced: false,
  exitCode: null,
  signal: null,
  exited: true,
  portReleased: true,
  wasRunning: false,
};

const PREFLIGHT_FAILURES: Readonly<Record<string, BackendErrorCode>> = {
  missing: "DB_MISSING",
  offline: "DB_OFFLINE",
  denied: "DB_PERMISSION",
  unreadable: "REPAIR_REQUIRED",
};

function preflightFailure(result: DesktopPreflightResultMessage): BackendFailure | undefined {
  if (result.status === "ok") return undefined;
  if (result.status === "unsupported-schema") {
    return result.compatibility === "newer-unsupported"
      ? new BackendFailure("SCHEMA_TOO_NEW", "the database schema is newer than this version supports")
      : new BackendFailure("REPAIR_REQUIRED", "the file is not a Work Intelligence database");
  }
  return new BackendFailure(
    PREFLIGHT_FAILURES[result.status] ?? "REPAIR_REQUIRED",
    `database preflight: ${result.status}`,
  );
}

function willMigrate(result: DesktopPreflightResultMessage): boolean {
  return result.compatibility === "empty" || result.compatibility === "older-needs-migration";
}

function describeUnexpected(error: unknown): BackendFailure {
  return error instanceof BackendFailure ? error : new BackendFailure("REPAIR_REQUIRED", "unexpected backend failure");
}

/** Operates only on the `ChildProcess` it spawned itself, never on a pid it was told about. It never restarts a child: an unexpected exit goes to `onUnexpectedExit` and the shell decides. */
export class BackendSupervisor {
  private readonly deps: BackendSupervisorDependencies;
  private readonly timeouts: BackendTimeouts;
  private readonly outputLines: number;
  private readonly log: (line: string) => void;
  private readonly exitListeners = new Set<(event: BackendExitEvent) => void>();
  private readonly backupListeners = new Set<(at: string, database: DatabaseIdentity) => void>();
  private previewing: Promise<unknown> | undefined;
  /** Preview children that are alive; `stop()` ends them too. */
  private readonly previews = new Set<ActiveChild>();
  /** Bumped by `stop()`: a preview queued before a stop never starts after it. */
  private previewGeneration = 0;
  private readonly openAgentSetupListeners = new Set<() => void>();
  private readonly setLanguageListeners = new Set<(locale: "zh-TW" | "en") => void>();
  private readonly openPortSettingsListeners = new Set<(request: { preferences?: unknown; route?: string }) => void>();
  private readonly changedListeners = new Set<(database: DatabaseIdentity) => void>();
  private readonly workingDirectory: string | undefined;
  private active: ActiveChild | undefined;
  private lastOutput: readonly string[] = [];
  private starting: Promise<BackendStartResult> | undefined;
  private stopping: Promise<BackendStopReport> | undefined;

  constructor(options: BackendSupervisorOptions) {
    this.deps = options.dependencies;
    this.timeouts = { ...DEFAULT_BACKEND_TIMEOUTS, ...options.timeouts };
    this.outputLines = options.outputLines ?? DEFAULT_OUTPUT_LINES;
    this.log = options.log ?? (() => undefined);
    this.workingDirectory = options.workingDirectory;
  }

  get running(): BackendInfo | undefined {
    return this.active && !this.stopping && !this.starting && this.isAlive(this.active) ? this.active.info : undefined;
  }

  get recentOutput(): readonly string[] {
    return this.active ? this.active.output.lines() : this.lastOutput;
  }

  onBackupCompleted(listener: (at: string, database: DatabaseIdentity) => void): () => void {
    this.backupListeners.add(listener);
    return () => this.backupListeners.delete(listener);
  }

  onBackupsChanged(listener: (database: DatabaseIdentity) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  onOpenAgentSetup(listener: () => void): () => void {
    this.openAgentSetupListeners.add(listener);
    return () => this.openAgentSetupListeners.delete(listener);
  }

  onSetLanguage(listener: (locale: "zh-TW" | "en") => void): () => void {
    this.setLanguageListeners.add(listener);
    return () => this.setLanguageListeners.delete(listener);
  }

  onOpenPortSettings(listener: (request: { preferences?: unknown; route?: string }) => void): () => void {
    this.openPortSettingsListeners.add(listener);
    return () => this.openPortSettingsListeners.delete(listener);
  }

  /** `unknown` (no verified backend, closed channel, or no answer in time): the caller treats it as busy. */
  async queryActivity(timeoutMs = ACTIVITY_QUERY_TIMEOUT_MS): Promise<BackendActivityReport> {
    const active = this.running ? this.active : undefined;
    if (!active) return { status: "unknown" };
    const requestId = this.deps.randomRunId().slice(0, 32);
    const answer = async (): Promise<{ busy: readonly DesktopBackendActivity[]; pendingImport: boolean }> => {
      await active.channel.send({ type: "activity-query", requestId });
      // A late answer to an earlier query carries another id: it is dropped and the wait goes on.
      for (;;) {
        const reply = await active.channel.expect("activity", timeoutMs);
        if (reply.requestId === requestId) return { busy: reply.busy, pendingImport: reply.pendingImport === true };
      }
    };
    const reply = await this.within(
      answer().catch(() => undefined),
      timeoutMs,
    );
    return reply === undefined ? { status: "unknown" } : { status: "known", ...reply };
  }

  async updateFacts(desktop: DesktopFacts): Promise<boolean> {
    const active = this.running ? this.active : undefined;
    if (!active) return false;
    try {
      await active.channel.send({ type: "update-facts", desktop });
      return true;
    } catch {
      return false;
    }
  }

  onUnexpectedExit(listener: (event: BackendExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Concurrent calls share one promise; a call during a stop waits for it first. */
  start(request: BackendStartRequest): Promise<BackendStartResult> {
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start(request));
    const running = this.running;
    if (running) return Promise.resolve({ status: "already-running", info: running });
    this.active = undefined;
    this.starting = this.launch(request).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** IPC `shutdown`, then SIGTERM (POSIX only), then a kill; on Windows `kill()` is TerminateProcess, the only escalation. */
  stop(): Promise<BackendStopReport> {
    this.previewGeneration += 1;
    // Before the child is spawned there is nothing to stop yet: let the start settle, then stop what it produced.
    const backend = !this.active && this.starting ? this.starting.then(() => this.stopCurrent()) : this.stopCurrent();
    if (this.previews.size === 0) return backend;
    // A preview child is this supervisor's child too: it is stopped and must be proven gone, or `exited` is false.
    return Promise.all([backend, this.stopPreviews()]).then(([report, previewsEnded]) =>
      previewsEnded ? report : { ...report, exited: false },
    );
  }

  private async stopPreviews(): Promise<boolean> {
    const alive = [...this.previews];
    if (alive.length === 0) return true;
    const reports = await Promise.all(alive.map((child) => this.terminate(child)));
    const ended = reports.every((report) => report.exited);
    if (!ended) this.log("a preview child did not exit after it was asked to stop and killed");
    return ended;
  }

  preview(databasePath: string, options: { quickCheck?: boolean } = {}): Promise<DatabasePreviewResult> {
    return this.previewMany([databasePath], options).then((results) => results[0] as DatabasePreviewResult);
  }

  previewMany(
    databasePaths: readonly string[],
    options: { quickCheck?: boolean } = {},
  ): Promise<DatabasePreviewResult[]> {
    return this.queuePreview(databasePaths, false, options.quickCheck === true);
  }

  createDatabase(databasePath: string): Promise<DatabasePreviewResult> {
    return this.queuePreview([databasePath], true, false).then((results) => results[0] as DatabasePreviewResult);
  }

  private queuePreview(
    databasePaths: readonly string[],
    createIfMissing: boolean,
    quickCheck: boolean,
  ): Promise<DatabasePreviewResult[]> {
    if (databasePaths.length === 0) return Promise.resolve([]);
    const generation = this.previewGeneration;
    return this.enqueuePreview(() => this.runPreview(databasePaths, generation, createIfMissing, quickCheck));
  }

  copyDatabase(source: string, target: string): Promise<DatabaseCopyOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(() => this.runCopy(source, target, generation));
  }

  inspectBackups(request: {
    readonly databasePath: string;
    readonly backupDirectory?: string;
    readonly files?: readonly string[];
    readonly integrity?: boolean;
    readonly limit?: number;
  }): Promise<BackupInspectOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(() => this.runInspect(request, generation));
  }

  /**
   * Call only with the backend stopped, as the operation's step; it waits for the preview queue so it never overlaps a
   * preview.
   */
  restoreDatabase(request: {
    readonly source: string;
    readonly databasePath: string;
    readonly backupDirectory?: string;
    readonly remap?: readonly { readonly from: string; readonly to: string }[];
  }): Promise<DatabaseRestoreOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(() => this.runRestore(request, generation));
  }

  backupRoots(source: string, databasePath: string): Promise<BackupRootsOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(async (): Promise<BackupRootsOutcome> => {
      try {
        const result = await this.askPreview(
          databasePath,
          generation,
          { type: "backup-roots", source },
          "backup-roots-result",
          this.timeouts.quickCheckMs,
        );
        return { outcome: "checked", result: result.reply };
      } catch (error) {
        const failure = describeUnexpected(error);
        return { outcome: "failed", code: failure.code, detail: failure.detail };
      }
    });
  }

  maintainDatabase(request: {
    readonly mode: "maintain" | "check";
    readonly databasePath: string;
    readonly backupDirectory?: string;
  }): Promise<DatabaseMaintainOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(async (): Promise<DatabaseMaintainOutcome> => {
      let sent = false;
      try {
        // No timer for the work: a compaction is never killed because it takes long. The read-only check keeps its deadline so a
        // stuck preview child cannot hold the page-action lock for good.
        const { reply } = await this.askPreview(
          request.databasePath,
          generation,
          {
            type: "maintain-database",
            mode: request.mode,
            databasePath: request.databasePath,
            ...(request.backupDirectory ? { backupDirectory: request.backupDirectory } : {}),
          },
          "maintain-result",
          request.mode === "check" ? this.timeouts.quickCheckMs : null,
          () => {
            sent = true;
          },
        );
        return { outcome: "checked", result: reply };
      } catch (error) {
        const failure = describeUnexpected(error);
        // A read-only check changes nothing, so even after the request was sent (a deadline passed) the result is a plain
        // failure, never "unknown".
        return {
          outcome: sent && request.mode === "maintain" ? "unknown" : "failed",
          code: failure.code,
          detail: failure.detail,
        };
      }
    });
  }

  async queryMaintenanceHint(timeoutMs = ACTIVITY_QUERY_TIMEOUT_MS): Promise<MaintenanceHintReport> {
    const active = this.running ? this.active : undefined;
    if (!active) return { status: "unknown" };
    const requestId = this.deps.randomRunId().slice(0, 32);
    const answer = async (): Promise<DesktopMaintenanceHintMessage> => {
      await active.channel.send({ type: "maintenance-hint-query", requestId });
      for (;;) {
        const reply = await active.channel.expect("maintenance-hint", timeoutMs);
        if (reply.requestId === requestId) return reply;
      }
    };
    const reply = await this.within(
      answer().catch(() => undefined),
      timeoutMs,
    );
    if (reply === undefined) return { status: "unknown" };
    const { type: _type, requestId: _id, ...hint } = reply;
    return { status: "known", ...hint };
  }

  private async askPreview<K extends "backup-roots-result" | "maintain-result">(
    databasePath: string,
    generation: number,
    message: Record<string, unknown>,
    replyType: K,
    timeoutMs: number | null,
    onSent?: () => void,
  ): Promise<{ reply: MessageOfType<K> }> {
    let child: ActiveChild | undefined;
    try {
      if (generation !== this.previewGeneration) {
        throw new BackendFailure("REPAIR_REQUIRED", "the request was cancelled because the backend was stopped");
      }
      child = await this.spawnChild(
        { port: 0, databasePath },
        this.deps.randomRunId(),
        this.deps.randomChallenge(),
        "preview",
      );
      this.verifyHello(await child.channel.expect("hello", this.timeouts.helloMs), child);
      await child.channel.send(message);
      onSent?.();
      return { reply: await child.channel.expect(replyType, timeoutMs) };
    } finally {
      if (child) {
        const ended = await this.terminate(child);
        this.previews.delete(child);
        if (!ended.exited) this.log("a preview child did not exit after it was asked to stop and killed");
      }
    }
  }

  private async runInspect(
    request: {
      readonly databasePath: string;
      readonly backupDirectory?: string;
      readonly files?: readonly string[];
      readonly integrity?: boolean;
      readonly limit?: number;
    },
    generation: number,
  ): Promise<BackupInspectOutcome> {
    let child: ActiveChild | undefined;
    try {
      if (generation !== this.previewGeneration) {
        throw new BackendFailure("REPAIR_REQUIRED", "the look was cancelled because the backend was stopped");
      }
      child = await this.spawnChild(
        { port: 0, databasePath: request.databasePath },
        this.deps.randomRunId(),
        this.deps.randomChallenge(),
        "preview",
      );
      this.verifyHello(await child.channel.expect("hello", this.timeouts.helloMs), child);
      await child.channel.send({
        type: "inspect-backups",
        databasePath: request.databasePath,
        ...(request.backupDirectory ? { backupDirectory: request.backupDirectory } : {}),
        ...(request.files ? { files: [...request.files] } : {}),
        ...(request.integrity === undefined ? {} : { integrity: request.integrity }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return {
        outcome: "checked",
        result: await child.channel.expect("inspect-result", this.timeouts.quickCheckMs),
      };
    } catch (error) {
      const failure = describeUnexpected(error);
      return { outcome: "failed", code: failure.code, detail: failure.detail };
    } finally {
      if (child) {
        const ended = await this.terminate(child);
        this.previews.delete(child);
        if (!ended.exited) this.log("a preview child did not exit after it was asked to stop and killed");
      }
    }
  }

  private async runRestore(
    request: {
      readonly source: string;
      readonly databasePath: string;
      readonly backupDirectory?: string;
      readonly remap?: readonly { readonly from: string; readonly to: string }[];
    },
    generation: number,
  ): Promise<DatabaseRestoreOutcome> {
    let child: ActiveChild | undefined;
    let sent = false;
    try {
      if (generation !== this.previewGeneration) {
        throw new BackendFailure("REPAIR_REQUIRED", "the restore was cancelled because the backend was stopped");
      }
      child = await this.spawnChild(
        { port: 0, databasePath: request.databasePath },
        this.deps.randomRunId(),
        this.deps.randomChallenge(),
        "preview",
      );
      this.verifyHello(await child.channel.expect("hello", this.timeouts.helloMs), child);
      await child.channel.send({
        type: "restore-database",
        source: request.source,
        databasePath: request.databasePath,
        ...(request.backupDirectory ? { backupDirectory: request.backupDirectory } : {}),
        ...(request.remap && request.remap.length > 0 ? { remap: request.remap.map((entry) => ({ ...entry })) } : {}),
      });
      sent = true;
      // No timer: a restoring child is never killed because it takes long.
      return { outcome: "checked", result: await child.channel.expect("restore-result", null) };
    } catch (error) {
      const failure = describeUnexpected(error);
      return { outcome: sent ? "unknown" : "failed", code: failure.code, detail: failure.detail };
    } finally {
      if (child) {
        const ended = await this.terminate(child);
        this.previews.delete(child);
        if (!ended.exited) this.log("a preview child did not exit after it was asked to stop and killed");
      }
    }
  }

  private enqueuePreview<T>(run: () => Promise<T>): Promise<T> {
    const next = this.previewing ? this.previewing.then(run, run) : run();
    // The tracking chain swallows its own outcome: the caller of `preview` is the only one who sees a rejection.
    let settled: Promise<void> | undefined;
    const clear = (): void => {
      if (this.previewing === settled) this.previewing = undefined;
    };
    settled = next.then(clear, clear);
    this.previewing = settled;
    return next;
  }

  private async runPreview(
    databasePaths: readonly string[],
    generation: number,
    createIfMissing: boolean,
    quickCheck: boolean,
  ): Promise<DatabasePreviewResult[]> {
    const results: DatabasePreviewResult[] = [];
    let child: ActiveChild | undefined;
    try {
      if (generation !== this.previewGeneration) {
        throw new BackendFailure("REPAIR_REQUIRED", "the preview was cancelled because the backend was stopped");
      }
      const first = databasePaths[0] as string;
      const request: BackendStartRequest = { port: 0, databasePath: first };
      child = await this.spawnChild(request, this.deps.randomRunId(), this.deps.randomChallenge(), "preview");
      this.verifyHello(await child.channel.expect("hello", this.timeouts.helloMs), child);
      for (const databasePath of databasePaths) {
        await child.channel.send({
          type: "preflight",
          path: databasePath,
          ...(createIfMissing ? { createIfMissing: true as const } : {}),
          ...(quickCheck ? { quickCheck: true as const } : {}),
        });
        const preflight = await child.channel.expect(
          "preflight-result",
          quickCheck ? this.timeouts.quickCheckMs : this.timeouts.preflightMs,
        );
        // An `ok` verdict without the database's identity is not a verdict; it fails this path only.
        if (preflight.status === "ok") {
          try {
            this.verifyPreflight(preflight, { port: 0, databasePath });
          } catch (error) {
            const failure = describeUnexpected(error);
            results.push({ outcome: "failed", code: failure.code, detail: failure.detail });
            continue;
          }
        }
        results.push({
          outcome: "checked",
          preflight,
          willMigrate: preflight.status === "ok" && willMigrate(preflight),
        });
      }
      return results;
    } catch (error) {
      const failure = describeUnexpected(error);
      while (results.length < databasePaths.length) {
        results.push({ outcome: "failed", code: failure.code, detail: failure.detail });
      }
      return results;
    } finally {
      if (child) {
        const ended = await this.terminate(child);
        this.previews.delete(child);
        if (!ended.exited) this.log("a preview child did not exit after it was asked to stop and killed");
      }
    }
  }

  private async runCopy(source: string, target: string, generation: number): Promise<DatabaseCopyOutcome> {
    let child: ActiveChild | undefined;
    try {
      if (generation !== this.previewGeneration) {
        throw new BackendFailure("REPAIR_REQUIRED", "the copy was cancelled because the backend was stopped");
      }
      child = await this.spawnChild(
        { port: 0, databasePath: source },
        this.deps.randomRunId(),
        this.deps.randomChallenge(),
        "preview",
      );
      this.verifyHello(await child.channel.expect("hello", this.timeouts.helloMs), child);
      await child.channel.send({ type: "copy-database", source, target });
      const result = await child.channel.expect("copy-result", this.timeouts.copyMs);
      return { outcome: "checked", result };
    } catch (error) {
      const failure = describeUnexpected(error);
      return { outcome: "failed", code: failure.code, detail: failure.detail };
    } finally {
      if (child) {
        const ended = await this.terminate(child);
        this.previews.delete(child);
        if (!ended.exited) this.log("a preview child did not exit after it was asked to stop and killed");
      }
    }
  }

  private stopCurrent(): Promise<BackendStopReport> {
    if (this.stopping) return this.stopping;
    const active = this.active;
    if (!active) return Promise.resolve(NOT_RUNNING);
    this.stopping = this.terminate(active).finally(() => {
      this.lastOutput = active.output.lines();
      this.active = undefined;
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async launch(request: BackendStartRequest): Promise<BackendStartResult> {
    try {
      const info = await this.bringUp(request);
      return { status: "started", info };
    } catch (error) {
      const failure = describeUnexpected(error);
      const stopped = await this.stopCurrent();
      return {
        status: "failed",
        code: failure.code,
        detail: failure.detail,
        stopped,
        recentOutput: this.recentOutput,
      };
    }
  }

  private async bringUp(request: BackendStartRequest): Promise<BackendInfo> {
    if (!Number.isInteger(request.port) || request.port < MIN_PORT || request.port > MAX_PORT) {
      throw new BackendFailure("REPAIR_REQUIRED", "the port is not an integer from 1 to 65535");
    }
    const probe = await this.probePort(request.port);
    if (!probe.free) {
      throw probe.code === "PORT_NOT_PERMITTED"
        ? new BackendFailure("PORT_NOT_PERMITTED", `127.0.0.1:${request.port} cannot be bound by this user`)
        : new BackendFailure("PORT_OCCUPIED_BY_OTHER", `127.0.0.1:${request.port} is already in use`);
    }
    const runId = this.deps.randomRunId();
    const challenge = this.deps.randomChallenge();
    const active = await this.spawnChild(request, runId, challenge);
    const { channel } = active;
    const hello = await channel.expect("hello", this.timeouts.helloMs);
    this.verifyHello(hello, active);

    await channel.send({ type: "preflight", path: request.databasePath });
    const preflight = await channel.expect("preflight-result", this.timeouts.preflightMs);
    const identity = this.verifyPreflight(preflight, request);
    this.maskPath(active.masker, identity.realPath);
    active.databaseIdentity = identity;
    await this.runBeforeStart(request, preflight, identity);

    await channel.send({
      type: "start",
      runId,
      port: request.port,
      database: { path: request.databasePath, identity },
      ...(request.backupDirectory ? { backupDirectory: request.backupDirectory } : {}),
      ...(request.desktop ? { desktop: request.desktop } : {}),
    });
    const ready = await channel.expect("ready", this.timeouts.readyMs);
    this.verifyReady(ready, { runId, port: request.port, identity }, active);
    await this.verifyHttp(request.port, runId, challenge, channel);

    const info: BackendInfo = {
      runId,
      pid: ready.pid,
      port: ready.port,
      appVersion: ready.appVersion,
      schemaVersion: ready.schemaVersion,
      databaseIdentity: ready.databaseIdentity,
      execPath: ready.execPath,
      ...(ready.projectCount !== undefined ? { projectCount: ready.projectCount } : {}),
    };
    active.info = info;
    this.watchForUnexpectedExit(active);
    this.watchHealth(active, runId);
    return info;
  }

  private async spawnChild(
    request: BackendStartRequest,
    runId: string,
    challenge: string,
    kind: ActiveChild["kind"] = "backend",
  ): Promise<ActiveChild> {
    await this.ensureWorkingDirectory();
    const environment = buildChildEnvironment({
      platform: this.deps.platform,
      parentEnvironment: this.deps.parentEnvironment,
      ...(request.environment ? { desktopValues: request.environment } : {}),
    });
    let plan: LaunchPlan;
    try {
      plan = await this.deps.planLaunch(DESKTOP_IPC_ARGV, environment);
    } catch (error) {
      const reason = runtimeErrorCode(error);
      if (reason) throw new BackendFailure(reason, `the runtime was refused (${reason})`, { cause: error });
      throw new BackendFailure("RUNTIME_MISSING", "the runtime could not be verified", { cause: error });
    }
    const child = this.deps.spawn(plan.command, plan.args, {
      env: plan.env as NodeJS.ProcessEnv,
      shell: false,
      ...(this.workingDirectory ? { cwd: this.workingDirectory } : {}),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const output = new LineRingBuffer(this.outputLines);
    const masker = this.buildMasker(request, runId, challenge);
    const channel = new ChildChannel(child, this.deps, this.log);
    const active: ActiveChild = {
      child,
      channel,
      output,
      masker,
      port: request.port,
      plannedExecutable: plan.command,
      info: undefined,
      kind,
    };
    if (kind === "backend") {
      this.active = active;
      channel.onBackupCompleted((at) => {
        const database = active.databaseIdentity;
        if (database) this.notify(this.backupListeners, (listener) => listener(at, database));
      });
      channel.onBackupsChanged(() => {
        const database = active.databaseIdentity;
        if (database) this.notify(this.changedListeners, (listener) => listener(database));
      });
      channel.onOpenAgentSetup(() => this.notify(this.openAgentSetupListeners, (listener) => listener()));
      channel.onOpenPortSettings((request) =>
        this.notify(this.openPortSettingsListeners, (listener) => listener(request)),
      );
      channel.onSetLanguage((locale) => this.notify(this.setLanguageListeners, (listener) => listener(locale)));
    } else {
      this.previews.add(active);
    }
    for (const stream of [child.stdout, child.stderr]) {
      const collector = new LineCollector(output, masker);
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer | string) =>
        collector.write(typeof chunk === "string" ? chunk : decoder.write(chunk)),
      );
      stream?.on("end", () => collector.flush());
    }
    return active;
  }

  private async ensureWorkingDirectory(): Promise<void> {
    if (!this.workingDirectory || !this.deps.ensureDirectory) return;
    try {
      await this.deps.ensureDirectory(this.workingDirectory);
    } catch (error) {
      throw new BackendFailure("REPAIR_REQUIRED", WORKING_DIRECTORY_FAILURE, { cause: error });
    }
  }

  private notify<T>(listeners: ReadonlySet<T>, call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (error) {
        this.log(`a listener failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  private buildMasker(request: BackendStartRequest, runId: string, challenge: string): SecretMasker {
    const masker = new SecretMasker({ caseInsensitive: this.deps.platform === "win32" });
    masker.add(runId);
    masker.add(challenge);
    this.maskPath(masker, request.databasePath);
    if (request.backupDirectory) this.maskPath(masker, request.backupDirectory);
    const { parentEnvironment } = this.deps;
    for (const home of [parentEnvironment.HOME, parentEnvironment.USERPROFILE]) {
      if (home) this.maskPath(masker, home);
    }
    return masker;
  }

  /** A path as given and as the file system resolves it (a symlink or an 8.3 name prints as the real one). */
  private maskPath(masker: SecretMasker, path: string): void {
    masker.add(path);
    try {
      masker.add(this.deps.realpath(path));
    } catch {
      // A path that does not resolve (yet) is still masked as written.
    }
  }

  private verifyHello(hello: DesktopHelloMessage, active: ActiveChild): void {
    if (hello.protocolVersion !== DESKTOP_CHILD_PROTOCOL_VERSION) {
      throw new BackendFailure(
        "REPAIR_REQUIRED",
        `protocol version ${hello.protocolVersion} is not the supported ${DESKTOP_CHILD_PROTOCOL_VERSION}`,
      );
    }
    this.verifyProcess(hello, active);
  }

  /** The child that answers must be the very process this supervisor spawned, running the executable it planned. */
  private verifyProcess(message: { pid: number; execPath: string }, active: ActiveChild): void {
    if (message.pid !== active.child.pid) {
      throw new BackendFailure("SERVICE_IDENTITY_MISMATCH", "the reported process id is not the spawned child's");
    }
    if (!this.sameExecutable(message.execPath, active.plannedExecutable)) {
      throw new BackendFailure("SERVICE_IDENTITY_MISMATCH", "the child runs a different executable than planned");
    }
  }

  private verifyPreflight(result: DesktopPreflightResultMessage, request: BackendStartRequest): DatabaseIdentity {
    const failure = preflightFailure(result);
    if (failure) throw failure;
    if (!result.identity) throw new BackendFailure("REPAIR_REQUIRED", "the preflight returned no database identity");
    if (request.expectedIdentity) {
      const comparison = compareDatabaseIdentity(request.expectedIdentity, result.identity, this.deps.platform);
      if (!comparison.same) {
        throw new BackendFailure("DB_IDENTITY_CHANGED", `the database is not the confirmed one (${comparison.reason})`);
      }
    }
    return result.identity;
  }

  private async runBeforeStart(
    request: BackendStartRequest,
    result: DesktopPreflightResultMessage,
    identity: DatabaseIdentity,
  ): Promise<void> {
    const migrates = willMigrate(result);
    if (migrates && !request.allowSchemaMigration) {
      throw new BackendFailure("SCHEMA_MIGRATION_BLOCKED", "the database needs a schema update that was not approved");
    }
    try {
      await request.beforeStart?.({ identity, schemaVersion: result.schemaVersion, willMigrate: migrates });
    } catch (error) {
      throw new BackendFailure(backendErrorCode(error), "the step before starting the backend failed", {
        cause: error,
      });
    }
  }

  private verifyReady(
    ready: DesktopReadyMessage,
    expected: { runId: string; port: number; identity: DatabaseIdentity },
    active: ActiveChild,
  ): void {
    if (ready.protocolVersion !== DESKTOP_CHILD_PROTOCOL_VERSION) {
      throw new BackendFailure("REPAIR_REQUIRED", "the ready message has another protocol version");
    }
    if (ready.runId !== expected.runId || ready.port !== expected.port) {
      throw new BackendFailure("SERVICE_IDENTITY_MISMATCH", "ready does not carry this start's run id and port");
    }
    this.verifyProcess(ready, active);
    // The store may have migrated the database, so `ready` carries a re-read identity: same file, and a known lineage unchanged.
    const comparison = compareDatabaseIdentity(
      { ...expected.identity, lineageId: null },
      { ...ready.databaseIdentity, lineageId: null },
      this.deps.platform,
    );
    if (!comparison.same) {
      throw new BackendFailure("DB_IDENTITY_CHANGED", `the child opened another database (${comparison.reason})`);
    }
    if (expected.identity.lineageId !== null && ready.databaseIdentity.lineageId !== expected.identity.lineageId) {
      throw new BackendFailure("DB_IDENTITY_CHANGED", "the child opened another database (lineage-changed)");
    }
  }

  /** HTTP readiness: the port must answer with the HMAC of a fresh challenge, which only this child can compute. */
  private async verifyHttp(port: number, runId: string, challenge: string, channel: ChildChannel): Promise<void> {
    const url = `http://127.0.0.1:${port}/api/health`;
    for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
      if (channel.endedFailure) throw channel.endedFailure;
      try {
        const response = await this.deps.fetchHealth(
          url,
          { [INSTANCE_CHALLENGE_HEADER]: challenge },
          this.timeouts.healthMs,
        );
        if (!verifyInstanceProof(runId, challenge, response.header(INSTANCE_PROOF_HEADER))) {
          throw new BackendFailure("SERVICE_IDENTITY_MISMATCH", "the port did not prove it is this backend");
        }
        if (response.status !== 200) {
          throw new BackendFailure("REPAIR_REQUIRED", `the health endpoint answered ${response.status}`);
        }
        return;
      } catch (error) {
        if (error instanceof BackendFailure) throw error;
        if (channel.endedFailure) throw channel.endedFailure;
        if (attempt === HEALTH_ATTEMPTS) {
          throw new BackendFailure("CHILD_START_TIMEOUT", "the health endpoint did not answer");
        }
        await this.sleep(HEALTH_RETRY_MS);
      }
    }
  }

  private watchHealth(active: ActiveChild, runId: string): void {
    const every = this.timeouts.monitorMs;
    if (every <= 0) return;
    let strikes = 0;
    const arm = (): void => {
      const handle = this.deps.setTimer(() => {
        active.healthTimer = undefined;
        if (this.active !== active || this.stopping) return;
        void this.answers(active.port, runId).then((answered) => {
          if (this.active !== active || this.stopping) return;
          strikes = answered ? 0 : strikes + 1;
          if (strikes < MONITOR_STRIKES) return arm();
          this.reportUnresponsive(active);
        });
      }, every);
      (handle as { unref?: () => void } | undefined)?.unref?.();
      active.healthTimer = handle;
    };
    arm();
  }

  private async answers(port: number, runId: string): Promise<boolean> {
    const challenge = this.deps.randomChallenge();
    try {
      const response = await this.deps.fetchHealth(
        `http://127.0.0.1:${port}/api/health`,
        { [INSTANCE_CHALLENGE_HEADER]: challenge },
        this.timeouts.healthMs,
      );
      return response.status === 200 && verifyInstanceProof(runId, challenge, response.header(INSTANCE_PROOF_HEADER));
    } catch {
      return false;
    }
  }

  private reportUnresponsive(active: ActiveChild): void {
    const { info } = active;
    if (!info) return;
    this.log("[backend] the backend stopped answering health checks; ending it");
    const recentOutput = active.output.lines();
    // No catch on purpose: `stopCurrent` wraps `terminate`, which reports a child that will not die in its result instead of
    // throwing, and the caller checked `stopping` before the timer ran, so a second stop is never started here.
    void this.stopCurrent().then((report) => {
      this.notify(this.exitListeners, (listener) =>
        listener({
          code: "CHILD_EXITED",
          detail: "the backend stopped answering health checks",
          exitCode: report.exitCode,
          signal: report.signal,
          info,
          recentOutput,
        }),
      );
    });
  }

  private watchForUnexpectedExit(active: ActiveChild): void {
    void active.channel.exited.then((exit) => {
      const { info } = active;
      if (this.active !== active || this.stopping || !info) return;
      this.lastOutput = active.output.lines();
      this.active = undefined;
      const failure = active.channel.lastReportedFailure;
      const event: BackendExitEvent = {
        code: failure?.code ?? "CHILD_EXITED",
        detail: failure?.detail ?? "the backend exited without being stopped",
        exitCode: exit.exitCode,
        signal: exit.signal,
        info,
        recentOutput: this.lastOutput,
      };
      this.notify(this.exitListeners, (listener) => listener(event));
    });
  }

  private async terminate(active: ActiveChild): Promise<BackendStopReport> {
    const { child, channel } = active;
    if (active.healthTimer !== undefined) this.deps.clearTimer(active.healthTimer);
    active.healthTimer = undefined;
    const { platform } = this.deps;
    let exit = channel.exitInfo;
    let graceful = false;
    let forced = false;
    if (!exit) {
      await channel.send({ type: "shutdown" }).catch(() => undefined);
      exit = await this.within(channel.exited, this.timeouts.gracefulMs);
      graceful = exit !== undefined && exit.exitCode === 0 && exit.signal === null;
    }
    // Windows has no SIGTERM: kill() is TerminateProcess, so it is the one and only escalation there.
    if (!exit && platform !== "win32") {
      this.tryKill(child, "SIGTERM");
      exit = await this.within(channel.exited, this.timeouts.terminateMs);
    }
    if (!exit) {
      forced = true;
      // Windows: the tree first, so the import worker does not outlive its parent and keep writing a switched-away database.
      if (platform === "win32" && child.pid !== undefined) await this.tryKillTree(child.pid);
      this.tryKill(child, platform === "win32" ? undefined : "SIGKILL");
      exit = await this.within(channel.exited, this.timeouts.killMs);
    }
    const portReleased = exit ? active.kind === "preview" || (await this.waitForPortFree(active.port)) : false;
    return {
      graceful,
      forced,
      exitCode: exit?.exitCode ?? null,
      signal: exit?.signal ?? null,
      exited: exit !== undefined,
      portReleased,
      wasRunning: true,
    };
  }

  /** `taskkill /T` needs the root alive to walk from, so the plain kill must come after it, not beside it. */
  private async tryKillTree(pid: number): Promise<void> {
    try {
      await this.within(Promise.resolve(this.deps.killTree?.(pid)), this.timeouts.killMs);
    } catch {
      // The plain kill that follows still ends the child itself.
    }
  }

  /** A kill that throws or returns false changes nothing: only the exit event proves the child ended. */
  private tryKill(child: SupervisedChild, signal: NodeJS.Signals | undefined): void {
    try {
      child.kill(signal);
    } catch {
      // The report says `exited: false` when no exit event follows.
    }
  }

  private async probePort(
    port: number,
  ): Promise<
    { readonly free: true } | { readonly free: false; readonly code: "PORT_NOT_PERMITTED" | "PORT_OCCUPIED_BY_OTHER" }
  > {
    if (this.deps.probePort) {
      const probe = await this.deps.probePort(port);
      return probe.free ? probe : { free: false, code: portFailureCode(probe.code) };
    }
    return (await this.deps.isPortFree(port)) ? { free: true } : { free: false, code: "PORT_OCCUPIED_BY_OTHER" };
  }

  private async waitForPortFree(port: number): Promise<boolean> {
    for (let waited = 0; ; waited += this.timeouts.pollMs) {
      if (await this.deps.isPortFree(port)) return true;
      if (waited >= this.timeouts.portReleaseMs) return false;
      await this.sleep(this.timeouts.pollMs);
    }
  }

  private async within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let handle: unknown;
    const timeout = new Promise<undefined>((resolve) => {
      handle = this.deps.setTimer(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      this.deps.clearTimer(handle);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.deps.setTimer(resolve, ms);
    });
  }

  private isAlive(active: ActiveChild): boolean {
    return active.child.exitCode === null && active.child.signalCode === null;
  }

  private sameExecutable(reported: string, planned: string): boolean {
    const resolve = (path: string): string => {
      try {
        return this.deps.realpath(path);
      } catch {
        return path;
      }
    };
    return (
      normalizePathForCompare(resolve(reported), this.deps.platform) ===
      normalizePathForCompare(resolve(planned), this.deps.platform)
    );
  }
}
