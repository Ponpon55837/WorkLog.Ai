export class UsageScanAbortedError extends Error {
  constructor() {
    super("Usage scan was aborted.");
    this.name = "UsageScanAbortedError";
  }
}

export class UsageScanTimeoutError extends Error {
  constructor() {
    super("Usage scan timed out.");
    this.name = "UsageScanTimeoutError";
  }
}

export function checkScanLimits(signal: AbortSignal | undefined, deadlineMs: number | undefined): void {
  if (signal?.aborted) throw new UsageScanAbortedError();
  if (deadlineMs !== undefined && Date.now() > deadlineMs) throw new UsageScanTimeoutError();
}
