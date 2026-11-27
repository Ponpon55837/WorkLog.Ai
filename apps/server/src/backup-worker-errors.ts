export class BackupWorkerOutOfMemoryError extends Error {
  public readonly code = "backup_worker_out_of_memory" as const;

  public constructor(options?: ErrorOptions) {
    super("The backup worker ran out of memory.", options);
    this.name = "BackupWorkerOutOfMemoryError";
  }
}

export class BackupWorkerTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(
      `The background worker did not finish "${operation}" within ${Math.round(timeoutMs / 1000)} s and was stopped.`,
    );
    this.name = "BackupWorkerTimeoutError";
  }
}
