import { parentPort, workerData } from "node:worker_threads";
import { WorkIntelligenceStore, type BackupRetentionOptions } from "@work-intelligence/storage";
import { inspectProjectFolder } from "./http.js";
import type {
  BackupWorkerCloseRequest,
  BackupWorkerOperation,
  BackupWorkerReply,
  BackupWorkerRequest,
} from "./backup-worker-client.js";

interface BackupWorkerData {
  databasePath: string;
  backup: BackupRetentionOptions;
}

function errorResponse(id: number, error: unknown): BackupWorkerReply {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
    return {
      id,
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        ...(candidate.code === undefined ? {} : { code: candidate.code }),
        ...(candidate.errcode === undefined ? {} : { errcode: candidate.errcode }),
        ...(candidate.errstr === undefined ? {} : { errstr: candidate.errstr }),
      },
    };
  }
  return { id, ok: false, error: { name: "Error", message: String(error) } };
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
      const preview = store.previewProjectDataImport(operation.input);
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
const store = new WorkIntelligenceStore(workerContext.databasePath, { backup: workerContext.backup });
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
