import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { MCP_SELFTEST_ENVIRONMENT } from "@work-intelligence/shared/mcp-contract-fingerprint";
import { getMcpRestartStatus, type McpRestartStatus, registerMcpProcess } from "@work-intelligence/shared/mcp-runtime";
import { backupOptionsFromEnvironment, LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "@work-intelligence/storage";
import { AgentObservationRecorder } from "./agent-observation.js";
import { configDirectory, databasePathFor, STANDALONE } from "./database-location.js";
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

/**
 * The desktop self-test only has to see the server start and list its tools. It must not migrate or back up the
 * user's database or write runtime state, so no store is opened and every tool answers this startup failure.
 */
async function startSelfTestServer(): Promise<void> {
  const server = createWorkIntelligenceMcpServer(null, APP_VERSION, LATEST_SCHEMA_VERSION, {
    code: "SELFTEST_NO_DATABASE",
    message: "The desktop self-test does not open the database.",
  });
  await server.connect(new StdioServerTransport());
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
    const transport = new StdioServerTransport();
    // Fail-open: observing the host never blocks or fails the session, and stdout stays protocol-only.
    new AgentObservationRecorder({
      directory: configDirectory(),
      serverVersion: APP_VERSION,
      onError: () => console.error("Work Intelligence MCP 無法記錄 Agent 連線觀察；MCP 連線不受影響。"),
    }).attach(server, transport);
    await server.connect(transport);
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

await (process.env[MCP_SELFTEST_ENVIRONMENT] === "1" ? startSelfTestServer() : startMcpServer());
