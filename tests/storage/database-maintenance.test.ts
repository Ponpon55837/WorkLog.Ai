import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseReadOnly } from "../../apps/server/src/doctor.js";
import { listDatabaseBackups } from "../../packages/storage/src/backup.js";
import { DatabaseInitializationError } from "../../packages/storage/src/database-initialization.js";
import { DatabaseMaintenanceError, maintainDatabase } from "../../packages/storage/src/database-maintenance.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { undoSchemaMigration } from "../helpers/schema-migration-fixture.js";

const temporaryDirectories: string[] = [];

function setup(): { directory: string; databasePath: string; store: WorkIntelligenceStore } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-maintenance-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const projectRoot = join(directory, "orchard");
  const project = store.addProject("Orchard", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const result = store.finalizeSession({
    projectRoot,
    idempotencyKey: "synthetic-maintenance-session",
    title: "Rebuild the orchard search cache",
    summary: "Rebuild the search cache after a synthetic test reset.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["src/orchard.ts"],
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") {
    throw new Error(`Expected a finalized Session, got ${result.outcome}.`);
  }
  return { directory, databasePath, store };
}

function maintenanceFailure(options: Parameters<typeof maintainDatabase>[0]): unknown {
  try {
    maintainDatabase(options);
  } catch (error) {
    return error;
  }
  return undefined;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database maintenance", () => {
  it("backs up, rebuilds search rows, and records a result that doctor reads without writing", async () => {
    const { directory, databasePath, store } = setup();
    const beforeMaintenance = store.getChangeToken();
    store.close();

    const damagedIndex = new DatabaseSync(databasePath);
    damagedIndex.exec(
      "DELETE FROM search_fts; DELETE FROM search_chunks; DELETE FROM search_paths; DELETE FROM search_dirty;",
    );
    damagedIndex.close();

    const result = maintainDatabase({ databasePath });
    expect(result.backupFileName).toMatch(/^work-intelligence-pre-maintenance-\d{8}T\d{6}Z\.sqlite$/);
    expect(existsSync(join(directory, "backups", result.backupFileName))).toBe(true);
    expect(result).toMatchObject({ indexedSessions: 1, indexedKnowledge: 0 });
    expect(result.indexedChunks).toBeGreaterThan(0);
    expect(result.indexedPaths).toBe(1);

    const reopened = new WorkIntelligenceStore(databasePath);
    expect(reopened.getChangeToken().dataRevision).toBe(beforeMaintenance.dataRevision);
    const search = reopened.search("orchard cache");
    expect(Array.isArray(search) ? search[0]?.session.title : undefined).toBe("Rebuild the orchard search cache");
    reopened.close();

    const beforeInspection = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    await expect(inspectDatabaseReadOnly(databasePath)).resolves.toMatchObject({
      state: "ok",
      maintenance: {
        status: "completed",
        backupFileName: result.backupFileName,
        indexedSessions: 1,
        indexedKnowledge: 0,
      },
    });
    const afterInspection = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    expect(afterInspection).toBe(beforeInspection);
  });

  it("refuses to start while another connection holds a write lock", () => {
    const { databasePath, store } = setup();
    store.close();
    const writer = new DatabaseSync(databasePath);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      let failure: unknown;
      try {
        maintainDatabase({ databasePath });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DatabaseMaintenanceError);
      expect(failure).toMatchObject({ code: "DATABASE_IN_USE" });
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });

  it("refuses maintenance while another Work Intelligence store is open", () => {
    const { databasePath, store } = setup();
    try {
      let failure: unknown;
      try {
        maintainDatabase({ databasePath });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DatabaseMaintenanceError);
      expect(failure).toMatchObject({ code: "DATABASE_IN_USE" });
    } finally {
      store.close();
    }
  });

  it("backs up and applies a pending migration before database maintenance", () => {
    const { databasePath, store } = setup();
    store.close();
    const legacy = new DatabaseSync(databasePath);
    undoSchemaMigration(legacy, LATEST_SCHEMA_VERSION);
    legacy.close();

    const result = maintainDatabase({ databasePath });
    const backupFileNames = listDatabaseBackups(databasePath).map((backup) => backup.fileName);
    expect(backupFileNames).toContainEqual(
      expect.stringMatching(new RegExp(`^work-intelligence-pre-migration-v${LATEST_SCHEMA_VERSION}-`)),
    );
    expect(backupFileNames).toContain(result.backupFileName);

    const current = new DatabaseSync(databasePath, { readOnly: true });
    const version = current.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    current.close();
    expect(version.version).toBe(LATEST_SCHEMA_VERSION);
  });

  it("answers DATABASE_MISSING for an in-memory or absent database", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-maintenance-missing-"));
    temporaryDirectories.push(directory);
    expect(maintenanceFailure({ databasePath: ":memory:" })).toMatchObject({ code: "DATABASE_MISSING" });
    expect(maintenanceFailure({ databasePath: join(directory, "absent.sqlite") })).toMatchObject({
      code: "DATABASE_MISSING",
    });
    expect(existsSync(join(directory, "absent.sqlite"))).toBe(false);
  });

  it("calls a file that is not a SQLite database invalid, not in use, and leaves it unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-maintenance-not-sqlite-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "notes.sqlite");
    writeFileSync(databasePath, "Synthetic notes that are not a database. ".repeat(200), "utf8");
    const before = fileHash(databasePath);

    const failure = maintenanceFailure({ databasePath, backup: { directory: join(directory, "backups") } });
    expect(failure).toBeInstanceOf(DatabaseMaintenanceError);
    expect(failure).toMatchObject({ code: "DATABASE_INVALID" });
    expect((failure as Error).message).not.toMatch(/sqlite|not a database/i);
    expect(fileHash(databasePath)).toBe(before);
    expect(existsSync(join(directory, "backups"))).toBe(false);
  });

  it("refuses a SQLite file without Work Intelligence tables", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-maintenance-foreign-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "foreign.sqlite");
    const foreign = new DatabaseSync(databasePath);
    foreign.exec("CREATE TABLE recipes (name TEXT); INSERT INTO recipes VALUES ('fictional soup');");
    foreign.close();
    expect(maintenanceFailure({ databasePath })).toMatchObject({ code: "DATABASE_INVALID" });
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "recipes" }]);
    } finally {
      check.close();
    }
  });

  it("stops at a failed integrity check before writing a backup or changing the database", () => {
    const { directory, databasePath, store } = setup();
    store.close();
    // Overwrite one index's root page with another index's: SQLite then reports missing index rows. The pages are
    // swapped in the file itself because newer SQLite builds refuse to edit sqlite_master (defensive mode).
    const damaged = new DatabaseSync(databasePath);
    damaged.exec(`CREATE TABLE fixture_a (value TEXT); CREATE TABLE fixture_b (value TEXT);
      CREATE INDEX fixture_a_value ON fixture_a(value); CREATE INDEX fixture_b_value ON fixture_b(value);
      INSERT INTO fixture_a VALUES ('first'), ('second'); INSERT INTO fixture_b VALUES ('other');`);
    const rootPage = (name: string): number =>
      (damaged.prepare("SELECT rootpage FROM sqlite_master WHERE name = ?").get(name) as { rootpage: number }).rootpage;
    const targetPage = rootPage("fixture_a_value");
    const sourcePage = rootPage("fixture_b_value");
    const { page_size: pageSize } = damaged.prepare("PRAGMA page_size").get() as { page_size: number };
    damaged.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    damaged.close();
    const bytes = readFileSync(databasePath);
    bytes.copy(bytes, (targetPage - 1) * pageSize, (sourcePage - 1) * pageSize, sourcePage * pageSize);
    writeFileSync(databasePath, bytes);
    const before = fileHash(databasePath);
    const backupDirectory = join(directory, "backups");

    const failure = maintenanceFailure({ databasePath, backup: { directory: backupDirectory } });
    expect(failure).toBeInstanceOf(DatabaseMaintenanceError);
    expect(failure).toMatchObject({ code: "DATABASE_INTEGRITY_FAILED" });
    expect(fileHash(databasePath)).toBe(before);
    expect(existsSync(backupDirectory) ? readdirSync(backupDirectory) : []).toEqual([]);
  });

  it("answers DATABASE_BACKUP_FAILED without starting maintenance when the backup cannot be written", () => {
    const { directory, databasePath, store } = setup();
    store.close();
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "synthetic file where the backup directory should be", "utf8");

    expect(maintenanceFailure({ databasePath, backup: { directory: blocked } })).toMatchObject({
      code: "DATABASE_BACKUP_FAILED",
    });
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS count FROM database_maintenance_runs").get()).toEqual({ count: 0 });
    } finally {
      check.close();
    }
  });

  it("passes a schema-too-new refusal through unchanged", () => {
    const { databasePath, store } = setup();
    store.close();
    const future = new DatabaseSync(databasePath);
    future
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(LATEST_SCHEMA_VERSION + 1, "synthetic_future_migration", new Date().toISOString());
    future.close();

    const failure = maintenanceFailure({ databasePath });
    expect(failure).toBeInstanceOf(DatabaseInitializationError);
    expect(failure).toMatchObject({ code: "DATABASE_SCHEMA_VERSION_TOO_NEW" });
  });
});
