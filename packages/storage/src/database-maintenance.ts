import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";
import type { BackupRetentionOptions } from "./backup.js";
import { backupDatabaseBeforeMaintenance } from "./backup.js";
import { DatabaseInitializationError, initializeWorkIntelligenceDatabase } from "./database-initialization.js";
import { SearchRepository } from "./search-repository.js";

export type DatabaseMaintenanceErrorCode =
  | "DATABASE_MISSING"
  | "DATABASE_IN_USE"
  | "DATABASE_INVALID"
  | "DATABASE_INTEGRITY_FAILED"
  | "DATABASE_BACKUP_FAILED"
  | "DATABASE_MAINTENANCE_FAILED";

/** A safe, classified error from the explicit database maintenance command. */
export class DatabaseMaintenanceError extends Error {
  public constructor(
    public readonly code: DatabaseMaintenanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseMaintenanceError";
  }
}

export interface DatabaseMaintenanceResult {
  backupFileName: string;
  startedAt: string;
  completedAt: string;
  indexedSessions: number;
  indexedKnowledge: number;
  indexedChunks: number;
  indexedPaths: number;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (rows.length === 0 || rows.some((row) => row.integrity_check !== "ok")) {
    throw new DatabaseMaintenanceError(
      "DATABASE_INTEGRITY_FAILED",
      "資料庫完整性檢查失敗；已停止維護，請先從備份還原或尋求協助。",
    );
  }
}

function acquireExclusiveLock(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    throw new DatabaseMaintenanceError(
      "DATABASE_IN_USE",
      "資料庫目前無法取得獨佔鎖。請先停止 Work Intelligence server，並關閉會啟動 MCP 的 Agent 對話後重試。",
      { cause: error },
    );
  }
}

function recordFailedRun(database: DatabaseSync, id: string, completedAt: string, code: string): void {
  try {
    database
      .prepare(
        "UPDATE database_maintenance_runs SET completed_at = ?, status = 'failed', failure_code = ? WHERE id = ?",
      )
      .run(completedAt, code, id);
  } catch {
    // Preserve the original maintenance failure; the persisted `running` row remains visible to doctor.
  }
}

/** Checks for concurrent use, backs up, compacts the database, refreshes statistics, and rebuilds search rows. */
export function maintainDatabase(options: {
  databasePath: string;
  backup?: BackupRetentionOptions;
}): DatabaseMaintenanceResult {
  const { databasePath } = options;
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    throw new DatabaseMaintenanceError(
      "DATABASE_MISSING",
      "找不到已建立的資料庫；請先執行 pnpm start 建立資料庫，再執行維護。",
    );
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath);
  } catch (error) {
    throw new DatabaseMaintenanceError("DATABASE_INVALID", "無法開啟資料庫；檢查檔案權限後再試。", {
      cause: error,
    });
  }

  try {
    acquireExclusiveLock(database);
    if (!tableExists(database, "projects") || !tableExists(database, "sessions")) {
      throw new DatabaseMaintenanceError(
        "DATABASE_INVALID",
        "指定檔案不是 Work Intelligence 資料庫；維護程序沒有變更檔案。",
      );
    }
    assertDatabaseIntegrity(database);

    initializeWorkIntelligenceDatabase(database, databasePath, options.backup);

    let backupFileName: string;
    try {
      backupFileName = backupDatabaseBeforeMaintenance(database, databasePath, options.backup).created.fileName;
    } catch (error) {
      throw new DatabaseMaintenanceError(
        "DATABASE_BACKUP_FAILED",
        "維護前備份失敗；資料庫沒有進入維護程序。請檢查備份目錄後重試。",
        { cause: error },
      );
    }

    const id = randomUUID();
    const startedAt = nowIso();
    database
      .prepare(
        `INSERT INTO database_maintenance_runs (id, started_at, status, backup_file_name)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(id, startedAt, backupFileName);

    try {
      database.exec("VACUUM; ANALYZE;");
      const indexed = new SearchRepository(database).rebuildIndex();
      database.exec("ANALYZE;");
      assertDatabaseIntegrity(database);
      const completedAt = nowIso();
      database
        .prepare(
          `UPDATE database_maintenance_runs
           SET completed_at = ?, status = 'completed', indexed_sessions = ?, indexed_knowledge = ?,
               indexed_chunks = ?, indexed_paths = ?
           WHERE id = ?`,
        )
        .run(completedAt, indexed.sessions, indexed.knowledge, indexed.chunks, indexed.paths, id);
      return {
        backupFileName,
        startedAt,
        completedAt,
        indexedSessions: indexed.sessions,
        indexedKnowledge: indexed.knowledge,
        indexedChunks: indexed.chunks,
        indexedPaths: indexed.paths,
      };
    } catch (error) {
      const code =
        error instanceof DatabaseMaintenanceError && error.code === "DATABASE_INTEGRITY_FAILED"
          ? error.code
          : "DATABASE_MAINTENANCE_FAILED";
      recordFailedRun(database, id, nowIso(), code);
      if (error instanceof DatabaseMaintenanceError) {
        throw error;
      }
      throw new DatabaseMaintenanceError(
        "DATABASE_MAINTENANCE_FAILED",
        "資料庫維護未完成；維護前備份已保留，請執行 pnpm run doctor 檢查結果。",
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof DatabaseMaintenanceError) {
      throw error;
    }
    if (error instanceof DatabaseInitializationError) {
      throw error;
    }
    throw new DatabaseMaintenanceError(
      "DATABASE_MAINTENANCE_FAILED",
      "資料庫維護未完成；若已建立維護前備份，請保留該檔案並執行 pnpm run doctor 檢查結果。",
      { cause: error },
    );
  } finally {
    database.close();
  }
}
