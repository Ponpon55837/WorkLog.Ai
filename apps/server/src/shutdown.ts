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
}

/** Stops new scheduled work, drains HTTP requests and the worker, then closes SQLite. */
export function registerGracefulShutdown(
  options: GracefulShutdownOptions,
  signals: ShutdownSignalSource = process,
): () => void {
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    options.stopBackgroundWork();
    options.closeEventStreams();
    options.server.close(() => {
      void (async () => {
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
      })();
    });
  };

  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
  return shutdown;
}
