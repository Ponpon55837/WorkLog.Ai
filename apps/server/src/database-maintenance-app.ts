import { DatabaseInitializationError, DatabaseMaintenanceError, maintainDatabase } from "@work-intelligence/storage";
import type { DesktopMaintainResultMessage, DesktopMaintenanceHintMessage } from "@work-intelligence/schema";
import { statSync } from "node:fs";
import { inspectDatabaseReadOnlyMetadata, shouldSuggestReclaim } from "./database-inspection.js";

/**
 * The database maintenance the desktop App offers: the same `maintainDatabase` of the storage package the command line runs
 * (backup first, integrity check, VACUUM, search index rebuild), and a read-only integrity check. Never throws: a failure is
 * a status with a fixed meaning, never a path or an SQLite message.
 */
export async function maintainForApp(request: {
  readonly mode: "maintain" | "check";
  readonly databasePath: string;
  readonly backupDirectory?: string;
}): Promise<Omit<DesktopMaintainResultMessage, "type">> {
  const { mode } = request;
  if (mode === "check") {
    const found = await inspectDatabaseReadOnlyMetadata(request.databasePath, { checkIntegrity: true });
    if (found.state === "missing") return { mode, status: "missing" };
    if (found.state === "unreadable") return { mode, status: "invalid" };
    return { mode, status: found.integrity === "ok" ? "ok" : "integrity-failed" };
  }
  const before = fileBytes(request.databasePath);
  try {
    const result = maintainDatabase({
      databasePath: request.databasePath,
      ...(request.backupDirectory ? { backup: { directory: request.backupDirectory } } : {}),
    });
    const after = fileBytes(request.databasePath);
    return {
      mode,
      status: "ok",
      backupFileName: result.backupFileName,
      ...(before !== undefined && after !== undefined && before > after ? { reclaimedBytes: before - after } : {}),
    };
  } catch (error) {
    if (error instanceof DatabaseMaintenanceError) {
      switch (error.code) {
        case "DATABASE_MISSING":
          return { mode, status: "missing" };
        case "DATABASE_IN_USE":
          return { mode, status: "in-use" };
        case "DATABASE_INVALID":
          return { mode, status: "invalid" };
        case "DATABASE_INTEGRITY_FAILED":
          return { mode, status: "integrity-failed" };
        case "DATABASE_BACKUP_FAILED":
          return { mode, status: "backup-failed" };
        default:
          return { mode, status: "failed" };
      }
    }
    if (error instanceof DatabaseInitializationError) return { mode, status: "invalid" };
    return { mode, status: "failed" };
  }
}

function fileBytes(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** Space a compaction would give back, and the last run's outcome, for the App's Status tab. Read-only and cheap. */
export async function readMaintenanceHint(
  databasePath: string,
): Promise<Omit<DesktopMaintenanceHintMessage, "type" | "requestId">> {
  const found = await inspectDatabaseReadOnlyMetadata(databasePath);
  if (found.state === "missing" || found.state === "unreadable") return {};
  const run = found.maintenance;
  return {
    ...(found.reclaimableBytes === undefined ? {} : { reclaimableBytes: found.reclaimableBytes }),
    ...(found.bytes === undefined ? {} : { databaseBytes: found.bytes }),
    ...(found.reclaimableBytes === undefined
      ? {}
      : { suggest: shouldSuggestReclaim(found.reclaimableBytes, found.bytes ?? 0) }),
    ...(run
      ? {
          last: {
            status: run.status,
            at: run.completedAt ?? run.startedAt,
            ...(run.failureCode ? { failureCode: run.failureCode } : {}),
          },
        }
      : {}),
  };
}
