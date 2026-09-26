export { WorkIntelligenceStore, type WorkIntelligenceStoreOptions } from "./store.js";
export type { TrackedScopeInput } from "./store.js";
export { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
export { toSessionDigest } from "./digest.js";
export type { SessionDigest } from "@work-intelligence/core";
export { backupOptionsFromEnvironment } from "./backup-environment.js";
export { DEFAULT_BACKUP_KEEP, restoreDatabase, type RestoreDatabaseResult, type RestorePathRemap } from "./backup.js";
export { ProjectDataTransferError, type ProjectDataTransferErrorCode } from "./project-data-transfer.js";
export { DatabaseInitializationError, type DatabaseInitializationErrorCode } from "./database-initialization.js";
export { ProjectDeletionError, type ProjectDeletionErrorCode } from "./project-deletion-service.js";
export {
  DatabaseMaintenanceError,
  maintainDatabase,
  type DatabaseMaintenanceErrorCode,
  type DatabaseMaintenanceResult,
} from "./database-maintenance.js";
