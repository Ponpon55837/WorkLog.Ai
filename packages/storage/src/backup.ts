import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseBackup,
  DatabaseBackupCreated,
  DatabaseBackupDeleteResult,
  DatabaseBackupKind,
} from "@work-intelligence/core";
import {
  backupPrefix,
  isSafeDatabaseBackupFileName,
  parseDatabaseBackupFileName,
  type BackupNameKind,
  toLocalCalendarDate,
} from "@work-intelligence/shared";
import { pathsReferToSameFile } from "@work-intelligence/shared/file-identity";
import { remapPathPrefix } from "./project-path-remap.js";
import { renameSyncWithRetry } from "./rename-retry.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";

export { isSafeDatabaseBackupFileName };
export const DEFAULT_BACKUP_KEEP = 3;
export const DEFAULT_AUTOMATIC_BACKUP_KEEP = 3;
/** @internal test-only */
export const SESSION_DELETION_BACKUP_KEEP = 3;

type RetentionBucket = "automatic" | "session_deletion" | "import" | "manual";

export interface BackupRetentionOptions {
  directory?: string;
  keep?: number;
  automaticKeep?: number;
}

export interface BackupWriteOptions extends BackupRetentionOptions {
  kind?: "automatic" | "manual";
  now?: Date;
}

export function defaultBackupDirectory(databasePath: string): string {
  return join(dirname(databasePath), "backups");
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Compile-time only: the build fails if the shared file-name kinds and the core API kinds drift apart. */
const kindsAgree: Assert<Equal<BackupNameKind, DatabaseBackupKind>> = true;
void kindsAgree;

function retentionBucket(kind: DatabaseBackupKind): RetentionBucket {
  return kind === "automatic" || kind === "session_deletion" || kind === "import" ? kind : "manual";
}

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
  return readdirSync(directory)
    .flatMap((fileName) => {
      const parsed = parseDatabaseBackupFileName(databasePath, fileName);
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

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ESRCH";
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function publishSnapshotNoClobber(staging: string, target: string): void {
  try {
    // linkSync atomically publishes without replacing a target created by another process.
    linkSync(staging, target);
    return;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "EEXIST") throw new Error("The snapshot target already exists.", { cause: error });
  }

  // Reserve the destination exclusively before rename so unsupported hard links have a safe fallback.
  let reservation: number;
  try {
    reservation = openSync(target, "wx", 0o600);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "EEXIST") throw new Error("The snapshot target already exists.", { cause: error });
    throw error;
  }

  let reservationOpen = true;
  try {
    closeSync(reservation);
    reservationOpen = false;
    renameSync(staging, target);
  } catch (error) {
    if (reservationOpen) {
      try {
        closeSync(reservation);
      } catch {
        // Keep the publication error.
      }
    }
    try {
      unlinkSync(target);
    } catch {
      // Keep the publication error.
    }
    throw error;
  }
}

/** @internal test-only */
export function cleanupOrphanedBackupStagingDirectories(
  directory: string,
  isProcessAlive: (processId: number) => boolean = processIsAlive,
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const match = /^\.wi-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.exec(entry.name);
    if (!match) continue;
    const ownerProcessId = Number(match[1]);
    if (!Number.isSafeInteger(ownerProcessId) || ownerProcessId < 1 || isProcessAlive(ownerProcessId)) continue;

    const stagingDirectory = join(directory, entry.name);
    try {
      const stats = lstatSync(stagingDirectory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch {
      // A staging directory can disappear between listing it and checking its owner.
    }
  }
}

/** VACUUM INTO gives a consistent copy even while other connections write through WAL. */
export function writeSnapshot(
  db: DatabaseSync,
  target: string,
  verifySnapshot: (path: string, label: string) => void = assertHealthy,
): void {
  if (pathExists(target)) {
    throw new Error("The snapshot target already exists.");
  }
  const targetDirectory = dirname(target);
  cleanupOrphanedBackupStagingDirectories(targetDirectory);
  const stagingDirectory = join(targetDirectory, `.wi-${process.pid}-${randomUUID()}.tmp`);
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const staging = join(stagingDirectory, "snapshot.sqlite");
  try {
    db.prepare("VACUUM INTO ?").run(staging);
    // The private staging directory protects the file while it is created; chmod it before publication.
    chmodSync(staging, 0o600);
    verifySnapshot(staging, "The snapshot");
    // Prefer a hard link; an exclusive target reservation makes the rename fallback no-clobber.
    publishSnapshotNoClobber(staging, target);
  } finally {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch {
      // An orphaned staging directory is not a valid backup name, so it is harmless.
    }
  }
}

export interface ExportOptions {
  /** False for a staging copy read once and removed: SQLite then skips the fsyncs that are most of `VACUUM INTO`. */
  readonly durable?: boolean;
}

function withoutSync<T>(db: DatabaseSync, run: () => T): T {
  const level = (db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown } | undefined)?.synchronous;
  // 0-3 (OFF, NORMAL, FULL, EXTRA) are the only levels SQLite reports; anything else is restored as its default, FULL.
  const previous = typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= 3 ? level : 2;
  db.exec("PRAGMA synchronous = OFF");
  try {
    return run();
  } finally {
    db.exec(`PRAGMA synchronous = ${previous}`);
  }
}

export function exportDatabase(db: DatabaseSync, target: string, options: ExportOptions = {}): { bytes: number } {
  if (options.durable === false) withoutSync(db, () => writeSnapshot(db, target));
  else writeSnapshot(db, target);
  return { bytes: statSync(target).size };
}

function writeDatabaseBackup(
  db: DatabaseSync,
  databasePath: string,
  options: BackupWriteOptions = {},
  filePrefix: string,
  bucket: RetentionBucket = options.kind === "automatic" ? "automatic" : "manual",
): DatabaseBackupCreated {
  const directory = options.directory ?? defaultBackupDirectory(databasePath);
  const kind = options.kind ?? "manual";
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_BACKUP_KEEP));
  const automaticKeep = Math.max(1, Math.trunc(options.automaticKeep ?? DEFAULT_AUTOMATIC_BACKUP_KEEP));
  const kindKeep =
    bucket === "automatic" || bucket === "import"
      ? automaticKeep
      : bucket === "session_deletion"
        ? SESSION_DELETION_BACKUP_KEEP
        : keep;
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const stamp = timestamp(options.now ?? new Date());
  const base = `${backupPrefix(databasePath)}${filePrefix}${stamp}`;
  // Past the highest copy of this second, not the first free name: a freed lower number would sort oldest and be pruned.
  let sequence = 1;
  for (const name of readdirSync(directory)) {
    const match = name.startsWith(base) ? /^(?:-(\d+))?\.sqlite$/.exec(name.slice(base.length)) : null;
    if (match) {
      sequence = Math.max(sequence, Number(match[1] ?? 1) + 1);
    }
  }
  const fileName = sequence === 1 ? `${base}.sqlite` : `${base}-${sequence}.sqlite`;
  const target = join(directory, fileName);
  writeSnapshot(db, target);

  const backups = listDatabaseBackups(databasePath, directory);
  for (const stale of backups.filter((backup) => retentionBucket(backup.kind) === bucket).slice(kindKeep)) {
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

export function backupDatabaseBeforeProjectDeletion(
  db: DatabaseSync,
  databasePath: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  return writeDatabaseBackup(db, databasePath, { ...options, kind: "manual" }, "pre-delete-");
}

export function backupDatabaseBeforeSessionDeletion(
  db: DatabaseSync,
  databasePath: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  return writeDatabaseBackup(
    db,
    databasePath,
    { ...options, kind: "manual" },
    "pre-session-delete-",
    "session_deletion",
  );
}

export function backupDatabaseBeforeImport(
  db: DatabaseSync,
  databasePath: string,
  options: BackupRetentionOptions = {},
): DatabaseBackupCreated {
  return writeDatabaseBackup(db, databasePath, { ...options, kind: "manual" }, "pre-import-", "import");
}

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

export function isBackupDue(databasePath: string, directory?: string, now = new Date()): boolean {
  const latest = listDatabaseBackups(databasePath, directory).find((backup) => backup.kind === "automatic");
  return !latest || toLocalCalendarDate(latest.createdAt) !== toLocalCalendarDate(now);
}

const RESTORE_VERIFY_MESSAGE = "還原用的資料庫副本在升級後未通過完整性檢查；目前的資料庫沒有被取代。請改用其他備份檔。";

export type RestoreDatabaseErrorCode =
  | "RESTORE_VERIFY_FAILED"
  | "RESTORE_SOURCE_MISSING"
  | "RESTORE_SAME_FILE"
  | "RESTORE_NOT_DATABASE"
  | "RESTORE_SOURCE_CORRUPT"
  | "RESTORE_SCHEMA_TOO_NEW"
  | "RESTORE_DATABASE_IN_USE"
  | "RESTORE_FILES_LOCKED";

/** Always raised before the current database is replaced, so nothing was lost when it is thrown. */
export class RestoreDatabaseError extends Error {
  public constructor(
    public readonly code: RestoreDatabaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RestoreDatabaseError";
  }
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
  safetyBackup?: string;
}

export type BackupInspection =
  | { status: "ok"; schemaVersion: number; projects: number; sessions: number }
  | { status: "newer-schema"; schemaVersion: number }
  | { status: "not-database" }
  | { status: "corrupt"; detail?: string }
  | { status: "unreadable" };

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_CANTOPEN = 14;
const SQLITE_PERM = 3;
const SQLITE_BUSY = 5;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;

function sqliteResultCode(error: unknown): number | undefined {
  const { errcode } = (error ?? {}) as { errcode?: unknown };
  return typeof errcode === "number" ? errcode & 0xff : undefined;
}

function classifyOpenFailure(error: unknown): BackupInspection {
  const code = sqliteResultCode(error);
  if (code === SQLITE_NOTADB) return { status: "not-database" };
  if (code === SQLITE_CANTOPEN || code === SQLITE_PERM || code === SQLITE_BUSY || code === SQLITE_READONLY) {
    return { status: "unreadable" };
  }
  if (code === SQLITE_IOERR) return { status: "unreadable" };
  if (code === SQLITE_CORRUPT) return { status: "corrupt" };
  const fsCode = (error as { code?: unknown } | null)?.code;
  if (fsCode === "EACCES" || fsCode === "EPERM" || fsCode === "EBUSY" || fsCode === "ENOENT") {
    return { status: "unreadable" };
  }
  return { status: "not-database" };
}

/** The schema version is decided before the integrity check, so a newer App's file is reported as such. Never throws. */
export function inspectDatabaseBackup(
  source: string,
  options: { integrity?: boolean; full?: boolean } = {},
): BackupInspection {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tables.has("projects") || !tables.has("sessions")) return { status: "not-database" };
    const schemaVersion = tables.has("schema_migrations")
      ? ((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null })
          .version ?? 0)
      : 0;
    if (schemaVersion > LATEST_SCHEMA_VERSION) return { status: "newer-schema", schemaVersion };
    if (options.integrity !== false) {
      const pragma = options.full ? "integrity_check" : "quick_check";
      const checked = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, string> | undefined;
      if (checked?.[pragma] !== "ok") {
        return { status: "corrupt", detail: checked?.[pragma] ?? "no result" };
      }
    }
    const count = (table: string): number =>
      (db?.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
    return { status: "ok", schemaVersion, projects: count("projects"), sessions: count("sessions") };
  } catch (error) {
    return classifyOpenFailure(error);
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
  }
}

function inspectSnapshot(source: string): { schemaVersion: number; projects: number; sessions: number } {
  const found = inspectDatabaseBackup(source, { full: true });
  if (found.status === "ok") return found;
  if (found.status === "newer-schema") {
    throw new RestoreDatabaseError(
      "RESTORE_SCHEMA_TOO_NEW",
      `The file uses schema version ${found.schemaVersion}, newer than this version supports (${LATEST_SCHEMA_VERSION}); update Work Intelligence first.`,
    );
  }
  if (found.status === "not-database") {
    throw new RestoreDatabaseError("RESTORE_NOT_DATABASE", "The file is not a Work Intelligence database.");
  }
  throw new RestoreDatabaseError(
    "RESTORE_SOURCE_CORRUPT",
    `The file to restore failed its integrity check: ${found.status === "corrupt" ? (found.detail ?? "damaged") : "unreadable"}`,
  );
}

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

function readChangeRevisions(database: DatabaseSync): { dataRevision: number; auditRevision: number } {
  const exists = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'change_revisions'")
    .get();
  if (!exists) return { dataRevision: 0, auditRevision: 0 };
  const row = database
    .prepare(
      "SELECT data_revision AS dataRevision, audit_revision AS auditRevision FROM change_revisions WHERE singleton = 1",
    )
    .get() as { dataRevision?: number; auditRevision?: number } | undefined;
  return { dataRevision: Number(row?.dataRevision ?? 0), auditRevision: Number(row?.auditRevision ?? 0) };
}

/** Checked after migration and remap, because the snapshot check ran before them. */
function assertRestoredCopyHealthy(db: DatabaseSync): void {
  let healthy: boolean;
  try {
    const checked = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    healthy =
      checked.length === 1 &&
      checked[0]?.integrity_check === "ok" &&
      db.prepare("PRAGMA foreign_key_check").all().length === 0;
  } catch (error) {
    throw new RestoreDatabaseError("RESTORE_VERIFY_FAILED", RESTORE_VERIFY_MESSAGE, { cause: error });
  }
  if (!healthy) {
    throw new RestoreDatabaseError("RESTORE_VERIFY_FAILED", RESTORE_VERIFY_MESSAGE);
  }
}

/** Nothing is removed yet: if the replacement is refused, the WAL was already checkpointed into the database. */
function emptySideFile(path: string): boolean {
  try {
    // Truncating never creates the file.
    truncateSync(path, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT";
  }
}

function removeEmptiedSideFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Already empty, so SQLite starts from nothing beside the new file.
  }
}

export function restoreDatabase(options: {
  source: string;
  databasePath: string;
  remap?: readonly RestorePathRemap[];
  initializeStaging: (database: DatabaseSync) => void;
  backupDirectory?: string;
}): RestoreDatabaseResult {
  const { source, databasePath } = options;
  if (!existsSync(source)) {
    throw new RestoreDatabaseError("RESTORE_SOURCE_MISSING", "The file to restore does not exist.");
  }
  if (existsSync(databasePath) && pathsReferToSameFile(source, databasePath)) {
    throw new RestoreDatabaseError("RESTORE_SAME_FILE", "The file to restore is the current database.");
  }
  const inspected = inspectSnapshot(source);
  if (existsSync(databasePath) && isInUse(databasePath)) {
    throw new RestoreDatabaseError(
      "RESTORE_DATABASE_IN_USE",
      "The database is in use. Stop the API server and close Agents first.",
    );
  }

  let safetyBackup: string | undefined;
  let previousRevisions = { dataRevision: 0, auditRevision: 0 };
  if (existsSync(databasePath)) {
    const current = new DatabaseSync(databasePath);
    try {
      previousRevisions = readChangeRevisions(current);
      safetyBackup = backupDatabase(current, databasePath, { directory: options.backupDirectory }).created.fileName;
      // Everything the WAL holds goes into the database file, so the WAL beside it can be emptied before the replacement.
      const checkpoint = current.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
      if (checkpoint?.busy) {
        throw new RestoreDatabaseError(
          "RESTORE_DATABASE_IN_USE",
          "The database is in use. Stop the API server and close Agents first.",
        );
      }
    } finally {
      current.close();
    }
  }

  const staging = `${databasePath}.restoring`;
  rmSync(staging, { force: true });
  rmSync(`${staging}-wal`, { force: true });
  rmSync(`${staging}-shm`, { force: true });
  // Copying through SQLite, not the file system, includes writes still in the source's WAL.
  const reader = new DatabaseSync(source, { readOnly: true });
  try {
    writeSnapshot(reader, staging);
  } finally {
    reader.close();
  }
  const remapped = { projects: 0, handoffSnapshots: 0 };
  const db = new DatabaseSync(staging);
  let restoreFailed = false;
  let restoreError: unknown;
  try {
    options.initializeStaging(db);
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
    const restoredRevisions = readChangeRevisions(db);
    db.prepare(
      `UPDATE change_revisions
       SET database_id = ?, data_revision = ?, audit_revision = ?
       WHERE singleton = 1`,
    ).run(
      randomUUID(),
      Math.max(previousRevisions.dataRevision, restoredRevisions.dataRevision) + 1,
      Math.max(previousRevisions.auditRevision, restoredRevisions.auditRevision) + 1,
    );
    db.exec("COMMIT");
    assertRestoredCopyHealthy(db);
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    restoreFailed = true;
    restoreError = error;
  } finally {
    db.close();
  }
  if (restoreFailed) {
    rmSync(staging, { force: true });
    rmSync(`${staging}-wal`, { force: true });
    rmSync(`${staging}-shm`, { force: true });
    throw restoreError;
  }

  rmSync(`${staging}-wal`, { force: true });
  rmSync(`${staging}-shm`, { force: true });
  // A leftover WAL would be applied to the new file, so the old side files must be neutralized, and that is settled before
  // the replacement: if a lock keeps them from being emptied, nothing has changed yet and the restore is refused.
  const sideFiles = [`${databasePath}-wal`, `${databasePath}-shm`];
  // The staging copy took a while: an Agent or the API may have opened the database since the first check, and emptying its
  // WAL under it could drop what it wrote. Look once more right before anything is emptied; nothing is touched when it is.
  if (existsSync(databasePath) && isInUse(databasePath)) {
    rmSync(staging, { force: true });
    throw new RestoreDatabaseError(
      "RESTORE_DATABASE_IN_USE",
      "The database is in use. Stop the API server and close Agents first.",
    );
  }
  if (!sideFiles.every(emptySideFile)) {
    rmSync(staging, { force: true });
    throw new RestoreDatabaseError(
      "RESTORE_FILES_LOCKED",
      "The current database's files are held by another program (an antivirus scanner or an indexer). Try again in a moment.",
    );
  }
  try {
    renameSyncWithRetry(staging, databasePath);
  } catch (error) {
    // A file lock (Windows EBUSY / EPERM) that outlasted the retries refuses the replacement: the current database is
    // untouched, and the staging copy is taken away so a later restore starts clean. The error keeps its errno.
    rmSync(staging, { force: true });
    throw error;
  }
  for (const side of sideFiles) removeEmptiedSideFile(side);
  return { ...inspected, schemaVersion: LATEST_SCHEMA_VERSION, remapped, safetyBackup };
}
