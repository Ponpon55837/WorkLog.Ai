import { BackupExportStore, type BackupRetentionOptions } from "@work-intelligence/storage/backup-export";
import type { WorkIntelligenceStore } from "@work-intelligence/storage";
import type {
  BackupWorkerCloseRequest,
  BackupWorkerOperation,
  BackupWorkerReply,
  BackupWorkerRequest,
  SerializedWorkerError,
} from "./backup-worker-client.js";

interface BackupWorkerData {
  databasePath: string;
  backup: BackupRetentionOptions;
  expectedSchemaVersion: number;
}

function serializeError(error: unknown, depth = 0): SerializedWorkerError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown; statusCode?: unknown };
    const cause = error.cause !== undefined && depth < 5 ? serializeError(error.cause, depth + 1) : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(candidate.code === undefined ? {} : { code: candidate.code }),
      ...(candidate.errcode === undefined ? {} : { errcode: candidate.errcode }),
      ...(candidate.errstr === undefined ? {} : { errstr: candidate.errstr }),
      ...(candidate.statusCode === undefined ? {} : { statusCode: candidate.statusCode }),
      ...(cause ? { cause } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function errorResponse(id: number, error: unknown): BackupWorkerReply {
  return { id, ok: false, error: serializeError(error) };
}

/**
 * The worker's connections. Snapshots and exports run on the lean read-only `BackupExportStore`, which loads without
 * zod and the schema package (about 100 ms of the worker's cold start). Only previews and imports, which validate
 * bundles, load the full storage package, and only when the first one arrives. An import opens the writable store
 * without migrating: the API process owns the schema and checked it before starting this worker.
 */
class WorkerStores {
  private exporter: BackupExportStore | undefined;
  private previewer: WorkIntelligenceStore | undefined;
  private importer: WorkIntelligenceStore | undefined;

  public constructor(private readonly context: BackupWorkerData) {}

  public exportStore(): BackupExportStore {
    this.exporter ??= new BackupExportStore(this.context.databasePath, {
      backup: this.context.backup,
      expectedSchemaVersion: this.context.expectedSchemaVersion,
    });
    return this.exporter;
  }

  public async previewStore(): Promise<WorkIntelligenceStore> {
    if (!this.previewer) {
      const { WorkIntelligenceStore } = await import("@work-intelligence/storage");
      this.previewer ??= new WorkIntelligenceStore(this.context.databasePath, {
        backup: this.context.backup,
        mode: "read-only",
        expectedSchemaVersion: this.context.expectedSchemaVersion,
      });
    }
    return this.previewer;
  }

  public async importStore(): Promise<WorkIntelligenceStore> {
    if (!this.importer) {
      const { WorkIntelligenceStore } = await import("@work-intelligence/storage");
      this.importer ??= new WorkIntelligenceStore(this.context.databasePath, {
        backup: this.context.backup,
        mode: "existing",
        expectedSchemaVersion: this.context.expectedSchemaVersion,
      });
    }
    return this.importer;
  }

  public close(): void {
    for (const store of [this.exporter, this.previewer, this.importer]) store?.close();
  }
}

async function executeOperation(stores: WorkerStores, operation: BackupWorkerOperation): Promise<unknown> {
  switch (operation.type) {
    case "createBackup":
      return stores.exportStore().createBackup();
    case "backupIfDue":
      return stores.exportStore().backupIfDue();
    case "exportTo":
      return stores.exportStore().exportTo(operation.target, operation.options);
    case "exportProjectData":
      return stores.exportStore().writeProjectData(operation.scope, operation.target);
    case "previewProjectDataImport": {
      const store = await stores.previewStore();
      const { previewProjectDataImportUpload } = await import("./http.js");
      return previewProjectDataImportUpload(store, operation.upload);
    }
    case "importProjectData": {
      // Streaming, validation, planning and the search-index sync after the commit all run here, off the API process.
      const store = await stores.importStore();
      const { importProjectDataUpload } = await import("./http.js");
      return importProjectDataUpload(store, operation.upload);
    }
    case "inspectStagedProjectDataImport": {
      const store = await stores.previewStore();
      const { inspectStagedProjectDataImport } = await import("./http.js");
      return inspectStagedProjectDataImport(store, operation.upload);
    }
  }
}

function send(reply: BackupWorkerReply, callback?: () => void): void {
  process.send?.(reply, undefined, undefined, callback);
}

/** Set once the API asked this process to close: the channel then closes by request, not because the API is gone. */
let closing = false;

function handleClose(stores: WorkerStores, request: BackupWorkerCloseRequest): void {
  closing = true;
  let reply: BackupWorkerReply;
  try {
    stores.close();
    reply = { id: request.id, ok: true, value: null };
  } catch (error) {
    reply = errorResponse(request.id, error);
  }
  // Disconnect once the reply is written; with nothing else left the process then exits on its own.
  send(reply, () => process.disconnect?.());
}

if (!process.send) {
  throw new Error("The background worker must be started by the API process.");
}
const stores = new WorkerStores(JSON.parse(process.argv[2] ?? "{}") as BackupWorkerData);
// Operations run one at a time in arrival order, as they did when each was synchronous; a lazy import must not let
// a later request (or the close) overtake an earlier one.
let queue: Promise<void> = Promise.resolve();

// The API process is gone (crashed or killed): nothing can receive a reply, so stop. This runs between operations
// (each one is synchronous); queued ones are dropped, and SQLite needs no cleanup beyond what a kill would leave.
process.on("disconnect", () => {
  if (!closing) process.exit(0);
});

process.on("message", (message: BackupWorkerRequest | BackupWorkerCloseRequest) => {
  queue = queue.then(async () => {
    if ("close" in message) {
      handleClose(stores, message);
      return;
    }
    try {
      send({ id: message.id, ok: true, value: await executeOperation(stores, message.operation) });
    } catch (error) {
      send(errorResponse(message.id, error));
    }
  });
});
