import { renameSync } from "node:fs";

/** Errors a Windows file lock raises while an antivirus scanner or the search indexer briefly holds a file. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);
/** Waits before each retry: five attempts, 0.75 s in all. */
const RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `renameSync` that tries again when a file lock refuses it. Only these locks are retried; any other error, and the
 * last refusal, is thrown with its errno. The wait blocks the thread, which is fine for the offline restore it serves.
 */
export function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const { code } = (error ?? {}) as { code?: unknown };
      if (delay === undefined || typeof code !== "string" || !RETRYABLE_CODES.has(code)) throw error;
      pause(delay);
    }
  }
}
