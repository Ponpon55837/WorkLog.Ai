import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { getMcpRestartStatus, type McpRestartStatus, registerMcpProcess } from "@work-intelligence/shared/mcp-runtime";
import { backupOptionsFromEnvironment, LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "@work-intelligence/storage";
import { databasePathFor, STANDALONE } from "./database-location.js";
import { createWorkIntelligenceMcpServer } from "./server.js";
import { McpStoreAccess } from "./store-access.js";
import { createLauncherUpdateCheck, readLauncherIdentity, supervisedRestartStatus } from "./supervision.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";
const MCP_BUILD_COMPATIBILITY_ID = "__WORK_INTELLIGENCE_COMPATIBILITY__";
const runningBuild = /^[a-f0-9]{64}$/.test(MCP_BUILD_DIST_HASH)
  ? {
      version: APP_VERSION,
      distHash: MCP_BUILD_DIST_HASH,
      buildId: `${APP_VERSION}:${MCP_BUILD_DIST_HASH}`,
      compatibilityId: MCP_BUILD_COMPATIBILITY_ID,
      schemaVersion: LATEST_SCHEMA_VERSION,
    }
  : undefined;
const databasePath = databasePathFor(resolve(appRoot, "../.."));

/** Under the launcher a new build switches automatically; started directly, it requires reconnecting. */
function restartStatusReader(): () => McpRestartStatus {
  const launcher = readLauncherIdentity();
  if (!launcher) return () => getMcpRestartStatus(repositoryRoot, runningBuild);
  const launcherUpdated = createLauncherUpdateCheck(launcher);
  return () => supervisedRestartStatus(getMcpRestartStatus(repositoryRoot, runningBuild), launcher, launcherUpdated());
}

async function startMcpServer(): Promise<void> {
  const storeAccess = new McpStoreAccess(
    () => new WorkIntelligenceStore(databasePath, { backup: backupOptionsFromEnvironment(databasePath) }),
    {
      onFailure: (failure) =>
        console.error(`Work Intelligence MCP database unavailable (${failure.code}): ${failure.message}`),
    },
  );
  const startupFailure = storeAccess.startupFailure;

  try {
    // A standalone bundle is replaced as a whole on update, so there is no on-disk build to watch.
    if (!STANDALONE) {
      try {
        registerMcpProcess(repositoryRoot, runningBuild);
      } catch {
        console.error("Work Intelligence MCP runtime 狀態無法寫入；本次連線仍會回報本機建置狀態。");
      }
    }
    const server = createWorkIntelligenceMcpServer(
      storeAccess,
      APP_VERSION,
      LATEST_SCHEMA_VERSION,
      undefined,
      STANDALONE ? undefined : restartStatusReader(),
    );
    await server.connect(new StdioServerTransport());
    if (!startupFailure) {
      console.error(
        `Work Intelligence MCP server ${APP_VERSION} (schema ${LATEST_SCHEMA_VERSION}) connected using ${databasePath}`,
      );
    }
  } catch (error) {
    console.error("Work Intelligence MCP transport 無法啟動。");
    storeAccess.close();
    process.exitCode = 1;
  }
}

await startMcpServer();
