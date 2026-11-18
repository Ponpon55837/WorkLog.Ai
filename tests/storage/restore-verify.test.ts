import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { restoreDatabase, RestoreDatabaseError } from "../../packages/storage/src/backup.js";
import { initializeWorkIntelligenceDatabase } from "../../packages/storage/src/database-initialization.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { fingerprintDatabase } from "../helpers/database-fingerprint.js";

// Fictional fixtures only. The post-migration check of restoreDatabase is driven through its existing injectable
// `initializeStaging` callback (the production CLI passes the real initializer): the test callback runs the real
// initializer and then damages the staging copy, so no test-only code exists in production.
const tempDirs: string[] = [];

function initializeThen(damage?: (database: DatabaseSync) => void): (database: DatabaseSync) => void {
  return (database) => {
    initializeWorkIntelligenceDatabase(database, ":memory:");
    damage?.(database);
  };
}

/** A snapshot with one project and one Session, and a different live database to be replaced. */
function scenario() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-restore-verify-"));
  tempDirs.push(root);
  const snapshot = join(root, "snapshot.sqlite");
  const databasePath = join(root, "live.sqlite");
  const projectRoot = join(root, "pond");
  mkdirSync(projectRoot);
  const source = new WorkIntelligenceStore(join(root, "source.sqlite"));
  try {
    const project = source.addProject("Pond", projectRoot);
    source.updateProject(project.id, { status: "tracked" });
    source.finalizeSession({
      projectRoot,
      idempotencyKey: "restore-verify",
      title: "Pump the pond",
      summary: "Synthetic Session.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    source.exportTo(snapshot);
  } finally {
    source.close();
  }
  const live = new WorkIntelligenceStore(databasePath);
  try {
    live.addProject("Live Meadow", join(root, "meadow"));
  } finally {
    live.close();
  }
  return { root, snapshot, databasePath, backupDirectory: join(root, "backups") };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("restoreDatabase verification of the migrated staging copy", () => {
  it("still restores a healthy snapshot and leaves no staging files", () => {
    const { snapshot, databasePath, backupDirectory } = scenario();
    const result = restoreDatabase({
      source: snapshot,
      databasePath,
      initializeStaging: initializeThen(),
      backupDirectory,
    });
    expect(result).toMatchObject({ schemaVersion: LATEST_SCHEMA_VERSION, projects: 1, sessions: 1 });
    expect(existsSync(`${databasePath}.restoring`)).toBe(false);
    const db = new WorkIntelligenceStore(databasePath);
    try {
      expect(db.listProjects().map((project) => project.name)).toEqual(["Pond"]);
    } finally {
      db.close();
    }
  });

  it.each([
    [
      "a foreign key left dangling by the migration",
      (database: DatabaseSync) => {
        database.exec("PRAGMA foreign_keys = OFF");
        database.exec("UPDATE sessions SET project_id = 'ghost-project'");
        database.exec("PRAGMA foreign_keys = ON");
      },
    ],
    [
      "a row that breaks a CHECK constraint",
      (database: DatabaseSync) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec("UPDATE sessions SET execution_status = 'bogus'");
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
    ],
  ])("refuses %s and leaves the live database and no staging files behind", (_name, damage) => {
    const { snapshot, databasePath, backupDirectory } = scenario();
    const before = fingerprintDatabase(databasePath);

    let caught: unknown;
    try {
      restoreDatabase({ source: snapshot, databasePath, initializeStaging: initializeThen(damage), backupDirectory });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RestoreDatabaseError);
    expect(caught).toMatchObject({ code: "RESTORE_VERIFY_FAILED" });
    expect(fingerprintDatabase(databasePath)).toEqual(before);
    for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(`${databasePath}.restoring${suffix}`)).toBe(false);
    // The only new artefact is the safety backup of the untouched live database.
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
});
