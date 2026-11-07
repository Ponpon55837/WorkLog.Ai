import { parentPort, workerData } from "node:worker_threads";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { serializeError } from "./worker-errors.js";
import type {
  ReadWorkerCloseRequest,
  ReadWorkerOperation,
  ReadWorkerReply,
  ReadWorkerRequest,
} from "./read-worker-client.js";

interface ReadWorkerData {
  databasePath: string;
  expectedSchemaVersion: number;
}

function executeOperation(store: WorkIntelligenceStore, operation: ReadWorkerOperation): unknown {
  switch (operation.type) {
    case "getReport":
      return store.getReport(operation.input);
    case "getGraph":
      return store.getGraph(operation.input);
    case "getHotspots":
      return store.getHotspots(operation.input);
  }
}

function handleClose(store: WorkIntelligenceStore | undefined, request: ReadWorkerCloseRequest): void {
  try {
    store?.close();
    parentPort?.postMessage({ id: request.id, ok: true, value: null } satisfies ReadWorkerReply);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: serializeError(error) } satisfies ReadWorkerReply);
  } finally {
    parentPort?.close();
  }
}

const workerContext = workerData as ReadWorkerData;
const port = parentPort;
let store: WorkIntelligenceStore | undefined;

if (!port) {
  throw new Error("The read worker requires a parent thread.");
}

port.on("message", (message: ReadWorkerRequest | ReadWorkerCloseRequest) => {
  if ("close" in message) {
    handleClose(store, message);
    return;
  }

  try {
    store ??= new WorkIntelligenceStore(workerContext.databasePath, {
      mode: "read-only",
      expectedSchemaVersion: workerContext.expectedSchemaVersion,
    });
    const value = executeOperation(store, message.operation);
    port.postMessage({ id: message.id, ok: true, value } satisfies ReadWorkerReply);
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: serializeError(error) } satisfies ReadWorkerReply);
  }
});
