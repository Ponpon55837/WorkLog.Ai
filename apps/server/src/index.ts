import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER_PORT } from "@work-intelligence/shared";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { createApiHandler } from "./server.js";

const port = Number(process.env.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT);
const repoDataPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite");
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? repoDataPath;
const store = new WorkIntelligenceStore(databasePath);
const server = createServer(createApiHandler(store));

server.listen(port, "127.0.0.1", () => {
  console.error(`Work Intelligence API listening on http://127.0.0.1:${port}`);
  console.error(`SQLite database: ${databasePath}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
