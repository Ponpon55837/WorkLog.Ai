import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { DatabaseInitializationError, LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "@work-intelligence/storage";
import { createWorkIntelligenceMcpServer } from "./server.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDataPath = resolve(appRoot, "../../data", "work-intelligence.sqlite");
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? repoDataPath;

async function startMcpServer(): Promise<void> {
  let store: WorkIntelligenceStore | undefined;
  try {
    store = new WorkIntelligenceStore(databasePath);
    const server = createWorkIntelligenceMcpServer(store, APP_VERSION, LATEST_SCHEMA_VERSION);
    await server.connect(new StdioServerTransport());
    console.error(
      `Work Intelligence MCP server ${APP_VERSION} (schema ${LATEST_SCHEMA_VERSION}) connected using ${databasePath}`,
    );
  } catch (error) {
    console.error(error instanceof DatabaseInitializationError ? error.message : "Work Intelligence MCP 無法啟動。");
    store?.close();
    process.exitCode = 1;
  }
}

await startMcpServer();
