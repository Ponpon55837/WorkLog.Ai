/**
 * The backup worker ran out of heap memory while holding a request. The worker is gone and the database was not
 * changed by this request (an import commits in one transaction after parsing and validating), so the API reports
 * it as a request the server could not process, and the next request starts a fresh worker.
 */
export class BackupWorkerOutOfMemoryError extends Error {
  public readonly code = "backup_worker_out_of_memory" as const;

  public constructor(options?: ErrorOptions) {
    super("The backup worker ran out of memory.", options);
    this.name = "BackupWorkerOutOfMemoryError";
  }
}

/** An operation did not finish within the watchdog time and its process was stopped. */
export class BackupWorkerTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(
      `The background worker did not finish "${operation}" within ${Math.round(timeoutMs / 1000)} s and was stopped.`,
    );
    this.name = "BackupWorkerTimeoutError";
  }
}
