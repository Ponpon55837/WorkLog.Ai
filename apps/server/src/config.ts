import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePathFor } from "@work-intelligence/shared/database-location";
import { backupOptionsFromEnvironment, type WorkIntelligenceStoreOptions } from "@work-intelligence/storage";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The database the API server, MCP server, and CLI share, resolved by the same rule as every other entry point:
 * WORK_INTELLIGENCE_DB (relative paths resolve from the repository root, not the process cwd) or data/ in the repo;
 * a standalone bundle uses ~/.work-intelligence instead.
 */
export const databasePath = databasePathFor(repositoryRoot);

export const storeOptions: WorkIntelligenceStoreOptions = { backup: backupOptionsFromEnvironment(databasePath) };
