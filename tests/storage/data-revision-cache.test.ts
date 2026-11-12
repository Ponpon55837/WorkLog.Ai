import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DataRevisionCache } from "../../packages/storage/src/data-revision-cache.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. A second store or a raw connection on the same file stands in for another process
// (the REST server and the MCP servers share one SQLite file).
const stores: WorkIntelligenceStore[] = [];
const connections: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { databasePath: string; first: WorkIntelligenceStore; roots: string[]; projectIds: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-revision-cache-"));
  tempDirs.push(directory);
  const databasePath = join(directory, "shared.sqlite");
  const first = new WorkIntelligenceStore(databasePath);
  stores.push(first);
  const roots = [join(directory, "apiary"), join(directory, "burrow")];
  const projectIds = roots.map((root, index) => {
    const project = first.addProject(`Project ${index}`, root);
    first.updateProject(project.id, { status: "tracked" });
    return project.id;
  });
  return { databasePath, first, roots, projectIds };
}

function openStore(databasePath: string): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  return store;
}

function openRaw(databasePath: string): DatabaseSync {
  const connection = new DatabaseSync(databasePath);
  connection.exec("PRAGMA busy_timeout = 5000");
  connections.push(connection);
  return connection;
}

function finalizeWithoutVerification(store: WorkIntelligenceStore, root: string, key: string): string {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: "Routine maintenance.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["src/index.ts"],
    verification: { status: "not_run" },
  });
  if (result.outcome !== "finalized") throw new Error(`Expected ${key} to finalize`);
  return result.session.id;
}

function needsBackfill(store: WorkIntelligenceStore, projectRoot?: string): number | undefined {
  return store.countMetadataBackfillFollowUps(projectRoot ? { projectRoot } : {})?.needsBackfill;
}

describe("data revision cache", () => {
  it("reuses a result until a write by another connection moves the data revision", () => {
    const { databasePath, first, roots } = setup();
    const second = openStore(databasePath);
    finalizeWithoutVerification(first, roots[0]!, "one");
    expect(needsBackfill(first)).toBe(1);

    finalizeWithoutVerification(second, roots[0]!, "two");
    expect(needsBackfill(first)).toBe(2);

    // A raw write fires the same revision triggers as the store's own writes.
    openRaw(databasePath).exec(`UPDATE sessions SET verification_json = '{"status":"passed"}'`);
    expect(needsBackfill(first)).toBe(0);
  });

  it("keeps each project's count to its own scope and re-checks policy on every call", () => {
    const { databasePath, first, roots, projectIds } = setup();
    finalizeWithoutVerification(first, roots[0]!, "a1");
    finalizeWithoutVerification(first, roots[0]!, "a2");
    finalizeWithoutVerification(first, roots[1]!, "b1");
    expect([needsBackfill(first), needsBackfill(first, roots[0]), needsBackfill(first, roots[1])]).toEqual([3, 2, 1]);
    expect([needsBackfill(first), needsBackfill(first, roots[0]), needsBackfill(first, roots[1])]).toEqual([3, 2, 1]);

    openStore(databasePath).updateProject(projectIds[0]!, { status: "paused" });
    expect(needsBackfill(first, roots[0])).toBeUndefined();
    expect(needsBackfill(first)).toBe(1);
  });

  it("never serves a value computed inside a transaction or after its rollback", () => {
    const { databasePath, first, roots } = setup();
    finalizeWithoutVerification(first, roots[0]!, "one");
    expect(needsBackfill(first)).toBe(1);
    const db = (first as unknown as { db: DatabaseSync }).db;

    db.exec("BEGIN IMMEDIATE");
    db.exec(`UPDATE sessions SET verification_json = '{"status":"passed"}'`);
    expect(needsBackfill(first)).toBe(0);
    db.exec("ROLLBACK");
    expect(needsBackfill(first)).toBe(1);

    // A revision seen only inside a rolled-back transaction must not become a cache key: here another connection's
    // one-row commit reaches that same revision number while the Session data is unchanged.
    db.exec("BEGIN IMMEDIATE");
    db.exec(`UPDATE sessions SET verification_json = '{"status":"passed"}'`);
    expect(needsBackfill(first)).toBe(0);
    db.exec("ROLLBACK");
    openRaw(databasePath).exec(`UPDATE projects SET updated_at = '2026-06-01T00:00:00.000Z' WHERE rowid = 1`);
    expect(needsBackfill(first)).toBe(1);
  });

  it("treats a schema change as a new database state even when no revision trigger fired", () => {
    const { databasePath, first, roots } = setup();
    finalizeWithoutVerification(first, roots[0]!, "one");
    expect(needsBackfill(first)).toBe(1);
    const raw = openRaw(databasePath);
    raw.exec("DROP TRIGGER trg_data_revision_sessions_update");
    raw.exec(`UPDATE sessions SET verification_json = '{"status":"passed"}'`);
    expect(needsBackfill(first)).toBe(0);
  });

  it("recomputes when the database id changes and keys values separately", () => {
    const db = new DatabaseSync(":memory:");
    connections.push(db);
    db.exec(`CREATE TABLE change_revisions (singleton INTEGER PRIMARY KEY, database_id TEXT, data_revision INTEGER);
      INSERT INTO change_revisions VALUES (1, 'first', 4);`);
    const cache = new DataRevisionCache<number>(db);
    let computed = 0;
    const read = (key: string) => cache.get(key, () => ++computed);
    expect([read("a"), read("a"), read("b"), read("b")]).toEqual([1, 1, 2, 2]);
    // A replaced database file gets a new id; its revision may even be the same number.
    db.exec("UPDATE change_revisions SET database_id = 'second'");
    expect([read("a"), read("a")]).toEqual([3, 3]);
    db.exec("DELETE FROM change_revisions");
    expect([read("a"), read("a")]).toEqual([4, 5]);
  });
});
