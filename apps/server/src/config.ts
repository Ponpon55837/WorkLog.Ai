import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupOptionsFromEnvironment, type WorkIntelligenceStoreOptions } from "@work-intelligence/storage";

/** The database the API server, MCP server, and CLI share: WORK_INTELLIGENCE_DB, or data/ in the repo. */
export const databasePath =
  process.env.WORK_INTELLIGENCE_DB ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite");

export const storeOptions: WorkIntelligenceStoreOptions = { backup: backupOptionsFromEnvironment(databasePath) };
