import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProjectDataTransferError, type ProjectDataTransferErrorCode } from "@work-intelligence/storage";
import type {
  DatabaseBackupCreated,
  DatabaseBackupUnavailable,
  ProjectDataExportScope,
  ProjectDataImportInput,
} from "@work-intelligence/core";
import type { BackupRetentionOptions } from "@work-intelligence/storage";
import type {
  BackgroundStoreOperations,
  ProjectDataExportDocument,
  ProjectDataImportPreviewWithFolderStatus,
} from "./routes/router.js";

export type BackupWorkerOperation =
  | { type: "createBackup" }
  | { type: "backupIfDue" }
  | { type: "exportTo"; target: string }
  | { type: "exportProjectData"; scope: ProjectDataExportScope }
  | { type: "previewProjectDataImport"; input: ProjectDataImportInput };

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

interface SerializedWorkerError {
  name: string;
  message: string;
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WorkerLifetime {
  worker: Worker;
  exited: Promise<void>;
}

function workerEntryUrl(): URL {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return new URL(`./backup-worker.${extension}`, import.meta.url);
}

function workerOptions(databasePath: string, backup: BackupRetentionOptions): ConstructorParameters<typeof Worker>[1] {
  const entry = workerEntryUrl();
  const isTypeScript = entry.pathname.endsWith(".ts");
  return {
    workerData: { databasePath, backup },
    ...(isTypeScript
      ? { execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] }
      : {}),
  };
}

function restoredError(error: SerializedWorkerError): Error {
  const transferCodes: ProjectDataTransferErrorCode[] = [
    "invalid_input",
    "invalid_bundle",
    "unsupported_schema",
    "project_not_found",
  ];
  if (transferCodes.includes(error.code as ProjectDataTransferErrorCode)) {
    return new ProjectDataTransferError(error.code as ProjectDataTransferErrorCode, error.message);
  }
  return Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.errcode === undefined ? {} : { errcode: error.errcode }),
    ...(error.errstr === undefined ? {} : { errstr: error.errstr }),
  });
}

/** A single database worker for large snapshots and portable import/export preparation. */
export class BackupWorkerClient implements BackgroundStoreOperations {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly active = new Set<Promise<unknown>>();
  private lifetime?: WorkerLifetime;
  private closePromise?: Promise<void>;
  private nextId = 1;
  private accepting = true;

  public constructor(
    private readonly databasePath: string,
    private readonly backup: BackupRetentionOptions = {},
  ) {}

  public createBackup(): Promise<DatabaseBackupCreated | DatabaseBackupUnavailable> {
    return this.run({ type: "createBackup" });
  }

  public backupIfDue(): Promise<DatabaseBackupCreated | null> {
    return this.run({ type: "backupIfDue" });
  }

  public exportTo(target: string): Promise<{ bytes: number }> {
    return this.run({ type: "exportTo", target });
  }

  public exportProjectData(scope: ProjectDataExportScope): Promise<ProjectDataExportDocument> {
    return this.run({ type: "exportProjectData", scope });
  }

  public previewProjectDataImport(input: ProjectDataImportInput): Promise<ProjectDataImportPreviewWithFolderStatus> {
    return this.run({ type: "previewProjectDataImport", input });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      this.lifetime?.worker.ref();
      this.closePromise = this.drainAndClose();
    }
    return this.closePromise;
  }

  private run<T>(operation: BackupWorkerOperation): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("The backup worker is closing."));
    }
    const promise = this.send<T>(operation);
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => undefined);
    return promise;
  }

  private send<T>(operation: BackupWorkerOperation): Promise<T> {
    const lifetime = this.startWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        lifetime.worker.postMessage({ id, operation } satisfies BackupWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private startWorker(): WorkerLifetime {
    if (this.lifetime) return this.lifetime;

    const worker = new Worker(workerEntryUrl(), workerOptions(this.databasePath, this.backup));
    worker.unref();
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    const exited = new Promise<void>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void exited.catch(() => undefined);
    const lifetime = { worker, exited };
    this.lifetime = lifetime;

    worker.on("message", (message: BackupWorkerReply) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(restoredError(message.error));
    });
    worker.once("error", (error) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      this.rejectPending(error);
      rejectExit(error);
    });
    worker.once("exit", (code) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      if (code === 0 && !this.accepting) {
        resolveExit();
        return;
      }
      const error = new Error(`The backup worker exited unexpectedly with code ${code}.`);
      this.rejectPending(error);
      rejectExit(error);
    });
    return lifetime;
  }

  private async drainAndClose(): Promise<void> {
    await Promise.allSettled([...this.active]);
    const lifetime = this.lifetime;
    if (!lifetime) return;

    const id = this.nextId++;
    const closeAcknowledged = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
      try {
        lifetime.worker.postMessage({ id, close: true } satisfies BackupWorkerCloseRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    await closeAcknowledged;
    await lifetime.exited;
    this.lifetime = undefined;
  }

  private rejectPending(error: unknown): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
