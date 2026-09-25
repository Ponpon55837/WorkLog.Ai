import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseInitializationError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";

const tempDirs: string[] = [];

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

function hasSessionColumn(db: DatabaseSync, name: string): boolean {
  return (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some(
    (column) => column.name === name,
  );
}

describe("database initialization", () => {
  it("backs up a file database with the pending version tag before applying its migration", () => {
    const paths = createDatabasePaths();
    const initialStore = new WorkIntelligenceStore(paths.databasePath, {
      backup: { directory: paths.backupDirectory },
    });
    expect(initialStore.listBackups()).toMatchObject({ outcome: "database_backups", backups: [] });
    initialStore.close();

    const oldDatabase = new DatabaseSync(paths.databasePath);
    oldDatabase.exec(`ALTER TABLE sessions DROP COLUMN changed_files_confirmed`);
    oldDatabase.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
    expect(maxSchemaVersion(oldDatabase)).toBe(LATEST_SCHEMA_VERSION - 1);
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
      expect(backups.backups[0]).toMatchObject({ kind: "manual" });
      expect(backups.backups[0]?.fileName).toContain(`pre-migration-v${LATEST_SCHEMA_VERSION}-`);

      const snapshotPath = join(paths.backupDirectory, backups.backups[0]?.fileName ?? "");
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        expect(maxSchemaVersion(snapshot)).toBe(LATEST_SCHEMA_VERSION - 1);
        expect(hasSessionColumn(snapshot, "changed_files_confirmed")).toBe(false);
      } finally {
        snapshot.close();
      }

      const upgraded = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        expect(maxSchemaVersion(upgraded)).toBe(LATEST_SCHEMA_VERSION);
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
    oldDatabase.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
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
      expect(maxSchemaVersion(unchanged)).toBe(LATEST_SCHEMA_VERSION - 1);
      expect(hasSessionColumn(unchanged, "changed_files_confirmed")).toBe(false);
    } finally {
      unchanged.close();
    }
  });
});
