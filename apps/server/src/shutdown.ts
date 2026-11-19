import type { Server } from "node:http";

/** @internal test-only */
export interface ShutdownSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * How long in-flight requests may finish after shutdown starts before their sockets are destroyed. It stays well under
 * the 10 s the desktop App waits for the whole shutdown (`gracefulMs`), so a request that runs to the end of the grace
 * still leaves time to close the worker and the database before the App escalates to a kill.
 * @internal test-only
 */
export const DEFAULT_CONNECTION_GRACE_MS = 7_000;

export interface GracefulShutdownOptions {
  server: Server;
  stopBackgroundWork: () => void;
  closeEventStreams: () => void;
  closeBackgroundWork: () => Promise<void>;
  closeDatabase: () => void;
  /** Grace period for open connections (stuck clients included); after it they are destroyed so `server.close` completes. */
  connectionGraceMs?: number;
  onBackgroundWorkCloseError: (error: unknown) => void;
  onDatabaseCloseError: (error: unknown) => void;
  /** A step before the drain (`stopBackgroundWork`, `closeEventStreams`, `server.close`) threw; shutdown goes on. */
  onStepError?: (step: "stopBackgroundWork" | "closeEventStreams" | "closeServer", error: unknown) => void;
}

/**
 * Stops new scheduled work, drains HTTP requests (idle keep-alive sockets close at once, the rest after a grace
 * period, so a stalled client cannot keep the process alive) and the worker, then closes SQLite. The returned function can be
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
      let graceTimer: NodeJS.Timeout | undefined;
      const drained = (): void => {
        clearTimeout(graceTimer);
        void closeAfterDrain()
          .catch(() => undefined)
          .then(resolve);
      };
      try {
        options.server.close(drained);
        options.server.closeIdleConnections();
        graceTimer = setTimeout(
          () => options.server.closeAllConnections(),
          options.connectionGraceMs ?? DEFAULT_CONNECTION_GRACE_MS,
        );
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
