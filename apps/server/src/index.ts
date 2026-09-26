import { createServer } from "node:http";
import { DatabaseInitializationError, WorkIntelligenceStore } from "@work-intelligence/storage";
import { databasePath, storeOptions } from "./config.js";
import { describeListenError } from "./listen-error.js";
import { createApiHandler } from "./server.js";
import { DEFAULT_SERVER_PORT } from "./server-port.js";
import { registerGracefulShutdown } from "./shutdown.js";

function startApi(): void {
  let store: WorkIntelligenceStore;
  try {
    store = new WorkIntelligenceStore(databasePath, storeOptions);
  } catch (error) {
    console.error(error instanceof DatabaseInitializationError ? error.message : "Work Intelligence API 無法啟動。");
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT);
  const webDirectory = process.env.WORK_INTELLIGENCE_WEB_DIST;
  const apiHandler = createApiHandler(store, webDirectory ? { webDirectory } : {});
  const server = createServer(apiHandler);

  // Daily automatic backup: checked once listening and hourly; a backup is written once the newest is a day old.
  const backupCheckMs = 60 * 60 * 1000;
  let backupTimer: NodeJS.Timeout | undefined;
  function backupIfDue(): void {
    try {
      const created = store.backupIfDue();
      if (created) {
        console.error(`Database backup written: ${created.created.fileName}`);
      }
    } catch (error) {
      console.error(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function onListenError(error: Error): void {
    console.error(describeListenError(error, port));
    store.close();
    process.exitCode = 1;
  }
  server.once("error", onListenError);

  server.listen(port, "127.0.0.1", () => {
    server.off("error", onListenError);
    console.error(`Work Intelligence API listening on http://127.0.0.1:${port}`);
    console.error(`SQLite database: ${databasePath}`);
    if (process.env.WORK_INTELLIGENCE_BACKUP !== "off") {
      backupTimer = setInterval(backupIfDue, backupCheckMs);
      backupTimer.unref();
      backupIfDue();
    }
  });

  registerGracefulShutdown(
    {
      server,
      stopBackgroundWork: () => clearInterval(backupTimer),
      closeEventStreams: () => apiHandler.closeEventStreams(),
      closeDatabase: () => store.close(),
      onDatabaseCloseError: () => {
        console.error("Work Intelligence API could not close the database cleanly.");
        process.exitCode = 1;
      },
    },
    process,
  );
}

startApi();
