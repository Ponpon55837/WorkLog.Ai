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
import type { DesktopBackendActivity } from "@work-intelligence/schema";
import type { BackupRetentionOptions, ExportOptions } from "@work-intelligence/storage";
import type {
  BackgroundStoreOperations,
  ProjectDataImportPreviewWithFolderStatus,
  ProjectDataImportUpload,
  StagedProjectDataImportInspection,
} from "./routes/router.js";
import { BackupWorkerOutOfMemoryError, BackupWorkerTimeoutError } from "./backup-worker-errors.js";
import { RequestBodyError } from "./http.js";

export type BackupWorkerOperation =
  | { type: "createBackup" }
  | { type: "backupIfDue" }
  | { type: "exportTo"; target: string; options?: ExportOptions }
  | { type: "exportProjectData"; scope: ProjectDataExportScope; target: string; maxBytes?: number }
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
  heavy: boolean;
  failure?: unknown;
  closePromise?: Promise<void>;
}

export interface BackupWorkerClientOptions {
  idleTimeoutMs?: number;
  heapMb?: number;
  operationTimeoutMs?: number;
}

/**
 * A hung request would hold its HTTP request and the desktop activity gate forever; generous, since an import at the
 * 256 MiB limit takes minutes.
 */
export const OPERATION_WATCHDOG_MS = 30 * 60_000;

/** @internal test-only */
export const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
/**
 * V8 does not shrink an idle heap, so after a heavy operation the worker exits soon to give its memory back; one second
 * keeps a cold start out of work that arrives right behind.
 * @internal test-only
 */
export const HEAVY_IDLE_TIMEOUT_MS = 1_000;
/**
 * Matches the desktop backend's flags, so a server started without flags is not left at Node's default of about 2 GiB.
 * @internal test-only
 */
export const BACKUP_WORKER_HEAP_MB = 1024;
const BACKUP_WORKER_SEMI_SPACE_MB = 2;
export const BACKUP_WORKER_HEAP_ENVIRONMENT = "WORK_INTELLIGENCE_BACKGROUND_HEAP_MB";
const OUT_OF_MEMORY_MARKERS = [
  "JavaScript heap out of memory",
  "Reached heap limit",
  "Allocation failed",
  "Fatal JavaScript out of memory",
] as const;
/** Overlap so a marker split across two stderr chunks is still found. */
const OUT_OF_MEMORY_CARRY = Math.max(...OUT_OF_MEMORY_MARKERS.map((marker) => marker.length)) - 1;

export interface OutOfMemoryScanner {
  scan(chunk: string): void;
  readonly seen: boolean;
}

/**
 * Scans as chunks arrive: V8 prints a native stack trace after the report, which on macOS arm64 can be longer than any tail kept.
 * @internal test-only
 */
export function createOutOfMemoryScanner(): OutOfMemoryScanner {
  let carry = "";
  let seen = false;
  return {
    scan(chunk: string): void {
      if (seen) return;
      const text = carry + chunk;
      seen = OUT_OF_MEMORY_MARKERS.some((marker) => text.includes(marker));
      carry = text.slice(-OUT_OF_MEMORY_CARRY);
    },
    get seen(): boolean {
      return seen;
    },
  };
}
const ACTIVITY_OF_OPERATION: Readonly<Record<BackupWorkerOperation["type"], DesktopBackendActivity>> = {
  createBackup: "backup",
  backupIfDue: "backup",
  exportTo: "export",
  exportProjectData: "export",
  previewProjectDataImport: "import",
  importProjectData: "import",
  inspectStagedProjectDataImport: "import",
};

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
    "export_too_large",
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

/** A child process, not a worker thread: on Node 24 a worker that exhausts its heap can abort the whole process. */
export class BackupWorkerClient implements BackgroundStoreOperations {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly inFlight = new Map<BackupWorkerOperation["type"], number>();
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

  public exportProjectData(
    scope: ProjectDataExportScope,
    target: string,
    maxBytes?: number,
  ): Promise<{ bytes: number }> {
    return this.run({ type: "exportProjectData", scope, target, maxBytes });
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

  public activity(): DesktopBackendActivity[] {
    const kinds = new Set<DesktopBackendActivity>();
    for (const [type, count] of this.inFlight) if (count > 0) kinds.add(ACTIVITY_OF_OPERATION[type]);
    return [...kinds];
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
    this.inFlight.set(operation.type, (this.inFlight.get(operation.type) ?? 0) + 1);
    void promise
      .finally(() => {
        this.active.delete(promise);
        this.inFlight.set(operation.type, (this.inFlight.get(operation.type) ?? 1) - 1);
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
    const timeoutMs = this.options.operationTimeoutMs ?? OPERATION_WATCHDOG_MS;
    return new Promise<T>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.removePending(id);
        reject(new BackupWorkerTimeoutError(operation.type, timeoutMs));
        lifetime.child.kill("SIGKILL");
      }, timeoutMs);
      watchdog.unref();
      this.addPending(id, {
        lifetime,
        resolve: (value) => {
          clearTimeout(watchdog);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(watchdog);
          reject(error);
        },
      });
      try {
        lifetime.child.send({ id, operation } satisfies BackupWorkerRequest);
      } catch (error) {
        this.removePending(id);
        clearTimeout(watchdog);
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
    child.unref();
    child.channel?.unref();
    const outOfMemory = createOutOfMemoryScanner();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      process.stderr.write(text);
      outOfMemory.scan(text);
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
    child.on("error", (error) => {
      if (child.pid === undefined) fail(error);
    });
    // "close" comes after stderr is drained, so the out-of-memory report has been scanned by then.
    child.once("close", (code, signal) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      if (code === 0 && lifetime.retiring && !this.hasPendingRequests(lifetime)) {
        resolveExit();
        return;
      }
      const cause = new Error(
        `The background worker exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code}`}.`,
      );
      const error = outOfMemory.seen ? new BackupWorkerOutOfMemoryError({ cause }) : cause;
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

  /** Keeps the API alive only while a request waits on it, so an idle process never holds a shutdown. */
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
