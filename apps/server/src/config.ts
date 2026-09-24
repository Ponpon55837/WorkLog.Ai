import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BACKUP_KEEP, type WorkIntelligenceStoreOptions } from "@work-intelligence/storage";

/** The database the API server, MCP server, and CLI share: WORK_INTELLIGENCE_DB, or data/ in the repo. */
export const databasePath =
  process.env.WORK_INTELLIGENCE_DB ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite");

const backupKeep = Number(process.env.WORK_INTELLIGENCE_BACKUP_KEEP);

export const storeOptions: WorkIntelligenceStoreOptions = {
  backup: {
    directory: process.env.WORK_INTELLIGENCE_BACKUP_DIR || undefined,
    keep: Number.isInteger(backupKeep) && backupKeep > 0 ? backupKeep : DEFAULT_BACKUP_KEEP,
  },
};
