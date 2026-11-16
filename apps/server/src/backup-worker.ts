import { parentPort, workerData } from "node:worker_threads";
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

interface WorkerOperationResult {
  value: unknown;
  transferList?: ArrayBuffer[];
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

/**
 * `content` on a memory block of its own, ready to transfer. A small Buffer is a slice of Node's shared pool: posting it
 * would clone the whole pool (other calls' bytes included) and transferring it would detach the pool in this worker,
 * so that one is copied into its own block first. A large Buffer already owns its block and is sent as is.
 */
function ownedBytes(content: Buffer): Uint8Array<ArrayBuffer> {
  const { buffer } = content;
  const owns = buffer instanceof ArrayBuffer && content.byteOffset === 0 && content.byteLength === buffer.byteLength;
  return owns ? (content as Uint8Array<ArrayBuffer>) : new Uint8Array(content);
}

async function executeOperation(
  stores: WorkerStores,
  operation: BackupWorkerOperation,
): Promise<WorkerOperationResult> {
  switch (operation.type) {
    case "createBackup":
      return { value: stores.exportStore().createBackup() };
    case "backupIfDue":
      return { value: stores.exportStore().backupIfDue() };
    case "exportTo":
      return { value: stores.exportStore().exportTo(operation.target, operation.options) };
    case "exportProjectData": {
      // Buffer.from encodes UTF-8 about a third faster than TextEncoder, to the same bytes.
      const content = ownedBytes(
        Buffer.from(JSON.stringify(await stores.exportStore().exportProjectData(operation.scope)), "utf8"),
      );
      return { value: { content, bytes: content.byteLength }, transferList: [content.buffer] };
    }
    case "previewProjectDataImport": {
      const store = await stores.previewStore();
      const { inspectProjectFolder, parseProjectDataImportBytes } = await import("./http.js");
      const input =
        operation.input instanceof Uint8Array ? parseProjectDataImportBytes(operation.input) : operation.input;
      const preview = store.previewProjectDataImport(input);
      return {
        value: {
          ...preview,
          selectedProjects: preview.selectedProjects.map((project) => ({
            ...project,
            folderStatus: inspectProjectFolder(project.rootPath),
          })),
        },
      };
    }
    case "importProjectData": {
      // Parsing, validation, planning and the search-index sync after the commit all run here, off the API thread.
      const store = await stores.importStore();
      const { parseProjectDataImportBytes } = await import("./http.js");
      const input =
        operation.input instanceof Uint8Array ? parseProjectDataImportBytes(operation.input) : operation.input;
      return { value: store.importProjectData(input) };
    }
  }
}

function handleClose(stores: WorkerStores, request: BackupWorkerCloseRequest): void {
  try {
    stores.close();
    parentPort?.postMessage({ id: request.id, ok: true, value: null } satisfies BackupWorkerReply);
  } catch (error) {
    parentPort?.postMessage(errorResponse(request.id, error));
  } finally {
    parentPort?.close();
  }
}

const workerContext = workerData as BackupWorkerData;
const port = parentPort;
const stores = new WorkerStores(workerContext);
// Operations run one at a time in arrival order, as they did when each was synchronous; a lazy import must not let
// a later request (or the close) overtake an earlier one.
let queue: Promise<void> = Promise.resolve();

if (!port) {
  throw new Error("The backup worker requires a parent thread.");
}

port.on("message", (message: BackupWorkerRequest | BackupWorkerCloseRequest) => {
  queue = queue.then(async () => {
    if ("close" in message) {
      handleClose(stores, message);
      return;
    }

    try {
      const result = await executeOperation(stores, message.operation);
      port.postMessage(
        { id: message.id, ok: true, value: result.value } satisfies BackupWorkerReply,
        result.transferList,
      );
    } catch (error) {
      port.postMessage(errorResponse(message.id, error));
    }
  });
});
