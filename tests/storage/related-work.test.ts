import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const resources: Array<{ store: WorkIntelligenceStore; root: string }> = [];

function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 8, 7, 12));
  const root = mkdtempSync(join(tmpdir(), "wi-attention-"));
  const projectRoot = join(root, "orchard");
  const otherRoot = join(root, "apiary");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const databasePath = join(root, "fictional.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  resources.push({ store, root });
  const project = store.addProject("Orchard", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const other = store.addProject("Apiary", otherRoot);
  store.updateProject(other.id, { status: "tracked" });
  function finalize(
    key: string,
    options: {
      root?: string;
      decisions?: number;
      openItems?: string[];
      missing?: boolean;
      files?: string[];
      contradicted?: string[];
    } = {},
  ) {
    vi.setSystemTime(Date.now() + 60_000);
    const result = store.finalizeSession({
      projectRoot: options.root ?? projectRoot,
      idempotencyKey: key,
      title: `Fictional ${key}`,
      summary: "Saved fictional work.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: Array.from({ length: options.decisions ?? 0 }, (_, i) => ({
          text: `Fictional decision ${key}-${i}`,
          origin: "agent_autonomous" as const,
        })),
        verification: [],
        nextSteps: options.openItems ?? [],
      },
      ...(!options.missing ? { changedFiles: options.files ?? [], verification: { status: "passed" as const } } : {}),
      ...(options.contradicted ? { contradictedKnowledgeIds: options.contradicted } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected fixture Session");
    return result.session;
  }
  return { store, projectRoot, otherRoot, project, other, databasePath, finalize };
}

afterEach(() => {
  vi.useRealTimers();
  for (const { store, root } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

describe("related work candidate boundaries", () => {
  it("deduplicates normalized paths, scores overlap then Jaccard, excludes cross-project and existing links", () => {
    const { store, project, otherRoot, finalize } = setup();
    const focus = finalize("focus", { files: ["src/a.ts", "src/b.ts"] });
    const small = finalize("small", { files: ["./SRC/a.ts:12", "src/b.ts", "src/b.ts"] });
    const large = finalize("large", { files: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const linked = finalize("linked", { files: ["src/a.ts", "src/b.ts"] });
    store.linkSessions({ sessionId: linked.id, relatedSessionId: focus.id, relation: "related", linked: true }, "web");
    finalize("other", { root: otherRoot, files: ["src/a.ts", "src/b.ts"] });
    const hidden = finalize("void", { files: ["src/a.ts"] });
    store.setSessionVoid({ sessionId: hidden.id, voided: true, reason: "Fixture" });
    const result = store.getRelatedWork(focus.id);
    expect(result.items.map((item) => item.id)).toEqual([small.id, large.id]);
    expect(result.items[0]).toMatchObject({ sharedCount: 2, sharedPaths: ["src/a.ts", "src/b.ts"] });
    expect(result.coverage.partial).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20_000);
    store.updateProject(project.id, { status: "paused" });
    expect(store.getRelatedWork(focus.id)).toMatchObject({
      state: "unavailable",
      reason: "source_unavailable",
      items: [],
    });
  });
  it("reports unavailable inputs and picks at most five deterministic candidates", () => {
    const { store, finalize } = setup();
    expect(store.getRelatedWork("missing").state).toBe("unavailable");
    expect(store.getRelatedWork(finalize("unknown", { missing: true }).id).reason).toBe("files_unconfirmed");
    expect(store.getRelatedWork(finalize("empty").id).reason).toBe("no_files");
    expect(
      store.getRelatedWork(finalize("wide", { files: Array.from({ length: 21 }, (_, i) => `src/${i}.ts`) }).id).reason,
    ).toBe("too_many_files");
    const focus = finalize("focus", { files: ["src/a.ts"] });
    const candidates = Array.from({ length: 8 }, (_, i) => finalize(`candidate-${i}`, { files: ["src/a.ts"] }));
    expect(store.getRelatedWork(focus.id).items.map((row) => row.id)).toEqual(
      candidates
        .reverse()
        .slice(0, 5)
        .map((row) => row.id),
    );
    store.updateSessionMetadata({ sessionId: candidates[0]!.id, changedFiles: ["src/changed.ts"] });
    expect(store.getRelatedWork(focus.id).items.map((row) => row.id)).not.toContain(candidates[0]!.id);
  });
  it("bounds hot postings and exposes partial coverage without claiming an exhaustive empty result", () => {
    const { store, finalize, databasePath } = setup();
    const focus = finalize("focus", { files: ["src/hot.ts"] });
    const db = new DatabaseSync(databasePath);
    try {
      const source = db.prepare("SELECT * FROM sessions WHERE id=?").get(focus.id)!;
      const columns = Object.keys(source);
      const insert = db.prepare(
        `INSERT INTO sessions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      db.exec("BEGIN");
      for (let i = 0; i < 1002; i++)
        insert.run(...columns.map((key) => (key === "id" || key === "idempotency_key" ? `hot-${i}` : source[key]!)));
      db.exec("COMMIT");
      const result = store.getRelatedWork(focus.id);
      expect(result.coverage).toMatchObject({ partial: true, examined: 1000 });
      expect(result.items).toHaveLength(5);
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT doc_id FROM related_work_paths WHERE project_id=? AND path=? ORDER BY doc_date DESC,doc_id LIMIT 1001",
        )
        .all(String(source.project_id), "src/hot.ts");
      expect(JSON.stringify(plan)).toContain("idx_related_work_project_path");
    } finally {
      db.close();
    }
  });
  it("keeps the derived postings out of portable data and removes them on Session/project deletion", () => {
    const { store, project, finalize, databasePath } = setup();
    const focus = finalize("focus", { files: ["src/a.ts"] });
    const other = finalize("other", { files: ["src/a.ts"] });
    expect(store.getRelatedWork(focus.id).items).toHaveLength(1);
    const exported = store.exportProjectData({ type: "project", projectId: project.id });
    expect(Object.keys(exported.tables)).not.toContain("related_work_paths");
    const db = new DatabaseSync(databasePath);
    try {
      store.setSessionVoid({ sessionId: other.id, voided: true, reason: "Fixture" });
      store.deleteSession(other.id);
      expect(db.prepare("SELECT COUNT(*) AS n FROM related_work_paths WHERE doc_id=?").get(other.id)).toEqual({ n: 0 });
      store.deleteProject(project.id, project.name);
      expect(db.prepare("SELECT COUNT(*) AS n FROM related_work_paths WHERE project_id=?").get(project.id)).toEqual({
        n: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM related_work_dirty WHERE project_id=?").get(project.id)).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });
});
