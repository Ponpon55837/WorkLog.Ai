import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const SHARED_SHA = "feed5eed".padEnd(40, "1");
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = (name: string) => {
    const root = mkdtempSync(join(tmpdir(), `work-intelligence-commit-${name}-`));
    tempDirs.push(root);
    const record = store.addProject(name, root);
    store.updateProject(record.id, { status: "tracked" });
    return { root, id: record.id };
  };
  const finalize = (root: string, key: string, commitSha?: string) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: key,
      summary: `${key} summary.`,
      changedFiles: [],
      verification: { status: "passed" },
      ...(commitSha ? { git: { branch: "main", commitSha } } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, project, finalize };
}

function titles(result: ReturnType<WorkIntelligenceStore["listSessionsForAgent"]>): string[] {
  if (result.outcome !== "sessions") throw new Error(`Expected sessions, got ${result.outcome}`);
  return result.items.map((session) => session.title).sort();
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session list commitSha filter", () => {
  it("matches the full sha or a prefix and keeps every Session of that commit", () => {
    const { store, project, finalize } = setup();
    const meadow = project("meadow");
    finalize(meadow.root, "first", SHARED_SHA);
    finalize(meadow.root, "second", SHARED_SHA);
    finalize(meadow.root, "unrelated", "0".repeat(40));
    finalize(meadow.root, "no-commit");

    expect(titles(store.listSessionsForAgent({ projectRoot: meadow.root, commitSha: SHARED_SHA }))).toEqual([
      "first",
      "second",
    ]);
    expect(titles(store.listSessionsForAgent({ projectId: meadow.id, commitSha: "FEED5EE" }))).toEqual([
      "first",
      "second",
    ]);
    // Without the filter the list is unchanged.
    expect(titles(store.listSessionsForAgent({ projectRoot: meadow.root }))).toHaveLength(4);
  });

  it("decides ambiguity and matches only inside the scoped, tracked projects", () => {
    const { store, project, finalize } = setup();
    const meadow = project("meadow");
    const orchard = project("orchard");
    const attic = project("attic");
    finalize(meadow.root, "meadow-work", SHARED_SHA);
    finalize(orchard.root, "orchard-work", SHARED_SHA.slice(0, 8) + "2".repeat(32));
    finalize(attic.root, "attic-work", SHARED_SHA);
    store.updateProject(attic.id, { status: "paused" });

    // The other project's commit with the same prefix neither appears nor makes the scoped prefix ambiguous.
    expect(titles(store.listSessionsForAgent({ projectRoot: meadow.root, commitSha: "feed5eed" }))).toEqual([
      "meadow-work",
    ]);
    expect(store.listSessionsForAgent({ commitSha: "feed5eed" })).toMatchObject({
      outcome: "ambiguous_commit_sha",
      commitSha: "feed5eed",
    });
    // A paused project's Session is never listed, even for its exact commit.
    expect(titles(store.listSessionsForAgent({ commitSha: SHARED_SHA }))).toEqual(["meadow-work"]);
    expect(store.listSessionsForAgent({ projectId: attic.id, commitSha: SHARED_SHA })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("seeks the commit index instead of scanning Sessions", () => {
    const { store, project, finalize } = setup();
    const meadow = project("meadow");
    for (let index = 0; index < 30; index += 1) finalize(meadow.root, `filler-${index}`, `${index}`.padStart(40, "9"));
    const db = (store as unknown as { db: DatabaseSync }).db;
    const plans: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("commit_sha >=")) {
        plans.push(
          (prepare(`EXPLAIN QUERY PLAN ${sql}`).all("abc1234", "abc1235", meadow.id) as Array<{ detail: string }>)
            .map((row) => row.detail)
            .join(" | "),
        );
      }
      return prepare(sql);
    }) as typeof db.prepare;
    store.listSessionsForAgent({ projectId: meadow.id, commitSha: "abc1234" });
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan).toContain("USING COVERING INDEX idx_sessions_commit_sha");
  });
});
