import { parentPort, workerData } from "node:worker_threads";
import { WorkIntelligenceStore, type BackupRetentionOptions } from "@work-intelligence/storage";
import { inspectProjectFolder, parseProjectDataImportBytes } from "./http.js";
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
 * Snapshots, exports and previews read through the read-only store; only an import opens the writable one, on
 * first use, without migrating: the API process owns the schema and checked it before starting this worker.
 */
function executeOperation(
  stores: { reader(): WorkIntelligenceStore; writer(): WorkIntelligenceStore },
  operation: BackupWorkerOperation,
): WorkerOperationResult {
  const store = operation.type === "importProjectData" ? stores.writer() : stores.reader();
  switch (operation.type) {
    case "createBackup":
      return { value: store.createBackup() };
    case "backupIfDue":
      return { value: store.backupIfDue() };
    case "exportTo":
      return { value: store.exportTo(operation.target) };
    case "exportProjectData": {
      const content = new TextEncoder().encode(JSON.stringify(store.exportProjectData(operation.scope)));
      return {
        value: { content, bytes: content.byteLength },
        transferList: [content.buffer],
      };
    }
    case "previewProjectDataImport": {
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
      const input =
        operation.input instanceof Uint8Array ? parseProjectDataImportBytes(operation.input) : operation.input;
      return { value: store.importProjectData(input) };
    }
  }
}

function handleClose(stores: Array<WorkIntelligenceStore | undefined>, request: BackupWorkerCloseRequest): void {
  try {
    for (const store of stores) store?.close();
    parentPort?.postMessage({ id: request.id, ok: true, value: null } satisfies BackupWorkerReply);
  } catch (error) {
    parentPort?.postMessage(errorResponse(request.id, error));
  } finally {
    parentPort?.close();
  }
}

const workerContext = workerData as BackupWorkerData;
const port = parentPort;
let store: WorkIntelligenceStore | undefined;
let writer: WorkIntelligenceStore | undefined;
const stores = {
  reader(): WorkIntelligenceStore {
    store ??= new WorkIntelligenceStore(workerContext.databasePath, {
      backup: workerContext.backup,
      mode: "read-only",
      expectedSchemaVersion: workerContext.expectedSchemaVersion,
    });
    return store;
  },
  writer(): WorkIntelligenceStore {
    writer ??= new WorkIntelligenceStore(workerContext.databasePath, {
      backup: workerContext.backup,
      mode: "existing",
      expectedSchemaVersion: workerContext.expectedSchemaVersion,
    });
    return writer;
  },
};

if (!port) {
  throw new Error("The backup worker requires a parent thread.");
}

port.on("message", (message: BackupWorkerRequest | BackupWorkerCloseRequest) => {
  if ("close" in message) {
    handleClose([store, writer], message);
    return;
  }

  try {
    const result = executeOperation(stores, message.operation);
    port.postMessage(
      { id: message.id, ok: true, value: result.value } satisfies BackupWorkerReply,
      result.transferList,
    );
  } catch (error) {
    port.postMessage(errorResponse(message.id, error));
  }
});
