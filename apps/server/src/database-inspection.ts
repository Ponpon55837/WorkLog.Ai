import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";

const MAINTENANCE_RUN_SCHEMA = z.object({
  started_at: z.string(),
  completed_at: z.string().nullable(),
  status: z.enum(["running", "completed", "failed"]),
  backup_file_name: z.string(),
  indexed_sessions: z.number().int().nonnegative(),
  indexed_knowledge: z.number().int().nonnegative(),
  indexed_chunks: z.number().int().nonnegative(),
  indexed_paths: z.number().int().nonnegative(),
  failure_code: z.enum(["DATABASE_INTEGRITY_FAILED", "DATABASE_MAINTENANCE_FAILED"]).nullable(),
});

type SqliteStatement = {
  all(): unknown[];
  get(): unknown;
};

type ReadOnlySqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export interface DatabaseMaintenanceInspection {
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed";
  backupFileName: string;
  indexedSessions: number;
  indexedKnowledge: number;
  indexedChunks: number;
  indexedPaths: number;
  failureCode: "DATABASE_INTEGRITY_FAILED" | "DATABASE_MAINTENANCE_FAILED" | null;
}

export interface ReadOnlyDatabaseInspection {
  state: "missing" | "ok" | "unhealthy" | "unreadable";
  bytes?: number;
  integrity?: "ok" | "failed";
  schemaVersion?: number;
  maintenance?: DatabaseMaintenanceInspection | null;
}

/**
 * Reads database metadata without changing it. The expensive full integrity check is opt-in so
 * the System Status endpoint can share schema/maintenance inspection with doctor safely.
 */
export async function inspectDatabaseReadOnlyMetadata(
  databasePath: string,
  options: { checkIntegrity?: boolean } = {},
): Promise<ReadOnlyDatabaseInspection> {
  if (!existsSync(databasePath)) {
    return { state: "missing" };
  }

  let database: ReadOnlySqliteDatabase | undefined;
  try {
    // Keep this dynamic import so `pnpm run doctor` can report the missing runtime on older Node versions.
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true }) as unknown as ReadOnlySqliteDatabase;
    const bytes = statSync(databasePath).size;
    const migrationTable = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    let schemaVersion = 0;
    if (migrationTable) {
      const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        { version?: number | null } | undefined;
      schemaVersion = Number(row?.version ?? 0);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        return {
          state: "unhealthy",
          ...(options.checkIntegrity ? { integrity: "failed" as const } : {}),
          bytes,
        };
      }
    }

    let maintenance: ReadOnlyDatabaseInspection["maintenance"];
    const maintenanceTable = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'database_maintenance_runs'")
      .get();
    if (maintenanceTable) {
      const rawRun = database
        .prepare(
          `SELECT started_at, completed_at, status, backup_file_name, indexed_sessions,
                  indexed_knowledge, indexed_chunks, indexed_paths, failure_code
           FROM database_maintenance_runs ORDER BY started_at DESC LIMIT 1`,
        )
        .get();
      if (!rawRun) {
        maintenance = null;
      } else {
        const parsedRun = MAINTENANCE_RUN_SCHEMA.safeParse(rawRun);
        maintenance = parsedRun.success
          ? {
              startedAt: parsedRun.data.started_at,
              completedAt: parsedRun.data.completed_at,
              status: parsedRun.data.status,
              backupFileName: parsedRun.data.backup_file_name,
              indexedSessions: parsedRun.data.indexed_sessions,
              indexedKnowledge: parsedRun.data.indexed_knowledge,
              indexedChunks: parsedRun.data.indexed_chunks,
              indexedPaths: parsedRun.data.indexed_paths,
              failureCode: parsedRun.data.failure_code,
            }
          : null;
      }
    }

    let integrity: ReadOnlyDatabaseInspection["integrity"];
    if (options.checkIntegrity) {
      const checks = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
      integrity = checks.length > 0 && checks.every((row) => row.integrity_check === "ok") ? "ok" : "failed";
    }

    return {
      state: integrity === "failed" ? "unhealthy" : "ok",
      bytes,
      ...(integrity ? { integrity } : {}),
      schemaVersion,
      ...(maintenanceTable ? { maintenance: maintenance ?? null } : {}),
    };
  } catch {
    return { state: "unreadable" };
  } finally {
    database?.close();
  }
}

/** Resolves relative backup settings beside the selected database, matching server and CLI rules. */
export function resolveBackupDirectory(databasePath: string, configuredDirectory?: string): string {
  return configuredDirectory
    ? resolve(dirname(databasePath), configuredDirectory)
    : join(dirname(databasePath), "backups");
}

/** Finds the newest automatic snapshot without following symlinks or changing the database. */
export function findLatestAutomaticBackup(databasePath: string, backupDirectory: string): Date | undefined {
  try {
    const prefix = basename(databasePath, extname(databasePath)) + "-automatic-";
    let latest: Date | undefined;
    for (const fileName of readdirSync(backupDirectory)) {
      if (!fileName.startsWith(prefix) || !fileName.endsWith(".sqlite")) {
        continue;
      }
      const stats = lstatSync(join(backupDirectory, fileName));
      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }
      if (!latest || stats.mtime > latest) {
        latest = stats.mtime;
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}
