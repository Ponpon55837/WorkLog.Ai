import { dirname, resolve } from "node:path";
import { DEFAULT_BACKUP_KEEP, type BackupRetentionOptions } from "./backup.js";

/**
 * Reads the backup settings shared by the API server, CLI, MCP server, and doctor.
 * A relative WORK_INTELLIGENCE_BACKUP_DIR resolves beside the database, so every process agrees
 * on one location regardless of the working directory its host starts it in.
 */
export function backupOptionsFromEnvironment(
  databasePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): BackupRetentionOptions {
  const directory = environment.WORK_INTELLIGENCE_BACKUP_DIR?.trim();
  const keep = Number(environment.WORK_INTELLIGENCE_BACKUP_KEEP);
  return {
    ...(directory ? { directory: resolve(dirname(databasePath), directory) } : {}),
    keep: Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_BACKUP_KEEP,
  };
}
