import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  RestoreDatabaseError,
} from "../../packages/storage/src/backup.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

/**
 * The safety of 「從備份還原」 at the storage level: a backup is looked at read-only and refused before anything is touched
 * when it is not ours, damaged or newer than this version; and a restore that fails (a database in use, a Windows file lock)
 * never loses data: the original database is exactly as it was and the automatic safety backup exists. Synthetic data only.
 */

const failures = vi.hoisted(() => ({
  rename: undefined as { code: string; message: string } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => {
      const failure = failures.rename;
      // Only the replacement of the database is refused; the snapshot publication inside writeSnapshot uses hard links.
      if (failure && String(args[0]).endsWith(".restoring")) {
        failures.rename = undefined;
        throw Object.assign(new Error(failure.message), { code: failure.code });
      }
      return actual.renameSync(...args);
    }),
  };
});

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  failures.rename = undefined;
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function initializeStaging(database: DatabaseSync): void {
  initializeWorkIntelligenceDatabase(database, ":memory:");
}

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-restore-safety-"));
  tempDirs.push(root);
  return root;
}

/** A database with one project, and a snapshot of a different state to restore from. */
function fixture() {
  const root = directory();
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  store.addProject("Apiary", join(root, "apiary"));
  const snapshot = join(root, "snapshot.sqlite");
  store.addProject("Beehive", join(root, "beehive"));
  store.exportTo(snapshot);
  return { root, databasePath, store, snapshot };
}

function closeStore(store: WorkIntelligenceStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

function projectNames(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    database.close();
  }
}

function codeOf(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof RestoreDatabaseError ? error.code : ((error as { code?: string }).code ?? "other");
  }
  return undefined;
}

describe("looking at a backup read-only", () => {
  it("reads the schema version and counts of a Work Intelligence database", () => {
    const { snapshot } = fixture();
    expect(inspectDatabaseBackup(snapshot)).toEqual({
      status: "ok",
      schemaVersion: LATEST_SCHEMA_VERSION,
      projects: 2,
      sessions: 0,
    });
  });

  it("reports a schema newer than this version before anything else, even without the integrity check", () => {
    const { snapshot } = fixture();
    const database = new DatabaseSync(snapshot);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', '2030-01-01')")
      .run(LATEST_SCHEMA_VERSION + 1);
    database.close();
    expect(inspectDatabaseBackup(snapshot)).toEqual({
      status: "newer-schema",
      schemaVersion: LATEST_SCHEMA_VERSION + 1,
    });
    expect(inspectDatabaseBackup(snapshot, { integrity: false }).status).toBe("newer-schema");
  });

  it("refuses a file that is not an SQLite database, an empty file, and a database without our tables", () => {
    const root = directory();
    const text = join(root, "notes.txt");
    writeFileSync(text, "this is not a database, only some synthetic text ".repeat(40));
    expect(inspectDatabaseBackup(text).status).toBe("not-database");

    const empty = join(root, "empty.sqlite");
    writeFileSync(empty, "");
    expect(inspectDatabaseBackup(empty).status).toBe("not-database");

    const foreign = join(root, "foreign.sqlite");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE notes (body TEXT)");
    other.close();
    expect(inspectDatabaseBackup(foreign).status).toBe("not-database");
  });

  it("refuses a damaged database file and a file that is missing", () => {
    const { snapshot } = fixture();
    const bytes = readFileSync(snapshot);
    // Overwrite the middle pages: the header and the schema stay readable, the content does not.
    const damaged = join(directory(), "damaged.sqlite");
    const copy = Buffer.from(bytes);
    copy.fill(0xab, Math.floor(copy.length / 2), copy.length);
    writeFileSync(damaged, copy);
    expect(["corrupt", "not-database"]).toContain(inspectDatabaseBackup(damaged).status);
    expect(inspectDatabaseBackup(join(directory(), "missing.sqlite")).status).not.toBe("ok");
  });
});

describe("a restore that cannot finish never loses data", () => {
  it("classifies a database in use, touches nothing and makes no replacement", () => {
    const { databasePath, snapshot } = fixture();
    // The open store holds the database (an Agent or the API would): the restore is refused first.
    const code = codeOf(() => restoreDatabase({ source: snapshot, databasePath, initializeStaging }));
    expect(code).toBe("RESTORE_DATABASE_IN_USE");
    expect(projectNames(databasePath)).toEqual(["Apiary", "Beehive"]);
    expect(existsSync(`${databasePath}.restoring`)).toBe(false);
  });

  it("refuses a newer schema or a foreign file before the current database is even backed up", () => {
    const { root, store, databasePath, snapshot } = fixture();
    closeStore(store);
    const before = projectNames(databasePath);
    const newer = join(root, "newer.sqlite");
    writeFileSync(newer, readFileSync(snapshot));
    const database = new DatabaseSync(newer);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', '2030-01-01')")
      .run(LATEST_SCHEMA_VERSION + 1);
    database.close();
    const foreign = join(root, "foreign.sqlite");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE notes (body TEXT)");
    other.close();

    expect(codeOf(() => restoreDatabase({ source: newer, databasePath, initializeStaging }))).toBe(
      "RESTORE_SCHEMA_TOO_NEW",
    );
    expect(codeOf(() => restoreDatabase({ source: foreign, databasePath, initializeStaging }))).toBe(
      "RESTORE_NOT_DATABASE",
    );
    expect(projectNames(databasePath)).toEqual(before);
    // Nothing was backed up or staged: the refusal came before any write.
    expect(listDatabaseBackups(databasePath)).toEqual([]);
    expect(existsSync(`${databasePath}.restoring`)).toBe(false);
  });

  it.each(["EBUSY", "EPERM"])(
    "keeps the original database and its safety backup when a file lock (%s) refuses the replacement",
    (code) => {
      const { root, store, databasePath, snapshot } = fixture();
      closeStore(store);
      // A different state is restored over this one; the failure must leave this one exactly as it is.
      const original = new DatabaseSync(databasePath);
      original.prepare("DELETE FROM projects WHERE name = 'Beehive'").run();
      original.close();
      expect(projectNames(databasePath)).toEqual(["Apiary"]);

      failures.rename = { code, message: `${code}: resource busy or locked` };
      expect(codeOf(() => restoreDatabase({ source: snapshot, databasePath, initializeStaging }))).toBe(code);

      // The original database is intact and opens.
      expect(projectNames(databasePath)).toEqual(["Apiary"]);
      expect(inspectDatabaseBackup(databasePath).status).toBe("ok");
      // The automatic safety backup of it exists, holds the same data, and no staging copy is left behind.
      const backups = listDatabaseBackups(databasePath);
      expect(backups).toHaveLength(1);
      expect(projectNames(join(root, "backups", backups[0]?.fileName ?? ""))).toEqual(["Apiary"]);
      expect(existsSync(`${databasePath}.restoring`)).toBe(false);
      expect(readdirSync(root).filter((name) => name.includes(".restoring"))).toEqual([]);
    },
  );

  it("restores when nothing is wrong, and the safety backup holds what was replaced", () => {
    const { root, store, databasePath, snapshot } = fixture();
    closeStore(store);
    const original = new DatabaseSync(databasePath);
    original.prepare("DELETE FROM projects WHERE name = 'Beehive'").run();
    original.close();

    const result = restoreDatabase({ source: snapshot, databasePath, initializeStaging });
    expect(result).toMatchObject({ projects: 2, schemaVersion: LATEST_SCHEMA_VERSION });
    expect(projectNames(databasePath)).toEqual(["Apiary", "Beehive"]);
    expect(projectNames(join(root, "backups", result.safetyBackup ?? ""))).toEqual(["Apiary"]);
  });

  it("restores into a missing database (nothing to back up, nothing lost)", () => {
    const { store, databasePath, snapshot } = fixture();
    closeStore(store);
    rmSync(databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    const result = restoreDatabase({ source: snapshot, databasePath, initializeStaging });
    expect(result.safetyBackup).toBeUndefined();
    expect(projectNames(databasePath)).toEqual(["Apiary", "Beehive"]);
  });
});
