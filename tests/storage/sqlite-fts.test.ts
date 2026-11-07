import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runFtsWrite } from "../../packages/storage/src/sqlite-fts.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// All projects, Sessions, and index tokens below are fictional fixtures.
const MAX_SAFE_ROWID = "9007199254740991";
const FILLER_ROWS = 20_000;
const FILLER_ROWID_START = 1_000_000;
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-fts-test-"));
  tempDirs.push(directory);
  return directory;
}

/** Fills the FTS index so later deletes land in a merged segment and write tombstone pages. */
function fillFts(db: DatabaseSync, table: string, start: number): void {
  const insert = db.prepare(`INSERT INTO ${table} (rowid, tokens) VALUES (?, ?)`);
  db.exec("BEGIN");
  for (let index = 0; index < FILLER_ROWS; index += 1) {
    insert.run(start + index, `orchard pear w${index} w${index % 97} w${index % 13}`);
  }
  db.exec("COMMIT");
}

function tombstoneCount(db: DatabaseSync, table: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}_data WHERE rowid > CAST(? AS INTEGER)`)
    .get(MAX_SAFE_ROWID) as { count: number };
  return row.count;
}

describe("FTS5 tombstone rowids", () => {
  it("re-indexes every document when many already-indexed documents are dirty at once", () => {
    const root = tempDir();
    const databasePath = join(tempDir(), "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    try {
      const project = store.addProject("Orchard", root);
      store.updateProject(project.id, { status: "tracked" });
      const sessionIds: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const finalized = store.finalizeSession({
          projectRoot: root,
          idempotencyKey: `bulk-${index}`,
          title: `Prune row ${index}`,
          summary: `Grafted pear tree ${index}.`,
          workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
          changedFiles: [],
          verification: { status: "passed" },
        });
        if (finalized.outcome !== "finalized") throw new Error("Expected a finalized Session");
        sessionIds.push(finalized.session.id);
      }
      expect(store.recall({ q: "grafted", projectRoot: root, limit: 30 })).toMatchObject({ outcome: "recall" });

      // A migration or redaction marks every indexed document dirty; the next sync rebuilds them all at once.
      const raw = new DatabaseSync(databasePath);
      raw.exec("UPDATE sessions SET summary = replace(summary, 'Grafted', 'Budded')");
      raw.exec("INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions");
      raw.close();

      const budded = store.recall({ q: "budded", projectRoot: root, limit: 30 });
      const grafted = store.recall({ q: "grafted", projectRoot: root, limit: 30 });
      expect(budded.outcome === "recall" ? budded.hits.map((hit) => hit.id).sort() : []).toEqual(
        [...sessionIds].sort(),
      );
      expect(grafted.outcome === "recall" ? grafted.hits : ["not recall"]).toEqual([]);
      const check = new DatabaseSync(databasePath, { readOnly: true });
      expect(check.prepare("SELECT COUNT(*) AS count FROM search_dirty").get()).toEqual({ count: 0 });
      check.close();
    } finally {
      store.close();
    }
  });

  it("deletes from a contentless_delete index without exposing the shadow rowid", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts USING fts5(tokens, content = '', contentless_delete = 1)");
    db.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY)");
    fillFts(db, "fts", 1);

    const remove = db.prepare("DELETE FROM fts WHERE rowid = ?");
    for (const rowid of [7, 9_000, 15_000]) {
      runFtsWrite(remove, rowid);
    }

    expect(tombstoneCount(db, "fts")).toBeGreaterThan(0);
    expect(db.prepare("DELETE FROM plain WHERE id = 1").run().changes).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM fts WHERE fts MATCH 'pear'").get()).toEqual({
      count: FILLER_ROWS - 3,
    });
    db.close();
  });

  it("keeps recall and reports working after a Session reindex writes tombstone pages", () => {
    const root = tempDir();
    const databasePath = join(tempDir(), "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    try {
      const project = store.addProject("Orchard", root);
      store.updateProject(project.id, { status: "tracked" });
      const finalized = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: "fts-tombstone",
        title: "Prune branches",
        summary: "Routine maintenance.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (finalized.outcome !== "finalized") {
        throw new Error("Expected a finalized Session");
      }
      expect(store.recall({ q: "prune", projectRoot: root })).toMatchObject({ outcome: "recall" });

      const raw = new DatabaseSync(databasePath);
      fillFts(raw, "search_fts", FILLER_ROWID_START);
      raw.close();

      store.updateSessionSummary({
        sessionId: finalized.session.id,
        idempotencyKey: "fts-tombstone-summary",
        mode: "replace",
        summary: "Switched the grafting procedure.",
      });
      const recall = store.recall({ q: "grafting", projectRoot: root });
      expect(recall.outcome === "recall" ? recall.hits.map((hit) => hit.id) : []).toEqual([finalized.session.id]);
      expect(() => store.getReport({ period: "week", date: "2026-11-07" })).not.toThrow();

      const check = new DatabaseSync(databasePath, { readOnly: true });
      expect(tombstoneCount(check, "search_fts")).toBeGreaterThan(0);
      check.close();
    } finally {
      store.close();
    }
  });
});
