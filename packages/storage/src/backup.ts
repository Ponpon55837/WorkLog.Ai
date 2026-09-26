import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseBackup,
  DatabaseBackupCreated,
  DatabaseBackupDeleteResult,
  DatabaseBackupKind,
} from "@work-intelligence/core";
import { toLocalCalendarDate } from "@work-intelligence/shared";
import { remapPathPrefix } from "./project-path-remap.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";

export const DEFAULT_BACKUP_KEEP = 14;
export const DEFAULT_AUTOMATIC_BACKUP_KEEP = 14;

export interface BackupRetentionOptions {
  directory?: string;
  keep?: number;
  automaticKeep?: number;
}

export interface BackupWriteOptions extends BackupRetentionOptions {
  kind?: "automatic" | "manual";
  now?: Date;
}

/** Backups live beside the database in `backups/`, named after it with a UTC timestamp. */
export function defaultBackupDirectory(databasePath: string): string {
  return join(dirname(databasePath), "backups");
}

function backupPrefix(databasePath: string): string {
  return `${basename(databasePath, extname(databasePath))}-`;
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseName(value: string): { kind: DatabaseBackupKind; createdAt: string; sequence: number } | null {
  const standardName = /^(automatic|manual)-(.+)$/.exec(value);
  const migrationName = /^pre-migration-v(\d+)-(.+)$/.exec(value);
  const maintenanceName = /^pre-maintenance-(.+)$/.exec(value);
  const deletionName = /^pre-delete-(.+)$/.exec(value);
  const migrationVersion = migrationName?.[1] ? Number(migrationName[1]) : undefined;
  if (migrationName && (!Number.isSafeInteger(migrationVersion) || (migrationVersion ?? 0) < 1)) {
    return null;
  }
  const kind: DatabaseBackupKind = standardName
    ? standardName[1] === "automatic"
      ? "automatic"
      : "manual"
    : migrationName
      ? "migration"
      : deletionName
        ? "deletion"
        : maintenanceName
          ? "maintenance"
          : "manual";
  const stamp = standardName?.[2] ?? migrationName?.[2] ?? maintenanceName?.[1] ?? deletionName?.[1] ?? value;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?$/.exec(stamp ?? value);
  if (!match) {
    return null;
  }
  const createdAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const date = new Date(createdAt);
  const sequence = Number(match[7] ?? 1);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().replace(/\.000Z$/, "Z") !== createdAt ||
    !Number.isSafeInteger(sequence) ||
    (match[7] !== undefined && sequence < 2)
  ) {
    return null;
  }
  return { kind, createdAt, sequence };
}

/** Accepts only a single, recognized filename for the current database. */
export function isSafeDatabaseBackupFileName(databasePath: string, fileName: string): boolean {
  const containsControlCharacter = Array.from(fileName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  if (
    fileName.length > 255 ||
    fileName.includes("..") ||
    /[\\/%:*?"<>|]/.test(fileName) ||
    containsControlCharacter ||
    basename(fileName) !== fileName
  ) {
    return false;
  }
  const prefix = backupPrefix(databasePath);
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sqlite")) {
    return false;
  }
  return parseName(fileName.slice(prefix.length, -".sqlite".length)) !== null;
}

/** Backups of this database, newest first; files that do not follow the naming scheme are ignored. */
export function listDatabaseBackups(
  databasePath: string,
  directory = defaultBackupDirectory(databasePath),
): DatabaseBackup[] {
  let directoryStats;
  try {
    directoryStats = lstatSync(directory);
  } catch {
    return [];
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    return [];
  }
  const prefix = backupPrefix(databasePath);
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .flatMap((fileName) => {
      if (!isSafeDatabaseBackupFileName(databasePath, fileName)) {
        return [];
      }
      const parsed = parseName(fileName.slice(prefix.length, -".sqlite".length));
      if (!parsed) {
        return [];
      }
      let stats;
      try {
        stats = lstatSync(join(directory, fileName));
      } catch {
        return [];
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return [];
      }
      const bytes = stats.size;
      return [
        { backup: { kind: parsed.kind, fileName, createdAt: parsed.createdAt, bytes }, sequence: parsed.sequence },
      ];
    })
    .sort((left, right) =>
      left.backup.createdAt === right.backup.createdAt
        ? right.sequence - left.sequence
        : left.backup.createdAt < right.backup.createdAt
          ? 1
          : -1,
    )
    .map((entry) => entry.backup);
}

function assertHealthy(path: string, label: string): void {
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    const result = check.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (result?.quick_check !== "ok") {
      throw new Error(`${label} failed its integrity check: ${result?.quick_check ?? "no result"}`);
    }
  } finally {
    check.close();
  }
}

/** VACUUM INTO gives a consistent copy even while other connections write through WAL. */
function writeSnapshot(db: DatabaseSync, target: string): void {
  if (existsSync(target)) {
    throw new Error("The snapshot target already exists.");
  }
  // Create the file owner-only from the start; chmod alone would leave it readable until it runs.
  const previousUmask = process.umask(0o077);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(target, 0o600);
  try {
    assertHealthy(target, "The snapshot");
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
}

/** Writes the whole database to `target` (which must not exist yet), e.g. to move it to another computer. */
export function exportDatabase(db: DatabaseSync, target: string): { bytes: number } {
  writeSnapshot(db, target);
  return { bytes: statSync(target).size };
}

/** Writes a checked, owner-only snapshot and prunes only older copies of the same kind. */
function writeDatabaseBackup(
  db: DatabaseSync,
  databasePath: string,
  options: BackupWriteOptions = {},
  filePrefix: string,
): DatabaseBackupCreated {
  const directory = options.directory ?? defaultBackupDirectory(databasePath);
  const kind = options.kind ?? "manual";
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_BACKUP_KEEP));
  const automaticKeep = Math.max(1, Math.trunc(options.automaticKeep ?? DEFAULT_AUTOMATIC_BACKUP_KEEP));
  const kindKeep = kind === "automatic" ? automaticKeep : keep;
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const stamp = timestamp(options.now ?? new Date());
  let fileName = `${backupPrefix(databasePath)}${filePrefix}${stamp}.sqlite`;
  for (let suffix = 2; existsSync(join(directory, fileName)); suffix += 1) {
    fileName = `${backupPrefix(databasePath)}${filePrefix}${stamp}-${suffix}.sqlite`;
  }
  const target = join(directory, fileName);
  writeSnapshot(db, target);

  const backups = listDatabaseBackups(databasePath, directory);
  for (const stale of backups
    .filter((backup) => (backup.kind === "automatic") === (kind === "automatic"))
    .slice(kindKeep)) {
    rmSync(join(directory, stale.fileName), { force: true });
  }
  const kept = listDatabaseBackups(databasePath, directory);
  const created = kept.find((backup) => backup.fileName === fileName) ?? {
    kind,
    fileName,
    createdAt: new Date().toISOString(),
    bytes: statSync(target).size,
  };
  return { outcome: "database_backups", keep, automaticKeep, backups: kept, created };
}

/** Removes one recognized backup after checking its name, directory, and file type. */
export function deleteDatabaseBackup(
  databasePath: string,
  fileName: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupDeleteResult {
  if (!isSafeDatabaseBackupFileName(databasePath, fileName)) {
    return { outcome: "invalid_backup_file_name" };
  }

  const directory = options.directory ?? defaultBackupDirectory(databasePath);
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_BACKUP_KEEP));
  const automaticKeep = Math.max(1, Math.trunc(options.automaticKeep ?? DEFAULT_AUTOMATIC_BACKUP_KEEP));
  const existing = listDatabaseBackups(databasePath, directory).find((backup) => backup.fileName === fileName);
  if (!existing) {
    return { outcome: "backup_not_found" };
  }

  try {
    const directoryStats = lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      return { outcome: "backup_not_found" };
    }
    const realDirectory = realpathSync(directory);
    const target = join(realDirectory, fileName);
    const targetStats = lstatSync(target);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      return { outcome: "backup_not_found" };
    }
    const realTarget = realpathSync(target);
    if (dirname(realTarget) !== realDirectory || basename(realTarget) !== fileName) {
      return { outcome: "backup_not_found" };
    }
    unlinkSync(target);
  } catch {
    return { outcome: "backup_unavailable", reason: "備份檔案無法刪除。" };
  }

  return {
    outcome: "backup_deleted",
    deleted: existing,
    keep,
    automaticKeep,
    backups: listDatabaseBackups(databasePath, directory),
  };
}

/** Writes a manual-retention safety snapshot tagged with the schema version about to be applied. */
export function backupDatabaseBeforeMigration(
  db: DatabaseSync,
  databasePath: string,
  schemaVersion: number,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError("The pre-migration schema version must be a positive integer.");
  }
  return writeDatabaseBackup(db, databasePath, { ...options, kind: "manual" }, `pre-migration-v${schemaVersion}-`);
}

/** Writes a checked full-database snapshot before a project is permanently deleted. */
export function backupDatabaseBeforeProjectDeletion(
  db: DatabaseSync,
  databasePath: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  return writeDatabaseBackup(db, databasePath, { ...options, kind: "manual" }, "pre-delete-");
}

/** Writes a checked, manually retained safety snapshot before database maintenance. */
export function backupDatabaseBeforeMaintenance(
  db: DatabaseSync,
  databasePath: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  return writeDatabaseBackup(db, databasePath, { ...options, kind: "manual" }, "pre-maintenance-");
}

export function backupDatabase(
  db: DatabaseSync,
  databasePath: string,
  options: BackupWriteOptions = {},
): DatabaseBackupCreated {
  const kind = options.kind ?? "manual";
  return writeDatabaseBackup(db, databasePath, options, `${kind}-`);
}

/** True until an automatic backup has been made during the current local calendar day. */
export function isBackupDue(databasePath: string, directory?: string, now = new Date()): boolean {
  const latest = listDatabaseBackups(databasePath, directory).find((backup) => backup.kind === "automatic");
  return !latest || toLocalCalendarDate(latest.createdAt) !== toLocalCalendarDate(now);
}

export interface RestorePathRemap {
  from: string;
  to: string;
}

export interface RestoreDatabaseResult {
  schemaVersion: number;
  projects: number;
  sessions: number;
  remapped: { projects: number; handoffSnapshots: number };
  /** File name of the backup taken of the replaced database, when there was one. */
  safetyBackup?: string;
}

function inspectSnapshot(source: string): { schemaVersion: number; projects: number; sessions: number } {
  assertHealthy(source, "The file to restore");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tables.has("projects") || !tables.has("sessions")) {
      throw new Error("The file is not a Work Intelligence database.");
    }
    const schemaVersion = tables.has("schema_migrations")
      ? ((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null })
          .version ?? 0)
      : 0;
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
    return { schemaVersion, projects: count("projects"), sessions: count("sessions") };
  } finally {
    db.close();
  }
}

/** Another open connection (the API server or an Agent's MCP server) keeps an exclusive lock from being taken. */
function isInUse(databasePath: string): boolean {
  const probe = new DatabaseSync(databasePath);
  try {
    probe.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

/**
 * Replaces the database with a snapshot, e.g. one exported on another computer. The snapshot is checked
 * first, the current database is backed up, and project roots / handoff paths can be moved to the new
 * machine's locations. Nothing else may have the database open; the restore stops unless `force` is set.
 */
export function restoreDatabase(options: {
  source: string;
  databasePath: string;
  remap?: readonly RestorePathRemap[];
  force?: boolean;
  backupDirectory?: string;
}): RestoreDatabaseResult {
  const { source, databasePath } = options;
  if (!existsSync(source)) {
    throw new Error("The file to restore does not exist.");
  }
  if (existsSync(databasePath) && statSync(source).ino === statSync(databasePath).ino) {
    throw new Error("The file to restore is the current database.");
  }
  const inspected = inspectSnapshot(source);
  if (inspected.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `The file uses schema version ${inspected.schemaVersion}, newer than this version supports (${LATEST_SCHEMA_VERSION}); update Work Intelligence first.`,
    );
  }
  if (existsSync(databasePath) && !options.force && isInUse(databasePath)) {
    throw new Error("The database is in use. Stop the API server and close Agents first.");
  }

  let safetyBackup: string | undefined;
  if (existsSync(databasePath)) {
    const current = new DatabaseSync(databasePath);
    try {
      safetyBackup = backupDatabase(current, databasePath, { directory: options.backupDirectory }).created.fileName;
    } finally {
      current.close();
    }
  }

  const staging = `${databasePath}.restoring`;
  rmSync(staging, { force: true });
  // Copying through SQLite (not the file system) includes writes still in a WAL file beside the source.
  const reader = new DatabaseSync(source, { readOnly: true });
  try {
    writeSnapshot(reader, staging);
  } finally {
    reader.close();
  }
  const remapped = { projects: 0, handoffSnapshots: 0 };
  const db = new DatabaseSync(staging);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const entry of options.remap ?? []) {
      const move = (table: string, column: string): number => {
        const rows = db.prepare(`SELECT ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{
          path: string;
        }>;
        let updated = 0;
        for (const row of rows) {
          const replacement = remapPathPrefix(row.path, entry);
          if (replacement !== row.path) {
            db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(replacement, row.path);
            updated += 1;
          }
        }
        return updated;
      };
      remapped.projects += move("projects", "root_path");
      remapped.handoffSnapshots += move("raw_snapshots", "source_path");
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    db.close();
    rmSync(staging, { force: true });
    throw error;
  }
  db.close();

  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  renameSync(staging, databasePath);
  return { ...inspected, remapped, safetyBackup };
}
