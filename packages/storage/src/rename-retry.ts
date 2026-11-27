import { renameSync } from "node:fs";

/** Errors a Windows file lock raises while an antivirus scanner or the search indexer briefly holds a file. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);
const RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The wait blocks the thread, which is fine for the offline restore it serves. */
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
