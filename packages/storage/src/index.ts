export { toAgentReport, toAgentReportContext } from "./report-agent-view.js";
export { AttentionPreferenceError } from "./attention-service.js";
export { ReportPresentationError } from "./report-presentation-service.js";
export { WorkIntelligenceStore, type WorkIntelligenceStoreOptions } from "./store.js";
export type { FinalizeSessionContext, TrackedScopeInput } from "./store.js";
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
  type BackupRetentionOptions,
  type RestoreDatabaseResult,
  type RestorePathRemap,
} from "./backup.js";
export {
  OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION,
  ProjectDataTransferError,
  ValidatedProjectDataImport,
  type ProjectDataTransferErrorCode,
} from "./project-data-transfer.js";
export {
  assertDatabaseSchemaVersion,
  DatabaseInitializationError,
  type DatabaseInitializationErrorCode,
  initializeWorkIntelligenceDatabase,
} from "./database-initialization.js";
export {
  DATABASE_BUSY_MESSAGE,
  DATABASE_DISK_FULL_MESSAGE,
  DATABASE_READ_ONLY_MESSAGE,
  databaseUnavailableMessage,
  databaseUnavailableReason,
  isDatabaseBusyError,
} from "./sqlite-errors.js";
export type { DatabaseUnavailableReason } from "./sqlite-errors.js";
export { canonicalizeProjectRoot, isPathWithinProject } from "@work-intelligence/project-policy";
export { ProjectDeletionError, type ProjectDeletionErrorCode } from "./project-deletion-service.js";
export { SessionDeletionError, type SessionDeletionErrorCode } from "./session-deletion-service.js";
export { ProjectLocationError, type ProjectLocationErrorCode } from "./project-location-service.js";
export {
  DatabaseMaintenanceError,
  maintainDatabase,
  type DatabaseMaintenanceErrorCode,
  type DatabaseMaintenanceResult,
} from "./database-maintenance.js";
export {
  extractAgentReadRecords,
  AGENT_READ_AUDIT_MAX_AGE_DAYS,
  AGENT_READ_AUDIT_MAX_IDS,
  AGENT_READ_AUDIT_MAX_ROWS,
  AGENT_READ_FALLBACK_ERROR_CODE,
} from "./agent-read-audit-service.js";
export type {
  AgentReadAuditItem,
  AgentReadAuditPage,
  AgentReadRecordType,
  AgentReadReference,
  AgentReadReferences,
  AgentReadStats,
  AgentReadToolStats,
  SummarizeAgentReadsOptions,
} from "./agent-read-audit-service.js";
