import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeQuery } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-compact-"));
  tempDirs.push(root);
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const ids = ["pruning", "grafting", "watering", "harvest"].map((topic, index) => {
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `compact-${topic}`,
      kind: index % 2 === 0 ? "procedure" : "gotcha",
      title: `Orchard ${topic} note`,
      body: `A long fictional ${topic} body. ${"Detail. ".repeat(40)}`,
      tags: ["orchard", topic],
      references: [`docs/${topic}.md`],
      appliesTo: index === 0 ? [] : Array.from({ length: index }, (_, path) => `src/${topic}/${path}.ts`),
    });
    if (result.outcome !== "knowledge_recorded") throw new Error(`Expected ${topic} to record.`);
    db.prepare("UPDATE knowledge SET updated_at = ? WHERE id = ?").run(
      `2026-10-0${index + 1}T00:00:00.000Z`,
      result.knowledge.id,
    );
    return result.knowledge.id;
  });
  return { store, root, project, db, ids };
}

function compact(store: WorkIntelligenceStore, query: KnowledgeQuery) {
  const result = store.searchKnowledgeCompactForAgent(query);
  if (result.outcome !== "knowledge") throw new Error(`Expected a Knowledge result; got ${result.outcome}.`);
  return result;
}

function full(store: WorkIntelligenceStore, query: KnowledgeQuery) {
  const result = store.searchKnowledgeForAgent(query);
  if (result.outcome !== "knowledge") throw new Error(`Expected a Knowledge result; got ${result.outcome}.`);
  return result;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("compact Knowledge search", () => {
  it("answers the same page as the full search with short items only", () => {
    const { store, root, project, ids } = setup();

    const result = compact(store, { projectRoot: root, pageSize: 10 });

    expect(result.items.map((item) => item.id)).toEqual(
      full(store, { projectRoot: root }).items.map((item) => item.id),
    );
    expect(result.items).toEqual([
      {
        id: ids[3],
        projectId: project.id,
        projectName: "Orchard",
        kind: "gotcha",
        status: "active",
        title: "Orchard harvest note",
        updatedAt: "2026-10-04T00:00:00.000Z",
        appliesToCount: 3,
      },
      expect.objectContaining({ id: ids[2], appliesToCount: 2 }),
      expect.objectContaining({ id: ids[1], appliesToCount: 1 }),
      expect.not.objectContaining({ appliesToCount: expect.anything() }),
    ]);
  });

  it("pages and filters with the same where clause, including a text query", () => {
    const { store, root, ids } = setup();

    const second = compact(store, { projectRoot: root, page: 2, pageSize: 2 });
    expect(second.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    expect(second.pageInfo).toMatchObject({ page: 2, total: 4, hasPrevious: true, hasNext: false });

    const byKind = compact(store, { projectRoot: root, kind: "procedure" });
    expect(byKind.items.map((item) => item.id)).toEqual([ids[2], ids[0]]);

    const byText = compact(store, { projectRoot: root, q: "grafting detail", pageSize: 1 });
    expect(byText).toMatchObject({ match: "strict", pageInfo: { total: 1 } });
    expect(byText.items.map((item) => item.id)).toEqual([ids[1]]);
  });

  it("flags review and tolerates a malformed appliesTo without reading the stored text", () => {
    const { store, root, db, ids } = setup();
    const [, , reviewed, malformed] = ids as [string, string, string, string];
    db.prepare("UPDATE knowledge SET review_json = ? WHERE id = ?").run(
      JSON.stringify({ reason: "contradicted", at: "2026-10-05T00:00:00.000Z" }),
      reviewed,
    );
    db.prepare("UPDATE knowledge SET applies_to_json = 'not json' WHERE id = ?").run(malformed);
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      statements.push(sql);
      return prepare(sql);
    };

    const result = compact(store, { projectRoot: root });

    expect(result.items.find((item) => item.id === reviewed)).toMatchObject({ needsReview: true, appliesToCount: 2 });
    expect(result.items.find((item) => item.id === malformed)).not.toHaveProperty("appliesToCount");
    const knowledgeReads = statements.filter((sql) => /FROM knowledge k/.test(sql) && /SELECT[\s\S]*k\.id,/.test(sql));
    expect(knowledgeReads.length).toBeGreaterThan(0);
    for (const sql of knowledgeReads) {
      expect(sql).not.toContain("k.*");
      expect(sql).not.toMatch(/k\.body|k\.tags_json|k\.references_json/);
    }
  });

  it("keeps the relaxed fallback and the policy gate of the full search", () => {
    const { store, root, project } = setup();

    const relaxed = compact(store, { projectRoot: root, q: "pruning zzyzx" });
    expect(relaxed).toMatchObject({ match: "relaxed", items: [] });
    expect(relaxed.relaxedMatches?.[0]).toMatchObject({ title: "Orchard pruning note" });

    store.updateProject(project.id, { status: "paused" });
    expect(store.searchKnowledgeCompactForAgent({ projectRoot: root })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });
});
