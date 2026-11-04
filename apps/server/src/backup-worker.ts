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

function executeOperation(store: WorkIntelligenceStore, operation: BackupWorkerOperation): unknown {
  switch (operation.type) {
    case "createBackup":
      return store.createBackup();
    case "backupIfDue":
      return store.backupIfDue();
    case "exportTo":
      return store.exportTo(operation.target);
    case "exportProjectData": {
      const content = JSON.stringify(store.exportProjectData(operation.scope));
      return { content, bytes: Buffer.byteLength(content) };
    }
    case "previewProjectDataImport": {
      const input =
        operation.input instanceof Uint8Array ? parseProjectDataImportBytes(operation.input) : operation.input;
      const preview = store.previewProjectDataImport(input);
      return {
        ...preview,
        selectedProjects: preview.selectedProjects.map((project) => ({
          ...project,
          folderStatus: inspectProjectFolder(project.rootPath),
        })),
      };
    }
  }
}

function handleClose(store: WorkIntelligenceStore, request: BackupWorkerCloseRequest): void {
  try {
    store.close();
    parentPort?.postMessage({ id: request.id, ok: true, value: null } satisfies BackupWorkerReply);
  } catch (error) {
    parentPort?.postMessage(errorResponse(request.id, error));
  } finally {
    parentPort?.close();
  }
}

const workerContext = workerData as BackupWorkerData;
const store = new WorkIntelligenceStore(workerContext.databasePath, {
  backup: workerContext.backup,
  mode: "read-only",
  expectedSchemaVersion: workerContext.expectedSchemaVersion,
});
const port = parentPort;

if (!port) {
  store.close();
  throw new Error("The backup worker requires a parent thread.");
}

port.on("message", (message: BackupWorkerRequest | BackupWorkerCloseRequest) => {
  if ("close" in message) {
    handleClose(store, message);
    return;
  }

  try {
    const value = executeOperation(store, message.operation);
    port.postMessage({ id: message.id, ok: true, value } satisfies BackupWorkerReply);
  } catch (error) {
    port.postMessage(errorResponse(message.id, error));
  }
});
