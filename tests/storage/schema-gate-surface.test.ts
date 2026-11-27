import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { isDatabaseSchemaChangedError } from "../../packages/storage/src/schema-write-gate.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const connections: DatabaseSync[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-gate-surface-"));
  tempDirs.push(directory);
  const databasePath = join(directory, "shared.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const other = new DatabaseSync(databasePath);
  connections.push(other);
  const root = join(directory, "orchard");
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, title: string) =>
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title,
      summary: `${title} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const changes = (): number => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const scalar = (sql: string): unknown => Object.values(db.prepare(sql).get() as object)[0];
  return { store, other, root, finalize, changes, scalar };
}

function migrateFromAnotherProcess(other: DatabaseSync): void {
  other.exec("BEGIN IMMEDIATE");
  other.exec("CREATE TABLE future_feature (id TEXT PRIMARY KEY)");
  other
    .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(LATEST_SCHEMA_VERSION + 1, "future_feature", "2030-01-01T00:00:00.000Z");
  other.exec("COMMIT");
}

function failureOf(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("schema write gate across the public API", () => {
  it("serves reads from the existing index and writes nothing, while every write is refused", () => {
    const { store, other, root, finalize, changes, scalar } = setup();
    finalize("first", "Pruned the apple trees");
    expect(store.search("apple", root)).toHaveLength(1);
    finalize("second", "Pruned the pear trees");
    const request = store.requestKnowledgeCandidates(root);
    if (request.outcome !== "knowledge_candidate_request") throw new Error("Expected a candidate request");
    store.getKnowledgeCandidateContext({ requestId: request.request.id });
    // The request has been processing for far longer than the 30 minute timeout the lazy recovery applies.
    other.prepare("UPDATE knowledge_candidate_requests SET started_at = '2020-01-01T00:00:00.000Z'").run();
    expect(scalar("SELECT COUNT(*) FROM search_dirty")).toBeGreaterThan(0);
    migrateFromAnotherProcess(other);
    const before = changes();
    const dirtyBefore = scalar("SELECT COUNT(*) FROM search_dirty");

    expect(store.search("apple", root)).toHaveLength(1);
    expect(store.searchForAgent("apple", root)).toMatchObject({ outcome: "search" });
    expect(store.recall({ q: "apple", projectRoot: root })).toMatchObject({ outcome: "recall" });
    expect(store.getContext(root).outcome).toBe("context");
    expect(store.listKnowledgeCandidates({ projectRoot: root }).outcome).toBe("knowledge_candidates");
    expect(store.listProjects()).toHaveLength(1);

    expect(scalar("SELECT status FROM knowledge_candidate_requests")).toBe("processing");
    expect(scalar("SELECT COUNT(*) FROM search_dirty")).toBe(dirtyBefore);
    expect(changes()).toBe(before);

    const writes: Array<() => unknown> = [
      () => finalize("third", "Pruned the plum trees"),
      () => store.recordKnowledge({ projectRoot: root, idempotencyKey: "k", kind: "gotcha", title: "T", body: "B" }),
      () => store.getKnowledgeCandidateContext({ requestId: request.request.id }),
      () => store.requestKnowledgeCandidates(root),
      () => store.decideKnowledgeCandidate({ candidateId: "missing-candidate", decision: "reject" }),
    ];
    for (const write of writes) {
      const failure = failureOf(write);
      if (failure !== undefined) expect(isDatabaseSchemaChangedError(failure)).toBe(true);
    }
    expect(changes()).toBe(before);
  });
});
