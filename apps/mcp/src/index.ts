import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { getMcpRestartStatus, registerMcpProcess } from "@work-intelligence/shared/mcp-runtime";
import {
  backupOptionsFromEnvironment,
  DatabaseInitializationError,
  LATEST_SCHEMA_VERSION,
  WorkIntelligenceStore,
} from "@work-intelligence/storage";
import { createWorkIntelligenceMcpServer } from "./server.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";
const runningBuild = /^[a-f0-9]{64}$/.test(MCP_BUILD_DIST_HASH)
  ? { version: APP_VERSION, distHash: MCP_BUILD_DIST_HASH, buildId: `${APP_VERSION}:${MCP_BUILD_DIST_HASH}` }
  : undefined;
const repoDataPath = resolve(appRoot, "../../data", "work-intelligence.sqlite");
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? repoDataPath;

async function startMcpServer(): Promise<void> {
  let store: WorkIntelligenceStore | null = null;
  let startupFailure: { code: string; message: string } | undefined;
  try {
    store = new WorkIntelligenceStore(databasePath, { backup: backupOptionsFromEnvironment(databasePath) });
  } catch (error) {
    startupFailure =
      error instanceof DatabaseInitializationError
        ? { code: error.code, message: error.message }
        : {
            code: "DATABASE_INITIALIZATION_FAILED",
            message: "Work Intelligence 資料庫無法開啟，請檢查資料庫檔案、目錄與權限。",
          };
    console.error(`Work Intelligence MCP database unavailable (${startupFailure.code}): ${startupFailure.message}`);
  }

  try {
    try {
      registerMcpProcess(repositoryRoot, runningBuild);
    } catch {
      console.error("Work Intelligence MCP runtime 狀態無法寫入；本次連線仍會回報本機建置狀態。");
    }
    const server = createWorkIntelligenceMcpServer(store, APP_VERSION, LATEST_SCHEMA_VERSION, startupFailure, () =>
      getMcpRestartStatus(repositoryRoot, runningBuild),
    );
    await server.connect(new StdioServerTransport());
    if (!startupFailure) {
      console.error(
        `Work Intelligence MCP server ${APP_VERSION} (schema ${LATEST_SCHEMA_VERSION}) connected using ${databasePath}`,
      );
    }
  } catch (error) {
    console.error("Work Intelligence MCP transport 無法啟動。");
    store?.close();
    process.exitCode = 1;
  }
}

await startMcpServer();
