import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import {
  defaultBackupDirectory,
  initializeWorkIntelligenceDatabase,
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  RestoreDatabaseError,
} from "@work-intelligence/storage";
import {
  DESKTOP_MAX_INSPECTED_BACKUPS,
  DESKTOP_MAX_BACKUP_ROOTS,
  type DesktopBackupRootsResultMessage,
  type DesktopInspectedBackup,
  type DesktopRestoreResultMessage,
} from "@work-intelligence/schema";

export interface InspectBackupsResult {
  readonly items: readonly DesktopInspectedBackup[];
  readonly directoryReadable: boolean;
}

function fileBytes(path: string): number | undefined {
  try {
    const stats = lstatSync(path);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

function inspectFile(path: string, integrity: boolean): DesktopInspectedBackup {
  const bytes = fileBytes(path);
  const fileName = basename(path);
  if (bytes === undefined) return { path, fileName, bytes: 0, status: "missing" };
  const found = inspectDatabaseBackup(path, { integrity });
  if (found.status === "ok") {
    return {
      path,
      fileName,
      bytes,
      status: "ok",
      schemaVersion: found.schemaVersion,
      projects: found.projects,
      sessions: found.sessions,
    };
  }
  if (found.status === "newer-schema") {
    return { path, fileName, bytes, status: "newer-schema", schemaVersion: found.schemaVersion };
  }
  return { path, fileName, bytes, status: found.status };
}

export function inspectBackups(request: {
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly files?: readonly string[];
  readonly integrity?: boolean;
  readonly limit?: number;
}): InspectBackupsResult {
  const integrity = request.integrity !== false;
  if (request.files) {
    return { items: request.files.map((file) => inspectFile(file, integrity)), directoryReadable: true };
  }
  const directory = request.backupDirectory ?? defaultBackupDirectory(request.databasePath);
  let listed;
  try {
    listed = listDatabaseBackups(request.databasePath, directory);
  } catch {
    return { items: [], directoryReadable: false };
  }
  const items = listed.slice(0, request.limit ?? DESKTOP_MAX_INSPECTED_BACKUPS).map((backup) => ({
    ...inspectFile(join(directory, backup.fileName), integrity),
    kind: backup.kind,
    createdAt: backup.createdAt,
  }));
  return { items, directoryReadable: true };
}

function errnoOf(error: unknown): string | undefined {
  const { code } = (error ?? {}) as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function outOfSpace(error: unknown): boolean {
  const { errcode, message } = (error ?? {}) as { errcode?: unknown; message?: unknown };
  const code = errnoOf(error);
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  if (typeof errcode === "number" && (errcode & 0xff) === 13) return true;
  return typeof message === "string" && /database or disk is full|no space left/i.test(message);
}

export type RestoreFailureStatus = Exclude<DesktopRestoreResultMessage["status"], "ok">;

/** @internal test-only */
export function classifyRestoreFailure(error: unknown): RestoreFailureStatus {
  if (error instanceof RestoreDatabaseError) {
    switch (error.code) {
      case "RESTORE_DATABASE_IN_USE":
        return "in-use";
      case "RESTORE_SCHEMA_TOO_NEW":
        return "newer-schema";
      case "RESTORE_NOT_DATABASE":
        return "not-database";
      case "RESTORE_SOURCE_CORRUPT":
        return "corrupt";
      case "RESTORE_VERIFY_FAILED":
        return "verify-failed";
      case "RESTORE_SOURCE_MISSING":
        return "missing";
      case "RESTORE_SAME_FILE":
        return "same-file";
      case "RESTORE_FILES_LOCKED":
        return "locked";
    }
  }
  const code = errnoOf(error);
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY") return "locked";
  if (outOfSpace(error)) return "no-space";
  return "failed";
}

export function restoreFromBackup(request: {
  readonly source: string;
  readonly databasePath: string;
  readonly backupDirectory?: string;
  readonly remap?: readonly { readonly from: string; readonly to: string }[];
}): Omit<DesktopRestoreResultMessage, "type"> {
  try {
    const result = restoreDatabase({
      source: request.source,
      databasePath: request.databasePath,
      initializeStaging: (database) => initializeWorkIntelligenceDatabase(database, ":memory:"),
      ...(request.backupDirectory ? { backupDirectory: request.backupDirectory } : {}),
      ...(request.remap && request.remap.length > 0 ? { remap: request.remap } : {}),
    });
    return {
      status: "ok",
      ...(result.safetyBackup ? { safetyBackup: result.safetyBackup } : {}),
      schemaVersion: result.schemaVersion,
      projects: result.projects,
      sessions: result.sessions,
      ...(result.remapped.projects > 0 ? { remappedProjects: result.remapped.projects } : {}),
    };
  } catch (error) {
    const status = classifyRestoreFailure(error);
    return { status, detail: `the restore did not replace the database (${status})` };
  }
}

export function listBackupProjectRoots(source: string): Omit<DesktopBackupRootsResultMessage, "type"> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    const rows = database
      .prepare("SELECT name, root_path AS path FROM projects WHERE root_path IS NOT NULL ORDER BY root_path LIMIT ?")
      .all(DESKTOP_MAX_BACKUP_ROOTS + 1) as Array<{ name: unknown; path: unknown }>;
    const roots = rows
      .filter((row) => typeof row.path === "string" && row.path.length > 0 && row.path.length <= 4096)
      .slice(0, DESKTOP_MAX_BACKUP_ROOTS)
      .map((row) => ({ path: row.path as string, name: typeof row.name === "string" ? row.name.slice(0, 512) : "" }));
    return { status: "ok", roots, ...(rows.length > DESKTOP_MAX_BACKUP_ROOTS ? { truncated: true } : {}) };
  } catch {
    return { status: "failed", roots: [] };
  } finally {
    database?.close();
  }
}
