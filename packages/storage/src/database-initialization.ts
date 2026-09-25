import type { DatabaseSync } from "node:sqlite";
import type { BackupRetentionOptions } from "./backup.js";
import { backupDatabaseBeforeMigration } from "./backup.js";
import { DATABASE_SCHEMA } from "./database-schema.js";
import {
  applySchemaMigrations,
  getAppliedSchemaVersions,
  getNextPendingSchemaMigrationVersion,
  LATEST_SCHEMA_VERSION,
} from "./schema-migrations.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export type DatabaseInitializationErrorCode =
  | "DATABASE_SCHEMA_VERSION_TOO_NEW"
  | "DATABASE_SCHEMA_VERSION_INVALID"
  | "DATABASE_MIGRATION_BACKUP_FAILED"
  | "DATABASE_MIGRATION_FAILED";

/** A safe, classified startup error that can be shown to a user without exposing SQLite details. */
export class DatabaseInitializationError extends Error {
  public constructor(
    public readonly code: DatabaseInitializationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseInitializationError";
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasUserTables(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { found?: number } | undefined;
  return Boolean(row?.found);
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).flatMap((column) =>
      column.name ? [column.name] : [],
    ),
  );
}

function hasPendingLegacyMigration(db: DatabaseSync): boolean {
  if (tableExists(db, "sessions")) {
    const columns = tableColumns(db, "sessions");
    if (
      ["execution_status", "changed_files_provenance_json", "changed_file_changes_json", "work_summary_json"].some(
        (column) => !columns.has(column),
      ) ||
      columns.has("commit_required")
    ) {
      return true;
    }
  }

  if (tableExists(db, "report_summaries")) {
    const columns = tableColumns(db, "report_summaries");
    if (["themes_json", "verification_json", "comparison_json"].some((column) => !columns.has(column))) {
      return true;
    }
  }

  const metadataBackfillTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'metadata_backfill_requests'")
    .get() as { sql?: string | null } | undefined;
  return Boolean(metadataBackfillTable?.sql && !metadataBackfillTable.sql.includes("'cancelled'"));
}

function migrateLegacySchema(db: DatabaseSync): void {
  const columns = tableColumns(db, "sessions");
  if (!columns.has("execution_status")) {
    db.exec("ALTER TABLE sessions ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'completed'");
  }
  if (!columns.has("changed_files_provenance_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN changed_files_provenance_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("changed_file_changes_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN changed_file_changes_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("work_summary_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN work_summary_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (columns.has("commit_required")) {
    db.exec("ALTER TABLE sessions DROP COLUMN commit_required");
  }

  const reportSummaryColumns = tableColumns(db, "report_summaries");
  if (!reportSummaryColumns.has("themes_json")) {
    db.exec("ALTER TABLE report_summaries ADD COLUMN themes_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!reportSummaryColumns.has("verification_json")) {
    db.exec("ALTER TABLE report_summaries ADD COLUMN verification_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!reportSummaryColumns.has("comparison_json")) {
    db.exec("ALTER TABLE report_summaries ADD COLUMN comparison_json TEXT NOT NULL DEFAULT '[]'");
  }

  const metadataBackfillTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'metadata_backfill_requests'")
    .get() as { sql?: string | null } | undefined;
  if (metadataBackfillTable?.sql && !metadataBackfillTable.sql.includes("'cancelled'")) {
    db.exec(`
      DROP INDEX IF EXISTS idx_metadata_backfill_requests_status;
      DROP INDEX IF EXISTS idx_metadata_backfill_requests_scope;
      ALTER TABLE metadata_backfill_requests RENAME TO metadata_backfill_requests_legacy;
      CREATE TABLE metadata_backfill_requests (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        failure_reason TEXT,
        source_session_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO metadata_backfill_requests (
        id, idempotency_key, scope_type, project_id, status, requested_at,
        started_at, completed_at, failure_reason, source_session_ids_json
      )
      SELECT id, idempotency_key, scope_type, project_id, status, requested_at,
        started_at, completed_at, failure_reason, source_session_ids_json
      FROM metadata_backfill_requests_legacy;
      DROP TABLE metadata_backfill_requests_legacy;
      CREATE INDEX idx_metadata_backfill_requests_status ON metadata_backfill_requests(status, requested_at DESC);
      CREATE INDEX idx_metadata_backfill_requests_scope ON metadata_backfill_requests(project_id, status, requested_at DESC);
    `);
  }
}

function assertSchemaVersionSupported(db: DatabaseSync): void {
  if (!tableExists(db, "schema_migrations")) {
    return;
  }
  const versions = getAppliedSchemaVersions(db);
  if (versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new DatabaseInitializationError(
      "DATABASE_SCHEMA_VERSION_INVALID",
      "資料庫的 schema 版本資訊無效；Work Intelligence 尚未修改資料庫。請更新 Work Intelligence 或從備份還原。",
    );
  }
  const databaseVersion = Math.max(0, ...versions);
  if (databaseVersion > LATEST_SCHEMA_VERSION) {
    throw new DatabaseInitializationError(
      "DATABASE_SCHEMA_VERSION_TOO_NEW",
      `資料庫 schema 版本 ${databaseVersion} 比此程式支援的版本 ${LATEST_SCHEMA_VERSION} 新。請更新 Work Intelligence 後再開啟資料庫。`,
    );
  }
}

/** Checks compatibility, snapshots pending upgrades, then initializes and migrates atomically. */
export function initializeWorkIntelligenceDatabase(
  db: DatabaseSync,
  databasePath: string,
  backupOptions: BackupRetentionOptions = {},
): void {
  assertSchemaVersionSupported(db);

  const isFreshDatabase = !hasUserTables(db);
  const nextMigrationVersion = getNextPendingSchemaMigrationVersion(db);
  const legacyMigrationPending = hasPendingLegacyMigration(db);
  const migrationPending = nextMigrationVersion !== undefined || legacyMigrationPending;

  if (!isFreshDatabase && migrationPending && databasePath !== ":memory:") {
    const backupSchemaVersion = nextMigrationVersion ?? LATEST_SCHEMA_VERSION;
    try {
      backupDatabaseBeforeMigration(db, databasePath, backupSchemaVersion, backupOptions);
    } catch (error) {
      throw new DatabaseInitializationError(
        "DATABASE_MIGRATION_BACKUP_FAILED",
        "migration 前自動備份失敗；為保護資料，Work Intelligence 已停止開啟這個資料庫。請檢查備份目錄後再試。",
        { cause: error },
      );
    }
  }

  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    runImmediateTransaction(db, () => {
      db.exec(DATABASE_SCHEMA);
      migrateLegacySchema(db);
      applySchemaMigrations(db);
    });
  } catch (error) {
    if (error instanceof DatabaseInitializationError) {
      throw error;
    }
    throw new DatabaseInitializationError(
      "DATABASE_MIGRATION_FAILED",
      "Work Intelligence 無法安全完成資料庫升級；migration 前備份已保留（如果已成功建立）。請從備份還原或更新 Work Intelligence。",
      { cause: error },
    );
  }
}
