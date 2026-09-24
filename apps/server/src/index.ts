import { createServer } from "node:http";
import { DEFAULT_SERVER_PORT } from "@work-intelligence/shared";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { databasePath, storeOptions } from "./config.js";
import { createApiHandler } from "./server.js";

const port = Number(process.env.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT);
const store = new WorkIntelligenceStore(databasePath, storeOptions);
const server = createServer(createApiHandler(store));

server.listen(port, "127.0.0.1", () => {
  console.error(`Work Intelligence API listening on http://127.0.0.1:${port}`);
  console.error(`SQLite database: ${databasePath}`);
});

// Daily automatic backup: checked at start and hourly; a backup is written once the newest is a day old.
const backupCheckMs = 60 * 60 * 1000;
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
const backupTimer =
  process.env.WORK_INTELLIGENCE_BACKUP === "off" ? undefined : setInterval(backupIfDue, backupCheckMs);
backupTimer?.unref();
if (backupTimer) {
  backupIfDue();
}

function shutdown(): void {
  clearInterval(backupTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
