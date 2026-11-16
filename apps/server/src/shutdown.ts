import type { Server } from "node:http";

export interface ShutdownSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  server: Server;
  stopBackgroundWork: () => void;
  closeEventStreams: () => void;
  closeBackgroundWork: () => Promise<void>;
  closeDatabase: () => void;
  onBackgroundWorkCloseError: (error: unknown) => void;
  onDatabaseCloseError: (error: unknown) => void;
  /** A step before the drain (`stopBackgroundWork`, `closeEventStreams`, `server.close`) threw; shutdown goes on. */
  onStepError?: (step: "stopBackgroundWork" | "closeEventStreams" | "closeServer", error: unknown) => void;
}

/**
 * Stops new scheduled work, drains HTTP requests and the worker, then closes SQLite. The returned function can be
 * called by anyone (the signals call it too); every call returns the same promise, which resolves only once SQLite
 * is closed, so a caller can wait for the whole shutdown instead of guessing. Every step runs even when an earlier one
 * throws, and the promise always resolves, so neither a signal handler nor a waiting caller can see a rejection.
 */
export function registerGracefulShutdown(
  options: GracefulShutdownOptions,
  signals: ShutdownSignalSource = process,
): () => Promise<void> {
  let finished: Promise<void> | undefined;

  const closeAfterDrain = async (): Promise<void> => {
    try {
      await options.closeBackgroundWork();
    } catch (error) {
      options.onBackgroundWorkCloseError(error);
    }
    try {
      options.closeDatabase();
    } catch (error) {
      options.onDatabaseCloseError(error);
    }
  };

  const attempt = (step: "stopBackgroundWork" | "closeEventStreams", run: () => void): void => {
    try {
      run();
    } catch (error) {
      options.onStepError?.(step, error);
    }
  };

  const shutdown = (): Promise<void> => {
    finished ??= new Promise<void>((resolve) => {
      attempt("stopBackgroundWork", () => options.stopBackgroundWork());
      attempt("closeEventStreams", () => options.closeEventStreams());
      const drained = (): void =>
        void closeAfterDrain()
          .catch(() => undefined)
          .then(resolve);
      try {
        options.server.close(drained);
      } catch (error) {
        options.onStepError?.("closeServer", error);
        drained();
      }
    });
    return finished;
  };

  signals.on("SIGINT", () => void shutdown());
  signals.on("SIGTERM", () => void shutdown());
  return shutdown;
}
