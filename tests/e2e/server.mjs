import { createServer } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";
import { storeOptions } from "../../apps/server/dist/config.js";
import { createApiHandler } from "../../apps/server/dist/server.js";

const store = new WorkIntelligenceStore(process.env.WORK_INTELLIGENCE_DB, storeOptions);
const handler = createApiHandler(store, {
  webDirectory: resolve("apps/web/dist"),
  userServiceStatus: () => ({
    supported: false,
    state: "unsupported",
    manager: null,
    enabled: false,
    running: false,
    configPath: null,
    databasePath: process.env.WORK_INTELLIGENCE_DB,
    backupDirectory: process.env.WORK_INTELLIGENCE_BACKUP_DIR,
    logPath: null,
  }),
  agentConnections: () => ({
    codex: { mcpRegistered: "missing", canonicalSkill: "missing", legacySkill: "missing", hook: "missing" },
    claudeCode: { mcpRegistered: "missing", skill: "missing", hook: "missing" },
  }),
});
const server = createServer(handler);
server.listen(Number(process.env.WORK_INTELLIGENCE_PORT), "127.0.0.1");
