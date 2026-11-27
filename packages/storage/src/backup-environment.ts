import { dirname, resolve } from "node:path";
import { DEFAULT_BACKUP_KEEP, type BackupRetentionOptions } from "./backup.js";

/** A relative WORK_INTELLIGENCE_BACKUP_DIR resolves beside the database, so every process agrees on one location. */
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
