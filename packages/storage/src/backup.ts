import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseBackup, DatabaseBackupCreated } from "@work-intelligence/core";
import { remapPathPrefix } from "./project-path-remap.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";

export const DEFAULT_BACKUP_KEEP = 14;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function parseName(value: string): { createdAt: string; sequence: number } | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?$/.exec(value);
  return match
    ? {
        createdAt: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
        sequence: Number(match[7] ?? 1),
      }
    : null;
}

/** Backups of this database, newest first; files that do not follow the naming scheme are ignored. */
export function listDatabaseBackups(
  databasePath: string,
  directory = defaultBackupDirectory(databasePath),
): DatabaseBackup[] {
  if (!existsSync(directory)) {
    return [];
  }
  const prefix = backupPrefix(databasePath);
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .flatMap((fileName) => {
      const parsed = parseName(fileName.slice(prefix.length, -".sqlite".length));
      if (!parsed) {
        return [];
      }
      const bytes = statSync(join(directory, fileName)).size;
      return [{ backup: { fileName, createdAt: parsed.createdAt, bytes }, sequence: parsed.sequence }];
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

/** Writes a checked, owner-only snapshot into the backup directory and prunes copies beyond `keep`. */
export function backupDatabase(
  db: DatabaseSync,
  databasePath: string,
  options: { directory?: string; keep?: number; now?: Date } = {},
): DatabaseBackupCreated {
  const directory = options.directory ?? defaultBackupDirectory(databasePath);
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_BACKUP_KEEP));
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const stamp = timestamp(options.now ?? new Date());
  let fileName = `${backupPrefix(databasePath)}${stamp}.sqlite`;
  for (let suffix = 2; existsSync(join(directory, fileName)); suffix += 1) {
    fileName = `${backupPrefix(databasePath)}${stamp}-${suffix}.sqlite`;
  }
  const target = join(directory, fileName);
  writeSnapshot(db, target);

  const backups = listDatabaseBackups(databasePath, directory);
  for (const stale of backups.slice(keep)) {
    rmSync(join(directory, stale.fileName), { force: true });
  }
  const kept = backups.slice(0, keep);
  const created = kept.find((backup) => backup.fileName === fileName) ?? {
    fileName,
    createdAt: new Date().toISOString(),
    bytes: statSync(target).size,
  };
  return { outcome: "database_backups", keep, backups: kept, created };
}

/** True when there is no backup yet or the newest one is at least a day old. */
export function isBackupDue(databasePath: string, directory?: string, now = new Date()): boolean {
  const [latest] = listDatabaseBackups(databasePath, directory);
  return !latest || now.getTime() - Date.parse(latest.createdAt) >= BACKUP_INTERVAL_MS;
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
