export { WorkIntelligenceStore, type WorkIntelligenceStoreOptions } from "./store.js";
export type { TrackedScopeInput } from "./store.js";
export { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
export {
  DatabaseRedactionError,
  redactDatabase,
  type DatabaseRedactionErrorCode,
  type DatabaseRedactionResult,
} from "./database-redaction.js";
export { combineRedactionSummaries, redactText, redactValue } from "./secret-redaction.js";
export { toSessionDigest, toSessionDigests } from "./digest.js";
export type { SessionDigest } from "@work-intelligence/core";
export { backupOptionsFromEnvironment } from "./backup-environment.js";
export {
  DEFAULT_BACKUP_KEEP,
  deleteDatabaseBackup,
  isSafeDatabaseBackupFileName,
  restoreDatabase,
  type RestoreDatabaseResult,
  type RestorePathRemap,
} from "./backup.js";
export { ProjectDataTransferError, type ProjectDataTransferErrorCode } from "./project-data-transfer.js";
export { DatabaseInitializationError, type DatabaseInitializationErrorCode } from "./database-initialization.js";
export { DATABASE_BUSY_MESSAGE, isDatabaseBusyError } from "./sqlite-errors.js";
export { canonicalizeProjectRoot } from "@work-intelligence/project-policy";
export { ProjectDeletionError, type ProjectDeletionErrorCode } from "./project-deletion-service.js";
export { ProjectLocationError, type ProjectLocationErrorCode } from "./project-location-service.js";
export {
  DatabaseMaintenanceError,
  maintainDatabase,
  type DatabaseMaintenanceErrorCode,
  type DatabaseMaintenanceResult,
} from "./database-maintenance.js";
