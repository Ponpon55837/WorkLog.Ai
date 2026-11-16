import { Worker, type ResourceLimits } from "node:worker_threads";
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
  ProjectDataImportInput,
  ProjectDataImportResult,
} from "@work-intelligence/core";
import type { BackupRetentionOptions, ExportOptions } from "@work-intelligence/storage";
import type {
  BackgroundStoreOperations,
  ProjectDataExportDocument,
  ProjectDataImportPreviewWithFolderStatus,
} from "./routes/router.js";
import { BackupWorkerOutOfMemoryError } from "./backup-worker-errors.js";
import { RequestBodyError } from "./http.js";

export type BackupWorkerOperation =
  | { type: "createBackup" }
  | { type: "backupIfDue" }
  | { type: "exportTo"; target: string; options?: ExportOptions }
  | { type: "exportProjectData"; scope: ProjectDataExportScope }
  | { type: "previewProjectDataImport"; input: ProjectDataImportInput | Uint8Array }
  | { type: "importProjectData"; input: ProjectDataImportInput | Uint8Array };

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
  worker: Worker;
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
  /** Replaces {@link BACKUP_WORKER_RESOURCE_LIMITS}; tests use a tiny heap to force an out-of-memory exit. */
  resourceLimits?: ResourceLimits;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
/**
 * Import, preview and export leave the worker holding the parsed document (hundreds of MiB for a large project) in
 * a heap V8 does not shrink while idle, so the worker exits sooner after them and that memory goes back to the system.
 * 5 s keeps a cold start (about 500 ms) out of back-to-back work such as a preview followed by its import, or an
 * export retried right away, while holding the memory for seconds rather than the 15 s of a light operation.
 */
export const HEAVY_IDLE_TIMEOUT_MS = 5_000;
/**
 * Heap limits of the worker, which has its own isolate beside the API's. Measured on synthetic project data with the
 * desktop flags (`--max-old-space-size=1024 --max-semi-space-size=2`, three runs, median of the worker's peak
 * `heapUsed`): preview 46 MiB for a 10 MB document and 163 MiB for 47.6 MB; import 59 MiB and 193 MiB. The largest
 * accepted import (50 MiB) therefore needs about 210 MiB, and the old generation is set to 1 GiB, five times that.
 * It matches the desktop flag, so a server started without flags (dev, standalone CLI) is bounded the same instead of
 * taking Node's default of about 2 GiB on a 16 GB machine. With the flag present V8 uses the flag and ignores this
 * value; the process then holds at most the API's 1 GiB, this worker's 1 GiB and its buffers. A 6 MiB young
 * generation (three 2 MiB semi-spaces, as the flag gives the API) took the same time as the default 48 MiB on the
 * 47.6 MB import (7.6 s) and kept about 35 MiB less resident.
 */
export const BACKUP_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 1024,
  maxYoungGenerationSizeMb: 6,
};
const HEAVY_OPERATIONS: ReadonlySet<BackupWorkerOperation["type"]> = new Set([
  "exportTo",
  "exportProjectData",
  "previewProjectDataImport",
  "importProjectData",
]);

function workerEntryUrl(): URL {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return new URL(`./backup-worker.${extension}`, import.meta.url);
}

function workerOptions(
  databasePath: string,
  backup: BackupRetentionOptions,
  expectedSchemaVersion: number,
  resourceLimits: ResourceLimits,
): ConstructorParameters<typeof Worker>[1] {
  const entry = workerEntryUrl();
  const isTypeScript = entry.pathname.endsWith(".ts");
  return {
    workerData: { databasePath, backup, expectedSchemaVersion },
    resourceLimits,
    ...(isTypeScript
      ? { execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] }
      : {}),
  };
}

function isWorkerOutOfMemory(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY"
  );
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

function inputTransferBuffer(input: ProjectDataImportInput | Uint8Array): ArrayBuffer | undefined {
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) return undefined;
  if (input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) return undefined;
  return input.buffer;
}

/** A single database worker for large snapshots and portable import/export preparation. */
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

  public exportProjectData(scope: ProjectDataExportScope): Promise<ProjectDataExportDocument> {
    return this.run({ type: "exportProjectData", scope });
  }

  public previewProjectDataImport(
    input: ProjectDataImportInput | Uint8Array,
  ): Promise<ProjectDataImportPreviewWithFolderStatus> {
    return this.run({ type: "previewProjectDataImport", input });
  }

  public importProjectData(input: ProjectDataImportInput | Uint8Array): Promise<ProjectDataImportResult> {
    return this.run({ type: "importProjectData", input });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.lifetime?.worker.ref();
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
      this.pending.set(id, { lifetime, resolve: (value) => resolve(value as T), reject });
      try {
        const request = { id, operation } satisfies BackupWorkerRequest;
        const transferBuffer =
          operation.type === "previewProjectDataImport" || operation.type === "importProjectData"
            ? inputTransferBuffer(operation.input)
            : undefined;
        lifetime.worker.postMessage(request, transferBuffer ? [transferBuffer] : []);
      } catch (error) {
        this.pending.delete(id);
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

    const worker = new Worker(
      workerEntryUrl(),
      workerOptions(
        this.databasePath,
        this.backup,
        this.expectedSchemaVersion,
        this.options.resourceLimits ?? BACKUP_WORKER_RESOURCE_LIMITS,
      ),
    );
    worker.unref();
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    const exited = new Promise<void>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void exited.catch(() => undefined);
    const lifetime: WorkerLifetime = { worker, exited, retiring: false, heavy: false };
    this.lifetime = lifetime;

    worker.on("message", (message: BackupWorkerReply) => {
      const request = this.pending.get(message.id);
      if (!request || request.lifetime !== lifetime) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(restoredError(message.error));
    });
    worker.once("error", (workerError: unknown) => {
      // The worker is gone either way; an out-of-memory exit gets its own error so the API can say what happened.
      const error = isWorkerOutOfMemory(workerError)
        ? new BackupWorkerOutOfMemoryError({ cause: workerError })
        : workerError;
      if (this.lifetime === lifetime) this.lifetime = undefined;
      lifetime.failure = error;
      this.rejectPending(error, lifetime);
      rejectExit(error);
    });
    worker.once("exit", (code) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      if (code === 0 && lifetime.retiring && !this.hasPendingRequests(lifetime)) {
        resolveExit();
        return;
      }
      const error = new Error(`The backup worker exited unexpectedly with code ${code}.`);
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
      lifetime.worker.ref();
      lifetime.closePromise = this.sendCloseRequest(lifetime);
    }
    await lifetime.closePromise;
    await lifetime.exited;
    if (this.lifetime === lifetime) this.lifetime = undefined;
  }

  private async sendCloseRequest(lifetime: WorkerLifetime): Promise<void> {
    const id = this.nextId++;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { lifetime, resolve: () => resolve(), reject });
      try {
        lifetime.worker.postMessage({ id, close: true } satisfies BackupWorkerCloseRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    const [ackResult, exitResult] = await Promise.allSettled([acknowledgement, lifetime.exited]);
    if (ackResult.status === "rejected") throw ackResult.reason;
    if (exitResult.status === "rejected") throw exitResult.reason;
  }

  private hasPendingRequests(lifetime: WorkerLifetime): boolean {
    return [...this.pending.values()].some((request) => request.lifetime === lifetime);
  }

  private rejectPending(error: unknown, lifetime: WorkerLifetime): void {
    for (const [id, request] of this.pending) {
      if (request.lifetime !== lifetime) continue;
      this.pending.delete(id);
      request.reject(error);
    }
  }
}
