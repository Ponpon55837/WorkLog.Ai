import { StringDecoder } from "node:string_decoder";
import {
  DESKTOP_CHILD_PROTOCOL_VERSION,
  type DesktopBackendActivity,
  type DesktopCopyResultMessage,
  type DesktopFacts,
  type DesktopHelloMessage,
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
import { ChildChannel } from "./child-channel.js";
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
  /** The identity the user confirmed; when set, the preflight must find the same database. */
  readonly expectedIdentity?: DatabaseIdentity;
  readonly backupDirectory?: string;
  /** The user approved writing the schema (migrating an older file, or setting up an empty one). Default false. */
  readonly allowSchemaMigration?: boolean;
  /** Runs after a passing preflight and before `start` is sent, i.e. before anything can write the database. */
  readonly beforeStart?: (summary: BackendPreflightSummary) => Promise<void>;
  /** Facts the shell knows (for example a legacy login service); forwarded to the child inside `start`. */
  readonly desktop?: DesktopFacts;
  /** Extra `WORK_INTELLIGENCE_*` variables for the child. */
  readonly environment?: Readonly<Record<string, string>>;
}

/** What the running backend said it is busy with; `unknown` means it could not be asked in time. */
export type BackendActivityReport =
  | {
      readonly status: "known";
      readonly busy: readonly DesktopBackendActivity[];
      /** An uploaded import file waits unread; a restart discards it, so it is no reason to refuse a change. */
      readonly pendingImport: boolean;
    }
  | { readonly status: "unknown" };

/** What a verified, running backend looks like. `runId` is a secret of this main process: never log or persist it. */
export interface BackendInfo {
  readonly runId: string;
  readonly pid: number;
  readonly port: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly databaseIdentity: DatabaseIdentity;
  readonly execPath: string;
  /** Projects in the database when it started; absent when the child could not say. */
  readonly projectCount?: number;
}

export interface BackendStopReport {
  /** The child finished through the IPC `shutdown` and exited 0 on its own. */
  readonly graceful: boolean;
  /** The last resort (kill) was needed. */
  readonly forced: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The exit event of the child process was received. */
  readonly exited: boolean;
  /** The port could be bound again before the deadline. */
  readonly portReleased: boolean;
  /** False when there was no child to stop. */
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
      /** The child was stopped before this returned; its report says whether the port is free again. */
      readonly stopped: BackendStopReport;
      readonly recentOutput: readonly string[];
    };

/**
 * What a read-only preview of a database found. `failed` means the check itself could not run (no runtime, the child did
 * not answer); `checked` carries the child's preflight verdict.
 */
export type DatabasePreviewResult =
  | {
      readonly outcome: "checked";
      readonly preflight: DesktopPreflightResultMessage;
      /** Opening it would write the schema (an empty file, or an older version). */
      readonly willMigrate: boolean;
    }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

/** What a copy asked of a preview child came to: the child's verdict, or a failure of the child itself. */
export type DatabaseCopyOutcome =
  | { readonly outcome: "checked"; readonly result: DesktopCopyResultMessage }
  | { readonly outcome: "failed"; readonly code: BackendErrorCode; readonly detail: string };

/** A backend that was running and ended without a `stop()`. The shell moves to NEEDS_REPAIR; no restart happens here. */
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
  /** How many output lines to keep for diagnostics (default 200). */
  readonly outputLines?: number;
  /** Diagnostic lines of the supervisor itself (never a secret). */
  readonly log?: (line: string) => void;
  /** The directory the child starts in: fixed and writable by the user, never inherited from the parent process. */
  readonly workingDirectory?: string;
}

interface ActiveChild {
  readonly child: SupervisedChild;
  readonly channel: ChildChannel;
  readonly output: LineRingBuffer;
  /** Masks the run id, challenge and every known path in the child's output before it is stored. */
  readonly masker: SecretMasker;
  readonly port: number;
  /** The executable the launch plan named; the child's own `hello` must report the same one. */
  readonly plannedExecutable: string;
  info: BackendInfo | undefined;
  /** `backend` is the one managed child; `preview` is a short-lived read-only child that never listens. */
  readonly kind: "backend" | "preview";
  /** The identity the preflight read; backup reports are attributed to it. */
  databaseIdentity?: DatabaseIdentity;
}

const DESKTOP_IPC_ARGV = ["--desktop-ipc"] as const;
const HEALTH_ATTEMPTS = 3;
const HEALTH_RETRY_MS = 100;
const DEFAULT_OUTPUT_LINES = 200;
const ACTIVITY_QUERY_TIMEOUT_MS = 2000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
/** The fixed text of the failure when the child's working directory cannot be created. */
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

/** Preflight statuses that stop a start, and the code each one means. */
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

/**
 * Starts, verifies and stops the one backend child of the desktop App (R4 section 5.1, C-08). It operates only on the
 * `ChildProcess` handle it spawned itself (never on a pid it was told about) and brings the child up in the fixed order:
 * port hint, spawn with an allowlisted environment, `hello`, read-only database preflight, `start`, `ready`, then an
 * HTTP request that must carry the child's HMAC proof. A child that fails any step is stopped before `start()` returns.
 *
 * It never restarts a child on its own: an unexpected exit is reported through `onUnexpectedExit` and the shell decides
 * (R4 section 6 point 4's bounded retry is the shell's policy, because a restart is an operation under the coordinator).
 */
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

  /** The verified running backend, or undefined (starting, stopping, stopped or crashed). */
  get running(): BackendInfo | undefined {
    return this.active && !this.stopping && !this.starting && this.isAlive(this.active) ? this.active.info : undefined;
  }

  /** The most recent captured output lines of the current or last child, oldest first. */
  get recentOutput(): readonly string[] {
    return this.active ? this.active.output.lines() : this.lastOutput;
  }

  /**
   * Subscribes to the backups the running backend completes (UTC ISO instant), with the identity of the database that made
   * them; returns the unsubscribe function.
   */
  onBackupCompleted(listener: (at: string, database: DatabaseIdentity) => void): () => void {
    this.backupListeners.add(listener);
    return () => this.backupListeners.delete(listener);
  }

  /**
   * Subscribes to "the backups of the running database may have changed" (any API call that can write or delete a backup
   * file); the shell reacts by forgetting what it cached. Returns the unsubscribe function.
   */
  onBackupsChanged(listener: (database: DatabaseIdentity) => void): () => void {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  /** Subscribes to the web UI asking the App to open its Agent setup (from the running backend only). */
  onOpenAgentSetup(listener: () => void): () => void {
    this.openAgentSetupListeners.add(listener);
    return () => this.openAgentSetupListeners.delete(listener);
  }

  /** Subscribes to the web UI asking the App to open its port settings (from the running backend only). */
  onOpenPortSettings(listener: (request: { preferences?: unknown; route?: string }) => void): () => void {
    this.openPortSettingsListeners.add(listener);
    return () => this.openPortSettingsListeners.delete(listener);
  }

  /**
   * Asks the running backend which long jobs it is doing (import, backup, export, restore) and whether an idle import preview waits. `unknown` when no verified
   * backend runs, the channel is closed, or no answer comes within `timeoutMs`: the caller treats that as busy.
   */
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

  /**
   * Replaces the desktop facts of the running backend (facts the App learns after the start, such as a risky storage
   * verdict). False when no verified backend runs or the channel is closed; nothing else changes.
   */
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

  /** Subscribes to unexpected exits; returns the unsubscribe function. */
  onUnexpectedExit(listener: (event: BackendExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Starts the backend. Concurrent calls share one promise; a call while a verified child runs returns
   * `already-running` and spawns nothing; a call during a stop waits for it first.
   */
  start(request: BackendStartRequest): Promise<BackendStartResult> {
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start(request));
    const running = this.running;
    if (running) return Promise.resolve({ status: "already-running", info: running });
    // A child that died before its exit was noticed is not a child any more.
    this.active = undefined;
    this.starting = this.launch(request).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * Stops this supervisor's child in three escalating steps, each ended by the child's exit event: the IPC `shutdown`
   * (the child drains HTTP, closes the worker and SQLite), then SIGTERM on POSIX only, then a kill (SIGKILL on POSIX;
   * `kill()` is TerminateProcess on Windows, where there is no SIGTERM step). Finally polls until the port is free.
   */
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

  /**
   * A read-only look at `databasePath`: a separate short-lived child is spawned, says hello, answers the preflight and is
   * shut down; no `start` is ever sent, so it never listens on a port and never opens the database for writing.
   * It is independent of `start`/`stop` on purpose: the repair page must be able to preview a candidate while the current
   * backend runs, and a second child that holds no port cannot conflict with it. Previews run one at a time.
   */
  preview(databasePath: string, options: { quickCheck?: boolean } = {}): Promise<DatabasePreviewResult> {
    return this.previewMany([databasePath], options).then((results) => results[0] as DatabasePreviewResult);
  }

  /**
   * {@link preview} for several databases with one child: it says hello once and answers one preflight per path, so the
   * first-run detection pays one child start, not one per candidate. Results keep the order of `databasePaths`. A
   * failure of the child itself fails the paths it had not answered yet. `quickCheck` also asks the child for a read-only
   * `PRAGMA quick_check` on each database that otherwise reads fine.
   */
  previewMany(
    databasePaths: readonly string[],
    options: { quickCheck?: boolean } = {},
  ): Promise<DatabasePreviewResult[]> {
    return this.queuePreview(databasePaths, false, options.quickCheck === true);
  }

  /**
   * Creates a new empty database at `databasePath` and previews it, for a brand-new install whose start needs a database
   * identity. The preview child does it (`createIfMissing`), and only when nothing at all exists at the path: an existing
   * file, directory or symlink is never touched and is simply previewed. It shares the preview queue, timeouts and
   * stop handling of {@link preview}.
   */
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

  /**
   * Asks a preview child for a consistent copy of `source` at `target` (which must not exist): the child opens the source
   * read-only, never migrates it, checks the copy with `PRAGMA quick_check` and answers with the copy's identity. Never
   * touches the serving backend; shares the preview queue and its stop handling.
   */
  copyDatabase(source: string, target: string): Promise<DatabaseCopyOutcome> {
    const generation = this.previewGeneration;
    return this.enqueuePreview(() => this.runCopy(source, target, generation));
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
        // Same rule as a start: an `ok` verdict without the database's identity is not a verdict (nothing could be
        // confirmed against it). Other statuses are findings the repair page shows.
        // A verdict that fails this check is a failure of this path only; the child answers the next one as usual.
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

  /** The fixed working directory exists before any child starts in it; a failure is its own, named problem. */
  private async ensureWorkingDirectory(): Promise<void> {
    if (!this.workingDirectory || !this.deps.ensureDirectory) return;
    try {
      await this.deps.ensureDirectory(this.workingDirectory);
    } catch (error) {
      throw new BackendFailure("REPAIR_REQUIRED", WORKING_DIRECTORY_FAILURE, { cause: error });
    }
  }

  /** Calls every listener; one that throws is logged and never stops the others or reaches the event loop. */
  private notify<T>(listeners: ReadonlySet<T>, call: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      try {
        call(listener);
      } catch (error) {
        this.log(`a listener failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  /** Everything the child may echo and the parent must not keep: secrets, the database and backup paths, the home. */
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
    // The store opened (and may have migrated) the database, so `ready` carries a re-read identity: the file must be the
    // same one, and a lineage the preflight already knew must be unchanged. An empty file had none, so it may gain one.
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
      // A child that ended after `ready` (its own `failed` first, else CHILD_EXITED) is not worth another request.
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
      this.tryKill(child, platform === "win32" ? undefined : "SIGKILL");
      exit = await this.within(channel.exited, this.timeouts.killMs);
    }
    // A preview child never listens: there is no port to wait for.
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

  /** A kill that throws or returns false changes nothing: only the exit event proves the child ended. */
  private tryKill(child: SupervisedChild, signal: NodeJS.Signals | undefined): void {
    try {
      child.kill(signal);
    } catch {
      // The report says `exited: false` when no exit event follows.
    }
  }

  /** The bind probe with its reason; a dependency without `probePort` can only say "in use". */
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

  /** `promise`'s value, or undefined when `ms` pass first. */
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
