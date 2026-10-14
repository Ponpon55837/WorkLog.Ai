import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabasePath } from "@work-intelligence/shared/database-path";
import { backupOptionsFromEnvironment, type WorkIntelligenceStoreOptions } from "@work-intelligence/storage";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The database the API server, MCP server, and CLI share: WORK_INTELLIGENCE_DB (relative paths resolve from the
 * repository root, not the process cwd), or data/ in the repo.
 */
export const databasePath = resolveDatabasePath(process.env.WORK_INTELLIGENCE_DB, {
  baseDirectory: repositoryRoot,
  fallback: resolve(repositoryRoot, "data", "work-intelligence.sqlite"),
});

export const storeOptions: WorkIntelligenceStoreOptions = { backup: backupOptionsFromEnvironment(databasePath) };
