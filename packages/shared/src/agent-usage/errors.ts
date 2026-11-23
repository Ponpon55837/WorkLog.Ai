/** The scan was cancelled through its AbortSignal. The message never carries a path. */
export class UsageScanAbortedError extends Error {
  constructor() {
    super("Usage scan was aborted.");
    this.name = "UsageScanAbortedError";
  }
}

/** The scan ran past `deadlineMs`. The message never carries a path. */
export class UsageScanTimeoutError extends Error {
  constructor() {
    super("Usage scan timed out.");
    this.name = "UsageScanTimeoutError";
  }
}

/** Throws when the scan was aborted or is past its deadline. */
export function checkScanLimits(signal: AbortSignal | undefined, deadlineMs: number | undefined): void {
  if (signal?.aborted) throw new UsageScanAbortedError();
  if (deadlineMs !== undefined && Date.now() > deadlineMs) throw new UsageScanTimeoutError();
}
