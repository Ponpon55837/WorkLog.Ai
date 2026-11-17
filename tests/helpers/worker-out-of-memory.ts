import type { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";

interface ClientInternals {
  lifetime?: { worker: Worker };
  pending: Map<number, unknown>;
}

/**
 * On Node 24 a real worker heap exhaustion can abort the whole test process, so tests inject the failure instead:
 * the live worker reports `ERR_WORKER_OUT_OF_MEMORY` and exits, which is the sequence Node produces (error event,
 * then exit).
 */
export function liveWorker(client: object): Worker {
  const worker = (client as ClientInternals).lifetime?.worker;
  if (!worker) throw new Error("The backup worker client has no live worker.");
  return worker;
}

/** Makes the live worker swallow requests, so they stay pending until the worker is failed. */
export function holdWorkerRequests(client: object): void {
  liveWorker(client).postMessage = () => undefined;
}

/** Waits until `count` requests are pending in the client, then fails the live worker with an out-of-memory error. */
export async function failWorkerWithOutOfMemory(client: object, count: number): Promise<void> {
  const internals = client as ClientInternals;
  const worker = liveWorker(client);
  while (internals.pending.size < count) await setImmediate();
  worker.emit(
    "error",
    Object.assign(new Error("Worker terminated due to reaching memory limit"), {
      code: "ERR_WORKER_OUT_OF_MEMORY",
    }),
  );
  await worker.terminate();
}
