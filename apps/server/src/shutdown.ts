import type { Server } from "node:http";

export interface ShutdownSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  server: Server;
  stopBackgroundWork: () => void;
  closeEventStreams: () => void;
  closeDatabase: () => void;
  onDatabaseCloseError: (error: unknown) => void;
}

/** Stops new work, ends long-lived streams, then closes SQLite after active HTTP requests drain. */
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
      try {
        options.closeDatabase();
      } catch (error) {
        options.onDatabaseCloseError(error);
      }
    });
  };

  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
  return shutdown;
}
