import type { Server } from "node:http";

/** @internal test-only */
export interface ShutdownSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * Well under the 10 s the desktop App waits for the whole shutdown, so the worker and database still close before a kill.
 * @internal test-only
 */
export const DEFAULT_CONNECTION_GRACE_MS = 7_000;

export interface GracefulShutdownOptions {
  server: Server;
  stopBackgroundWork: () => void;
  closeEventStreams: () => void;
  closeBackgroundWork: () => Promise<void>;
  closeDatabase: () => void;
  connectionGraceMs?: number;
  onBackgroundWorkCloseError: (error: unknown) => void;
  onDatabaseCloseError: (error: unknown) => void;
  onStepError?: (step: "stopBackgroundWork" | "closeEventStreams" | "closeServer", error: unknown) => void;
}

// Every call returns the same promise, which always resolves and only once SQLite is closed; every step runs even if an
// earlier one throws.
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
