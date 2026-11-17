import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  type ProjectDataTransferErrorCode,
} from "@work-intelligence/storage";
import type {
  DatabaseBackupCreated,
  DatabaseBackupUnavailable,
  ProjectDataExportScope,
  ProjectDataImportResult,
} from "@work-intelligence/core";
import type { BackupRetentionOptions, ExportOptions } from "@work-intelligence/storage";
import type {
  BackgroundStoreOperations,
  ProjectDataImportPreviewWithFolderStatus,
  ProjectDataImportUpload,
  StagedProjectDataImportInspection,
} from "./routes/router.js";
import { BackupWorkerOutOfMemoryError } from "./backup-worker-errors.js";
import { RequestBodyError } from "./http.js";

export type BackupWorkerOperation =
  | { type: "createBackup" }
  | { type: "backupIfDue" }
  | { type: "exportTo"; target: string; options?: ExportOptions }
  | { type: "exportProjectData"; scope: ProjectDataExportScope; target: string }
  | { type: "previewProjectDataImport"; upload: ProjectDataImportUpload }
  | { type: "importProjectData"; upload: ProjectDataImportUpload }
  | { type: "inspectStagedProjectDataImport"; upload: ProjectDataImportUpload };

export interface BackupWorkerRequest {
  id: number;
  operation: BackupWorkerOperation;
}

export interface BackupWorkerCloseRequest {
  close: true;
  id: number;
}

export interface BackupWorkerResponse {
  id: number;
  ok: true;
  value: unknown;
}

export interface BackupWorkerFailure {
  id: number;
  ok: false;
  error: SerializedWorkerError;
}

export type BackupWorkerReply = BackupWorkerResponse | BackupWorkerFailure;

export interface SerializedWorkerError {
  name: string;
  message: string;
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  statusCode?: unknown;
  cause?: SerializedWorkerError;
}

interface PendingRequest {
  lifetime: WorkerLifetime;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WorkerLifetime {
  child: ChildProcess;
  exited: Promise<void>;
  retiring: boolean;
  /** A heavy operation ran in this worker, so it exits quickly once idle. */
  heavy: boolean;
  failure?: unknown;
  closePromise?: Promise<void>;
}

export interface BackupWorkerClientOptions {
  /** Idle time before the worker exits; one value for every operation (tests use it to pin timing). */
  idleTimeoutMs?: number;
  /**
   * Old-generation heap of the process in MiB, instead of {@link BACKUP_WORKER_HEAP_MB} (or the
   * `WORK_INTELLIGENCE_BACKGROUND_HEAP_MB` override); tests use a tiny heap to force an out-of-memory exit.
   */
  heapMb?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
/**
 * Import, preview and export leave the worker holding the parsed document (hundreds of MiB for a large project) in
 * a heap V8 does not shrink while idle, and what SQLite and the allocator held stays with the process until the thread
 * is gone, so the worker exits one second after them and that memory goes back to the system: on a 33 MiB synthetic
 * export the process stayed at 237 MiB for the 5 s this used to wait, against 85 MiB before the operation. The second
 * keeps a cold start (about 500 ms) out of work that arrives right behind, such as the next request of one upload.
 */
export const HEAVY_IDLE_TIMEOUT_MS = 1_000;
/**
 * Heap of the background process. Import, preview and export stream their files, so what they hold is bounded by
 * the row limits of the schema (200,000 rows), not by the file size; see docs/standalone.md for the measurements. The
 * flags match the desktop backend's (`--max-old-space-size=1024 --max-semi-space-size=2`), so a server started without
 * flags (dev, standalone CLI) is bounded the same instead of taking Node's default of about 2 GiB on a 16 GB machine.
 * Running out of it ends only this process: the API reports `backup_worker_out_of_memory` and keeps serving.
 */
export const BACKUP_WORKER_HEAP_MB = 1024;
const BACKUP_WORKER_SEMI_SPACE_MB = 2;
export const BACKUP_WORKER_HEAP_ENVIRONMENT = "WORK_INTELLIGENCE_BACKGROUND_HEAP_MB";
/** The last stderr bytes kept to recognise how the process ended; V8's fatal out-of-memory report fits easily. */
const STDERR_TAIL_BYTES = 8 * 1024;
const OUT_OF_MEMORY_REPORT =
  /JavaScript heap out of memory|Reached heap limit|Allocation failed|Fatal JavaScript out of memory/;
const HEAVY_OPERATIONS: ReadonlySet<BackupWorkerOperation["type"]> = new Set([
  "exportTo",
  "exportProjectData",
  "previewProjectDataImport",
  "importProjectData",
  "inspectStagedProjectDataImport",
]);

function workerEntryPath(): string {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./backup-worker.${extension}`, import.meta.url));
}

function heapMb(option: number | undefined): number {
  const configured = option ?? Number(process.env[BACKUP_WORKER_HEAP_ENVIRONMENT] || BACKUP_WORKER_HEAP_MB);
  if (!Number.isSafeInteger(configured) || configured < 16) {
    throw new RangeError("The background worker heap must be a whole number of MiB, at least 16.");
  }
  return configured;
}

/**
 * Starts the background process on the same Node binary as the API (the bundled runtime on desktop), with its own
 * heap flags instead of the API's. In a TypeScript checkout it runs through tsx, like the API.
 */
function startWorkerProcess(
  databasePath: string,
  backup: BackupRetentionOptions,
  expectedSchemaVersion: number,
  heap: number,
): ChildProcess {
  const entry = workerEntryPath();
  const tsx = entry.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
    : [];
  return fork(entry, [JSON.stringify({ databasePath, backup, expectedSchemaVersion })], {
    execPath: process.execPath,
    execArgv: [...tsx, `--max-old-space-size=${heap}`, `--max-semi-space-size=${BACKUP_WORKER_SEMI_SPACE_MB}`],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "pipe", "ipc"],
    windowsHide: true,
  });
}

function restoredError(error: SerializedWorkerError): Error {
  if (
    error.name === "RequestBodyError" &&
    (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
  ) {
    return new RequestBodyError(error.statusCode, error.message);
  }
  const transferCodes: ProjectDataTransferErrorCode[] = [
    "invalid_input",
    "invalid_bundle",
    "unsupported_schema",
    "project_not_found",
    "project_backup_failed",
  ];
  if (transferCodes.includes(error.code as ProjectDataTransferErrorCode)) {
    return new ProjectDataTransferError(error.code as ProjectDataTransferErrorCode, error.message);
  }
  const cause = error.cause ? restoredError(error.cause) : undefined;
  return Object.assign(new Error(error.message, cause ? { cause } : undefined), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.errcode === undefined ? {} : { errcode: error.errcode }),
    ...(error.errstr === undefined ? {} : { errstr: error.errstr }),
  });
}

/**
 * One background process for database snapshots and portable import, preview and export. It is a child process, not
 * a worker thread: on Node 24 a worker that exhausts its heap can abort the whole process, and a separate process
 * also gives all of its memory back when it exits.
 */
export class BackupWorkerClient implements BackgroundStoreOperations {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly active = new Set<Promise<unknown>>();
  private lifetime?: WorkerLifetime;
  private closePromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private nextId = 1;
  private accepting = true;

  public constructor(
    private readonly databasePath: string,
    private readonly backup: BackupRetentionOptions = {},
    private readonly expectedSchemaVersion = LATEST_SCHEMA_VERSION,
    private readonly options: BackupWorkerClientOptions = {},
  ) {
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0)) {
      throw new RangeError("The backup worker idle timeout must be a non-negative number.");
    }
  }

  public createBackup(): Promise<DatabaseBackupCreated | DatabaseBackupUnavailable> {
    return this.run({ type: "createBackup" });
  }

  public backupIfDue(): Promise<DatabaseBackupCreated | null> {
    return this.run({ type: "backupIfDue" });
  }

  public exportTo(target: string, options?: ExportOptions): Promise<{ bytes: number }> {
    return this.run({ type: "exportTo", target, ...(options ? { options } : {}) });
  }

  public exportProjectData(scope: ProjectDataExportScope, target: string): Promise<{ bytes: number }> {
    return this.run({ type: "exportProjectData", scope, target });
  }

  public previewProjectDataImport(upload: ProjectDataImportUpload): Promise<ProjectDataImportPreviewWithFolderStatus> {
    return this.run({ type: "previewProjectDataImport", upload });
  }

  public importProjectData(upload: ProjectDataImportUpload): Promise<ProjectDataImportResult> {
    return this.run({ type: "importProjectData", upload });
  }

  public inspectStagedProjectDataImport(upload: ProjectDataImportUpload): Promise<StagedProjectDataImportInspection> {
    return this.run({ type: "inspectStagedProjectDataImport", upload });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.lifetime?.child.ref();
      this.closePromise = this.drainAndClose();
    }
    return this.closePromise;
  }

  private run<T>(operation: BackupWorkerOperation): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("The backup worker is closing."));
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const promise = this.send<T>(operation);
    this.active.add(promise);
    void promise
      .finally(() => {
        this.active.delete(promise);
        this.scheduleIdleClose();
      })
      .catch(() => undefined);
    return promise;
  }

  private async send<T>(operation: BackupWorkerOperation): Promise<T> {
    const lifetime = await this.startWorker();
    if (lifetime.failure !== undefined) throw lifetime.failure;
    if (HEAVY_OPERATIONS.has(operation.type)) lifetime.heavy = true;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.addPending(id, { lifetime, resolve: (value) => resolve(value as T), reject });
      try {
        lifetime.child.send({ id, operation } satisfies BackupWorkerRequest);
      } catch (error) {
        this.removePending(id);
        reject(error);
      }
    });
  }

  private async startWorker(): Promise<WorkerLifetime> {
    const previousLifetime = this.lifetime;
    if (previousLifetime?.retiring) {
      await previousLifetime.exited.catch(() => undefined);
      if (this.lifetime === previousLifetime) this.lifetime = undefined;
    }
    if (this.lifetime) return this.lifetime;

    const child = startWorkerProcess(
      this.databasePath,
      this.backup,
      this.expectedSchemaVersion,
      heapMb(this.options.heapMb),
    );
    // Like the worker thread it replaces, the process never keeps the API alive by itself.
    child.unref();
    child.channel?.unref();
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    const exited = new Promise<void>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void exited.catch(() => undefined);
    const lifetime: WorkerLifetime = { child, exited, retiring: false, heavy: false };
    this.lifetime = lifetime;

    child.on("message", (message: BackupWorkerReply) => {
      const request = this.pending.get(message.id);
      if (!request || request.lifetime !== lifetime) return;
      this.removePending(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(restoredError(message.error));
    });
    const fail = (error: unknown): void => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      lifetime.failure = error;
      this.rejectPending(error, lifetime);
      rejectExit(error);
    };
    // A process that could not be started has no pid. Other errors (a failed send) reject their own request, and an
    // exit is reported by "close" below.
    child.on("error", (error) => {
      if (child.pid === undefined) fail(error);
    });
    // "close" comes after stderr is drained, so the out-of-memory report is in the tail by then.
    child.once("close", (code, signal) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      if (code === 0 && lifetime.retiring && !this.hasPendingRequests(lifetime)) {
        resolveExit();
        return;
      }
      // The process is gone either way; an out-of-memory exit gets its own error so the API can say what happened.
      const cause = new Error(
        `The background worker exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code}`}.`,
      );
      const error = OUT_OF_MEMORY_REPORT.test(stderrTail) ? new BackupWorkerOutOfMemoryError({ cause }) : cause;
      lifetime.failure = error;
      this.rejectPending(error, lifetime);
      if (code === 0 && lifetime.retiring) resolveExit();
      else rejectExit(error);
    });
    return lifetime;
  }

  private async drainAndClose(): Promise<void> {
    await Promise.allSettled([...this.active]);
    const lifetime = this.lifetime;
    if (!lifetime) return;
    await this.closeLifetime(lifetime);
  }

  private scheduleIdleClose(): void {
    if (!this.accepting || this.active.size > 0 || !this.lifetime || this.lifetime.retiring) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        void this.closeIdleWorker();
      },
      this.options.idleTimeoutMs ?? (this.lifetime.heavy ? HEAVY_IDLE_TIMEOUT_MS : DEFAULT_IDLE_TIMEOUT_MS),
    );
    this.idleTimer.unref();
  }

  private async closeIdleWorker(): Promise<void> {
    const lifetime = this.lifetime;
    if (!this.accepting || this.active.size > 0 || !lifetime || lifetime.retiring) return;
    try {
      await this.closeLifetime(lifetime);
    } catch {
      // A failed idle close must not turn a completed API operation into an unhandled rejection.
    }
  }

  private async closeLifetime(lifetime: WorkerLifetime): Promise<void> {
    if (!lifetime.closePromise) {
      lifetime.retiring = true;
      lifetime.child.ref();
      lifetime.closePromise = this.sendCloseRequest(lifetime);
    }
    await lifetime.closePromise;
    await lifetime.exited;
    if (this.lifetime === lifetime) this.lifetime = undefined;
  }

  private async sendCloseRequest(lifetime: WorkerLifetime): Promise<void> {
    const id = this.nextId++;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      this.addPending(id, { lifetime, resolve: () => resolve(), reject });
      try {
        lifetime.child.send({ id, close: true } satisfies BackupWorkerCloseRequest);
      } catch (error) {
        this.removePending(id);
        reject(error);
      }
    });
    const [ackResult, exitResult] = await Promise.allSettled([acknowledgement, lifetime.exited]);
    if (ackResult.status === "rejected") throw ackResult.reason;
    if (exitResult.status === "rejected") throw exitResult.reason;
  }

  private addPending(id: number, request: PendingRequest): void {
    this.pending.set(id, request);
    this.holdOpen(request.lifetime);
  }

  private removePending(id: number): void {
    const request = this.pending.get(id);
    this.pending.delete(id);
    if (request) this.holdOpen(request.lifetime);
  }

  /**
   * The process keeps the API alive only while a request (or its close) waits on it, so an idle one never holds a
   * shutdown and a CLI or test that awaits a request is not left with an empty event loop.
   */
  private holdOpen(lifetime: WorkerLifetime): void {
    const busy = lifetime.retiring || this.hasPendingRequests(lifetime);
    if (busy) {
      lifetime.child.ref();
      lifetime.child.channel?.ref();
    } else {
      lifetime.child.unref();
      lifetime.child.channel?.unref();
    }
  }

  private hasPendingRequests(lifetime: WorkerLifetime): boolean {
    return [...this.pending.values()].some((request) => request.lifetime === lifetime);
  }

  private rejectPending(error: unknown, lifetime: WorkerLifetime): void {
    for (const [id, request] of this.pending) {
      if (request.lifetime !== lifetime) continue;
      this.removePending(id);
      request.reject(error);
    }
  }
}
