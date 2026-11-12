import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentKnowledgeQueryResult, KnowledgeKind, KnowledgeQuery } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

interface KnowledgeFixture {
  title: string;
  body?: string;
  kind?: KnowledgeKind;
  tags?: string[];
  appliesTo?: string[];
  archived?: boolean;
}

function trackedProject(store: WorkIntelligenceStore, name: string): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-fallback-"));
  tempDirs.push(root);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return root;
}

function setup() {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const root = trackedProject(store, "Orchard");
  return { store, root };
}

function record(store: WorkIntelligenceStore, root: string, key: string, fixture: KnowledgeFixture): string {
  const result = store.recordKnowledge({
    projectRoot: root,
    idempotencyKey: key,
    kind: fixture.kind ?? "gotcha",
    title: fixture.title,
    body: fixture.body ?? "A fictional orchard note.",
    tags: fixture.tags ?? [],
    appliesTo: fixture.appliesTo ?? [],
  });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Expected ${key} to record; got ${result.outcome}.`);
  if (fixture.archived) {
    const archived = store.updateKnowledge({ projectRoot: root, knowledgeId: result.knowledge.id, status: "archived" });
    if (archived.outcome !== "knowledge_updated")
      throw new Error(`Expected ${key} to archive; got ${archived.outcome}.`);
  }
  return result.knowledge.id;
}

function search(store: WorkIntelligenceStore, query: KnowledgeQuery): AgentKnowledgeQueryResult {
  const result = store.searchKnowledgeForAgent(query);
  if (result.outcome !== "knowledge") throw new Error(`Expected a Knowledge result; got ${result.outcome}.`);
  return result;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Knowledge search fallback", () => {
  it("answers with the strict list result whenever it finds anything", () => {
    const { store, root } = setup();
    const graft = record(store, root, "k1", { title: "Graft apple scions in early spring" });
    record(store, root, "k2", { title: "Prune pear trees after harvest" });

    const result = search(store, { projectRoot: root, q: "graft spring" });
    const list = store.searchKnowledge({ projectRoot: root, q: "graft spring" });
    if (list.outcome !== "knowledge") throw new Error("Expected the list search to answer.");
    expect(result).toMatchObject({ match: "strict", pageInfo: { total: 1 } });
    expect(result.items).toEqual(list.items);
    expect(result.items.map((item) => item.id)).toEqual([graft]);
    expect(result).not.toHaveProperty("relaxedMatches");
    expect(result).not.toHaveProperty("otherStatusMatches");
    // The Web list keeps its own shape.
    expect(list).not.toHaveProperty("match");
  });

  it("falls back to ranked partial matches that name the terms they share", () => {
    const { store, root } = setup();
    const graft = record(store, root, "k1", {
      title: "Graft apple scions in early spring",
      body: "Seal the graftUnion with wax.",
    });
    const prune = record(store, root, "k2", { title: "Prune apple trees after harvest" });
    record(store, root, "k3", { title: "Store pears in a cool cellar" });

    const result = search(store, { projectRoot: root, q: "apple graft union frostbite" });
    expect(result).toMatchObject({ match: "relaxed", items: [], pageInfo: { total: 0 } });
    expect(result.relaxedMatches?.map((match) => match.id)).toEqual([graft, prune]);
    // Identifier parts count as terms: graftUnion contains both graft and union.
    expect(result.relaxedMatches?.[0]?.matchedTerms).toEqual(["apple", "graft", "union"]);
    expect(result.relaxedMatches?.[1]?.matchedTerms).toEqual(["apple"]);
    // Each match is a digest; the full record is one work_get_knowledge_history read away.
    expect(result.relaxedMatches?.[0]).toEqual({
      id: graft,
      projectId: expect.any(String),
      projectName: "Orchard",
      kind: "gotcha",
      status: "active",
      title: "Graft apple scions in early spring",
      matchedTerms: ["apple", "graft", "union"],
      excerpt: "Seal the graftUnion with wax.",
    });
    expect(result.hint).toContain("work_get_knowledge_history");
  });

  it("bounds a digest's excerpt around the matched terms and its appliesTo list", () => {
    const { store, root } = setup();
    const filler = "Fictional orchard filler sentence. ".repeat(30);
    record(store, root, "k1", {
      title: "Cellar notes",
      body: `${filler}Keep the cider barrels below twelve degrees. ${filler}`,
      appliesTo: ["src/cellar/a.ts", "src/cellar/b.ts", "src/cellar/c.ts", "src/cellar/d.ts", "src/cellar/e.ts"],
    });

    const [match] = search(store, { projectRoot: root, q: "cider barrels zzyzx" }).relaxedMatches ?? [];
    expect(match).toMatchObject({
      excerptTruncated: true,
      appliesTo: ["src/cellar/a.ts", "src/cellar/b.ts", "src/cellar/c.ts"],
      appliesToOmittedCount: 2,
    });
    expect(match?.excerpt).toContain("cider barrels");
    // 400 characters plus the leading and trailing cut marks.
    expect(match?.excerpt.length).toBeLessThanOrEqual(402);
    expect(match).not.toHaveProperty("body");
  });

  it("finds a Chinese paraphrase through shared character pairs", () => {
    const { store, root } = setup();
    const marker = record(store, root, "k1", {
      title: "建置失敗時只移除自己寫入的建置標記",
      body: "清理前先確認標記內容。",
    });
    record(store, root, "k2", { title: "果園灌溉排程" });

    const result = search(store, { projectRoot: root, q: "建置標記殘留清理" });
    expect(result.match).toBe("relaxed");
    expect(result.relaxedMatches?.map((match) => match.id)).toEqual([marker]);
    expect(result.relaxedMatches?.[0]?.matchedTerms).toEqual(expect.arrayContaining(["建置", "標記", "清理"]));
  });

  it("matches a file path against appliesTo globs and directories", () => {
    const { store, root } = setup();
    const ledger = record(store, root, "k1", { title: "Harvest ledger rounding", appliesTo: ["src/harvest/**"] });
    const crates = record(store, root, "k2", { title: "Crate labels", appliesTo: ["src/crates"] });
    record(store, root, "k3", { title: "Unrelated irrigation note", appliesTo: ["src/irrigation/*.ts"] });

    const byGlob = search(store, { projectRoot: root, q: `${root}/src/harvest/ledger.ts` });
    expect(byGlob.match).toBe("relaxed");
    expect(byGlob.relaxedMatches?.map((match) => match.id)).toEqual([ledger]);
    expect(byGlob.relaxedMatches?.[0]?.matchedPaths).toEqual(["src/harvest/**"]);

    const byDirectory = search(store, { projectRoot: root, q: "src/crates/label.ts" });
    expect(byDirectory.relaxedMatches?.[0]).toMatchObject({ id: crates, matchedPaths: ["src/crates"] });
  });

  it("counts matches the status filter hid without returning them", () => {
    const { store, root } = setup();
    record(store, root, "k1", { title: "Thin peach blossoms by hand", archived: true });
    record(store, root, "k2", { title: "Peach blossom thinning schedule", archived: true });
    record(store, root, "k3", { title: "Mulch around young trees" });

    const result = search(store, { projectRoot: root, q: "peach blossoms thinning" });
    expect(result).toMatchObject({ match: "none", items: [], otherStatusMatches: { archived: 2 } });
    expect(result).not.toHaveProperty("relaxedMatches");
    expect(result.hint).toContain('pass status "archived"');
    expect(JSON.stringify(result)).not.toContain("Thin peach");

    // Passing the named status answers with the records the count announced.
    const archived = search(store, { projectRoot: root, q: "peach blossoms thinning", status: "archived" });
    expect(archived.match).toBe("relaxed");
    expect(archived.relaxedMatches).toHaveLength(2);
  });

  it("counts strict matches in other statuses when they exist", () => {
    const { store, root } = setup();
    record(store, root, "k1", { title: "Cider press cleaning", archived: true });

    const result = search(store, { projectRoot: root, q: "cider press" });
    expect(result).toMatchObject({ match: "none", otherStatusMatches: { archived: 1 } });
    expect(search(store, { projectRoot: root, q: "cider press", status: "archived" }).match).toBe("strict");
  });

  it("keeps the kind filter in the fallback", () => {
    const { store, root } = setup();
    record(store, root, "k1", { title: "Apple storage humidity", kind: "decision" });
    const pattern = record(store, root, "k2", { title: "Apple storage crates", kind: "pattern" });

    const result = search(store, { projectRoot: root, q: "apple storage zzyzx", kind: "pattern" });
    expect(result.relaxedMatches?.map((match) => match.id)).toEqual([pattern]);
  });

  it("never reveals another project's Knowledge in partial matches or counts", () => {
    const { store, root } = setup();
    const otherRoot = trackedProject(store, "Vineyard");
    const pausedRoot = trackedProject(store, "Paused Grove");
    record(store, root, "k1", { title: "Mulch around young trees" });
    record(store, otherRoot, "k2", { title: "Trellis wire tension" });
    record(store, otherRoot, "k3", { title: "Trellis post spacing", archived: true });
    record(store, pausedRoot, "k4", { title: "Trellis anchors" });
    const paused = store.listProjects().find((project) => project.name === "Paused Grove")!;
    store.updateProject(paused.id, { status: "paused" });

    const scoped = search(store, { projectRoot: root, q: "trellis tension zzyzx" });
    expect(scoped).toMatchObject({ match: "none", items: [] });
    expect(scoped).not.toHaveProperty("relaxedMatches");
    expect(scoped).not.toHaveProperty("otherStatusMatches");

    // Unscoped, only tracked projects count; the paused project's Knowledge stays out of both lists and counts.
    const unscoped = search(store, { q: "trellis tension zzyzx" });
    expect(unscoped.relaxedMatches?.map((match) => match.title)).toEqual(["Trellis wire tension"]);
    expect(unscoped.otherStatusMatches).toEqual({ archived: 1 });
  });

  it("skips a non-tracked scope before searching", () => {
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    expect(store.searchKnowledgeForAgent({ projectRoot: "/nowhere/orchard", q: "apple" })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("adds nothing to a listing without a query", () => {
    const { store, root } = setup();
    record(store, root, "k1", { title: "Cider press cleaning", archived: true });
    const result = search(store, { projectRoot: root });
    expect(result).toMatchObject({ items: [], pageInfo: { total: 0 } });
    expect(result).not.toHaveProperty("match");
    expect(result).not.toHaveProperty("otherStatusMatches");
  });
});
