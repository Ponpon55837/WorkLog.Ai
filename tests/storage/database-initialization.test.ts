import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseInitializationError,
  initializeWorkIntelligenceDatabase,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";

const tempDirs: string[] = [];
const CHANGED_FILES_CONFIRMED_MIGRATION_VERSION = 10;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePaths(): { root: string; databasePath: string; backupDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-migration-test-"));
  tempDirs.push(root);
  return {
    root,
    databasePath: join(root, "work-intelligence.sqlite"),
    backupDirectory: join(root, "backups"),
  };
}

function maxSchemaVersion(db: DatabaseSync): number {
  return (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
}

function hasSchemaVersion(db: DatabaseSync, version: number): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM schema_migrations WHERE version = ?").get(version));
}

function hasSessionColumn(db: DatabaseSync, name: string): boolean {
  return (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(
    (column) => column.name === name,
  );
}

/** Leaves a current database with one pending migration, the fixture the backup tests use. */
function removeChangedFilesConfirmedMigration(databasePath: string): void {
  const oldDatabase = new DatabaseSync(databasePath);
  try {
    oldDatabase.exec("ALTER TABLE sessions DROP COLUMN changed_files_confirmed");
    oldDatabase
      .prepare("DELETE FROM schema_migrations WHERE version = ?")
      .run(CHANGED_FILES_CONFIRMED_MIGRATION_VERSION);
  } finally {
    oldDatabase.close();
  }
}

function backupFiles(backupDirectory: string): string[] {
  return existsSync(backupDirectory) ? readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite")) : [];
}

function openFailure(open: () => void): unknown {
  try {
    open();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Holds the write lock from a second connection, as another MCP or API process would, until released. */
function holdWriteLock(databasePath: string): { release: () => void } {
  const holder = new DatabaseSync(databasePath);
  holder.exec("BEGIN IMMEDIATE");
  return {
    release: () => {
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

describe("database initialization", () => {
  it("configures the cache size on a newly opened store connection", () => {
    const store = new WorkIntelligenceStore(":memory:");
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(db.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: -16000 });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      store.close();
    }
  });

  it("configures the shared cache and busy timeout on a read-only store connection", () => {
    const paths = createDatabasePaths();
    const initialized = new WorkIntelligenceStore(paths.databasePath);
    initialized.close();

    const store = new WorkIntelligenceStore(paths.databasePath, {
      mode: "read-only",
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    });
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      expect(db.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: -16000 });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      store.close();
    }
  });

  it("backs up a file database with the pending version tag before applying its migration", () => {
    const paths = createDatabasePaths();
    const initialStore = new WorkIntelligenceStore(paths.databasePath, {
      backup: { directory: paths.backupDirectory },
    });
    expect(initialStore.listBackups()).toMatchObject({ outcome: "database_backups", backups: [] });
    initialStore.close();

    const oldDatabase = new DatabaseSync(paths.databasePath);
    oldDatabase.exec(`ALTER TABLE sessions DROP COLUMN changed_files_confirmed`);
    oldDatabase
      .prepare("DELETE FROM schema_migrations WHERE version = ?")
      .run(CHANGED_FILES_CONFIRMED_MIGRATION_VERSION);
    expect(hasSchemaVersion(oldDatabase, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(false);
    expect(maxSchemaVersion(oldDatabase)).toBe(LATEST_SCHEMA_VERSION);
    oldDatabase.close();

    const upgradedStore = new WorkIntelligenceStore(paths.databasePath, {
      backup: { directory: paths.backupDirectory, keep: 2 },
    });
    try {
      const backups = upgradedStore.listBackups();
      expect(backups.outcome).toBe("database_backups");
      if (backups.outcome !== "database_backups") {
        throw new Error("Expected the migration backup to be available");
      }
      expect(backups.backups).toHaveLength(1);
      expect(backups.backups[0]).toMatchObject({ kind: "migration" });
      expect(backups.backups[0]?.fileName).toContain(`pre-migration-v${CHANGED_FILES_CONFIRMED_MIGRATION_VERSION}-`);

      const snapshotPath = join(paths.backupDirectory, backups.backups[0]?.fileName ?? "");
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        expect(hasSchemaVersion(snapshot, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(false);
        expect(maxSchemaVersion(snapshot)).toBe(LATEST_SCHEMA_VERSION);
        expect(hasSessionColumn(snapshot, "changed_files_confirmed")).toBe(false);
      } finally {
        snapshot.close();
      }

      const upgraded = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        expect(maxSchemaVersion(upgraded)).toBe(LATEST_SCHEMA_VERSION);
        expect(hasSchemaVersion(upgraded, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(true);
        expect(hasSessionColumn(upgraded, "changed_files_confirmed")).toBe(true);
      } finally {
        upgraded.close();
      }
    } finally {
      upgradedStore.close();
    }
  });

  it("rejects a database from a newer schema before it changes the database or creates a backup", () => {
    const paths = createDatabasePaths();
    const initialStore = new WorkIntelligenceStore(paths.databasePath, {
      backup: { directory: paths.backupDirectory },
    });
    initialStore.close();

    const futureVersion = LATEST_SCHEMA_VERSION + 1;
    const seed = new DatabaseSync(paths.databasePath);
    seed
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(futureVersion, "future-test-migration", "2026-09-25T00:00:00.000Z");
    const originalTables = (
      seed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const originalVersions = seed
      .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
      .all();
    seed.close();

    let caught: unknown;
    try {
      const store = new WorkIntelligenceStore(paths.databasePath, { backup: { directory: paths.backupDirectory } });
      store.close();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseInitializationError);
    expect(caught).toMatchObject({ code: "DATABASE_SCHEMA_VERSION_TOO_NEW" });
    expect(caught).toHaveProperty("message", expect.stringContaining("請更新 Work Intelligence"));
    expect(existsSync(paths.backupDirectory)).toBe(false);

    const reopened = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      const tables = (
        reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      const versions = reopened
        .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
        .all();
      expect(tables).toEqual(originalTables);
      expect(versions).toEqual(originalVersions);
    } finally {
      reopened.close();
    }
  });

  it("stops before migrating when the pre-migration backup cannot be written", () => {
    const paths = createDatabasePaths();
    const initialStore = new WorkIntelligenceStore(paths.databasePath);
    initialStore.close();

    const oldDatabase = new DatabaseSync(paths.databasePath);
    oldDatabase.exec("ALTER TABLE sessions DROP COLUMN changed_files_confirmed");
    oldDatabase
      .prepare("DELETE FROM schema_migrations WHERE version = ?")
      .run(CHANGED_FILES_CONFIRMED_MIGRATION_VERSION);
    oldDatabase.close();
    writeFileSync(paths.backupDirectory, "the backup directory is unavailable", "utf8");

    let caught: unknown;
    try {
      const store = new WorkIntelligenceStore(paths.databasePath, { backup: { directory: paths.backupDirectory } });
      store.close();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseInitializationError);
    expect(caught).toMatchObject({ code: "DATABASE_MIGRATION_BACKUP_FAILED" });
    expect((caught as Error).message).not.toContain("ENOTDIR");

    const unchanged = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      expect(maxSchemaVersion(unchanged)).toBe(LATEST_SCHEMA_VERSION);
      expect(hasSchemaVersion(unchanged, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(false);
      expect(hasSessionColumn(unchanged, "changed_files_confirmed")).toBe(false);
    } finally {
      unchanged.close();
    }
  });
  it("opens a current database for reads while another connection holds the write lock", () => {
    const paths = createDatabasePaths();
    const initialStore = new WorkIntelligenceStore(paths.databasePath, {
      backup: { directory: paths.backupDirectory },
    });
    initialStore.addProject("Locked reader", join(paths.root, "locked-reader"));
    initialStore.close();

    const lock = holdWriteLock(paths.databasePath);
    try {
      const store = new WorkIntelligenceStore(paths.databasePath, { backup: { directory: paths.backupDirectory } });
      try {
        expect(store.listProjects().map((project) => project.name)).toEqual(["Locked reader"]);
      } finally {
        store.close();
      }
    } finally {
      lock.release();
    }
    expect(backupFiles(paths.backupDirectory)).toEqual([]);
  });

  it("answers DATABASE_BUSY without a backup while a pending migration waits for the lock, then migrates once released", () => {
    const paths = createDatabasePaths();
    new WorkIntelligenceStore(paths.databasePath).close();
    removeChangedFilesConfirmedMigration(paths.databasePath);

    const lock = holdWriteLock(paths.databasePath);
    let busy: unknown;
    try {
      busy = openFailure(() =>
        new WorkIntelligenceStore(paths.databasePath, { backup: { directory: paths.backupDirectory } }).close(),
      );
    } finally {
      lock.release();
    }
    expect(busy).toBeInstanceOf(DatabaseInitializationError);
    expect(busy).toMatchObject({ code: "DATABASE_BUSY", message: "資料庫暫時忙碌，請稍後再試" });
    expect(backupFiles(paths.backupDirectory)).toEqual([]);

    const store = new WorkIntelligenceStore(paths.databasePath, { backup: { directory: paths.backupDirectory } });
    store.close();
    expect(backupFiles(paths.backupDirectory)).toHaveLength(1);
    const upgraded = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      expect(hasSchemaVersion(upgraded, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(true);
      expect(hasSessionColumn(upgraded, "changed_files_confirmed")).toBe(true);
    } finally {
      upgraded.close();
    }
  }, 30_000);

  it("initializes a current database through a read-only connection without writing", () => {
    const paths = createDatabasePaths();
    new WorkIntelligenceStore(paths.databasePath).close();
    const db = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      expect(() => initializeWorkIntelligenceDatabase(db, paths.databasePath)).not.toThrow();
      expect(maxSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("reports a pending migration on a read-only database as DATABASE_READ_ONLY before writing a backup", () => {
    const paths = createDatabasePaths();
    new WorkIntelligenceStore(paths.databasePath).close();
    removeChangedFilesConfirmedMigration(paths.databasePath);
    const db = new DatabaseSync(paths.databasePath, { readOnly: true });
    let caught: unknown;
    try {
      caught = openFailure(() =>
        initializeWorkIntelligenceDatabase(db, paths.databasePath, { directory: paths.backupDirectory }),
      );
      expect(hasSchemaVersion(db, CHANGED_FILES_CONFIRMED_MIGRATION_VERSION)).toBe(false);
    } finally {
      db.close();
    }
    expect(caught).toBeInstanceOf(DatabaseInitializationError);
    expect(caught).toMatchObject({ code: "DATABASE_READ_ONLY" });
    expect((caught as Error).message).not.toMatch(/sqlite|readonly database/i);
    expect(backupFiles(paths.backupDirectory)).toEqual([]);
  });

  it("repairs a current-version database whose base schema lost an index through the write path", () => {
    const paths = createDatabasePaths();
    new WorkIntelligenceStore(paths.databasePath).close();
    const damaged = new DatabaseSync(paths.databasePath);
    damaged.exec("DROP INDEX idx_projects_status");
    damaged.close();

    new WorkIntelligenceStore(paths.databasePath).close();
    const repaired = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_projects_status'").get()).toEqual({
        name: "idx_projects_status",
      });
    } finally {
      repaired.close();
    }
  });
});
