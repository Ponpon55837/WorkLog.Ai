import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseReadOnly } from "../../apps/server/src/doctor.js";
import { listDatabaseBackups } from "../../packages/storage/src/backup.js";
import { DatabaseMaintenanceError, maintainDatabase } from "../../packages/storage/src/database-maintenance.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database maintenance", () => {
  it("backs up, rebuilds search rows, and records a result that doctor reads without writing", async () => {
    const { directory, databasePath, store } = setup();
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
    legacy.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
    legacy.exec("DROP TABLE database_maintenance_runs;");
    legacy.close();

    const result = maintainDatabase({ databasePath });
    const backupFileNames = listDatabaseBackups(databasePath).map((backup) => backup.fileName);
    expect(backupFileNames).toContainEqual(expect.stringMatching(/^work-intelligence-pre-migration-v12-/));
    expect(backupFileNames).toContain(result.backupFileName);

    const current = new DatabaseSync(databasePath, { readOnly: true });
    const version = current.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    current.close();
    expect(version.version).toBe(LATEST_SCHEMA_VERSION);
  });
});
