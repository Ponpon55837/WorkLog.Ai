import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput, RecallResult } from "@work-intelligence/core";
import {
  normalizePath,
  normalizeReference,
  parseQueryWords,
  pathMatchStrength,
  splitMarkdownSections,
  tokenize,
} from "./search-text.js";
import { WorkIntelligenceStore } from "./store.js";

// All projects, Sessions, Knowledge, and handoff text below are fictional fixtures.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-search-test-"));
  tempDirs.push(directory);
  return directory;
}

function trackedStore(databasePath = ":memory:"): { store: WorkIntelligenceStore; root: string; projectId: string } {
  const root = tempDir();
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, projectId: project.id };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  overrides: Partial<FinalizeSessionInput> = {},
): string {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: "Routine maintenance.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
    ...overrides,
  });
  if (result.outcome !== "finalized") {
    throw new Error(`Expected ${key} to finalize, got ${result.outcome}`);
  }
  return result.session.id;
}

function recall(store: WorkIntelligenceStore, input: Parameters<WorkIntelligenceStore["recall"]>[0]): RecallResult {
  const result = store.recall(input);
  if (result.outcome !== "recall") {
    throw new Error(`Expected recall, got ${result.outcome}`);
  }
  return result;
}

describe("search text", () => {
  it("tokenizes identifiers into parts and CJK runs into bigrams", () => {
    expect(tokenize("searchRepository")).toEqual(["searchrepository", "search", "repository"]);
    expect(tokenize("work_get_context")).toEqual(["work", "get", "context"]);
    expect(tokenize("檢索品質")).toEqual(["檢索", "索品", "品質"]);
    expect(tokenize("索引")).toEqual(["索引"]);
    expect(tokenize("HTTPServer 索引 v2")).toEqual(["httpserver", "http", "server", "索引", "v2"]);
  });

  it("drops stopwords from query words but keeps every other word", () => {
    expect(parseQueryWords("why is the 快取 失效")).toEqual([
      { word: "快取", terms: ["快取"] },
      { word: "失效", terms: ["失效"] },
    ]);
  });

  it("splits Markdown by level 1-3 headings outside code fences", () => {
    const sections = splitMarkdownSections("intro\n# One\nbody\n```\n# not a heading\n```\n#### deep\n## Two\nmore");
    expect(sections.map((section) => section.heading)).toEqual(["", "One", "Two"]);
    expect(sections[1]?.content).toContain("# not a heading");
  });

  it("normalizes paths and separates commit SHAs from Knowledge references", () => {
    const projects = [{ name: "Orchard", rootPath: "/work/orchard" }];
    expect(normalizePath("/work/orchard/src/Pear.ts", projects)).toBe("src/pear.ts");
    expect(normalizePath("Orchard/src/pear.ts:42", projects)).toBe("src/pear.ts");
    expect(normalizePath(".\\src\\pear.ts", projects)).toBe("src/pear.ts");
    expect(normalizeReference("src/pear.ts@abc1234", projects)).toEqual([
      { kind: "path", value: "src/pear.ts" },
      { kind: "commit", value: "abc1234" },
    ]);
    expect(normalizeReference("deadbeefcafe", projects)).toEqual([{ kind: "commit", value: "deadbeefcafe" }]);
    expect(pathMatchStrength("src/pear.ts", "src/pear.ts")).toBe(1);
    expect(pathMatchStrength("apps/web/src/pear.ts", "pear.ts")).toBe(0.8);
    expect(pathMatchStrength("src/fruit/pear.ts", "src/fruit")).toBe(0.6);
    expect(pathMatchStrength("src/apple.ts", "pear.ts")).toBe(0);
  });
});

describe("recall", () => {
  it("matches multi-keyword queries that the old whole-string LIKE could not", () => {
    const { store, root } = trackedStore();
    const target = finalize(store, root, "cache", {
      title: "Fix orchard cache invalidation",
      summary: "Invalidated the harvest cache when a tree is replanted.",
    });
    finalize(store, root, "other", { title: "Update harvest calendar", summary: "Shifted dates." });

    const result = recall(store, { q: "cache replanted invalidation" });
    expect(result.hits[0]).toMatchObject({ type: "session", id: target, title: "Fix orchard cache invalidation" });
    expect(result.hits[0]?.matchedIn).toContain("title");
    expect(result.termHits).toBeUndefined();
  });

  it("finds two-character and longer Chinese words and natural-language questions", () => {
    const { store, root } = trackedStore();
    const target = finalize(store, root, "zh", {
      title: "修正果園排程",
      summary: "排程在跨日時重複執行，改用鎖避免重複。",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["以資料庫鎖避免排程重複執行。"],
        verification: [],
        nextSteps: [],
      },
    });
    finalize(store, root, "zh-other", { title: "調整報表樣式", summary: "改善表格間距。" });

    expect(recall(store, { q: "排程" }).hits.map((hit) => hit.id)).toEqual([target]);
    expect(recall(store, { q: "為什麼排程會重複執行" }).hits[0]?.id).toBe(target);
  });

  it("indexes raw handoff sections and reports the matched heading", () => {
    const { store, root } = trackedStore();
    const handoffContent = [
      "# Handoff",
      "Imported notes.",
      "## Incident: pollinator queue stalled",
      "The pollinator queue stalled because the lease renewal used local time.",
      "## Unrelated",
      "Nothing to see here about trees and weather.",
    ].join("\n");
    const target = finalize(store, root, "raw", {
      title: "handoff-2026-01-01",
      summary: "Imported handoff.",
      handoffContent,
    });

    const [hit] = recall(store, { q: "pollinator lease renewal" }).hits;
    expect(hit).toMatchObject({ id: target, section: "Incident: pollinator queue stalled" });
    expect(hit?.matchedIn).toContain("raw");
    expect(hit?.excerpt).toContain("lease renewal");
    expect(hit?.excerpt.length).toBeLessThanOrEqual(222);
  });

  it("ranks Sessions and Knowledge by normalized path and damps Sessions with polluted changed files", () => {
    const { store, root } = trackedStore();
    const focused = finalize(store, root, "focused", {
      title: "Adjust pear ripeness",
      changedFiles: ["src/fruit/pear.ts"],
    });
    const polluted = finalize(store, root, "polluted", {
      title: "Read-only inventory",
      changedFiles: ["src/fruit/pear.ts", ...Array.from({ length: 79 }, (_, index) => `src/noise/file-${index}.ts`)],
    });
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "pear-gotcha",
      kind: "gotcha",
      title: "Pear ripeness uses local dates",
      body: "Compare dates in the orchard time zone.",
      references: [`${root}/src/fruit/pear.ts`, "Orchard/src/fruit/pear.ts@abc1234", "abc1234"],
    });
    if (knowledge.outcome !== "knowledge_recorded") {
      throw new Error("Expected Knowledge");
    }

    const result = recall(store, { paths: [`${root}/src/fruit/pear.ts`] });
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).toContain(knowledge.knowledge.id);
    expect(ids.indexOf(focused)).toBeLessThan(ids.indexOf(polluted));
    expect(result.hits.find((hit) => hit.id === knowledge.knowledge.id)).toMatchObject({
      type: "knowledge",
      kind: "gotcha",
      matchedPaths: ["src/fruit/pear.ts"],
    });
    expect(recall(store, { paths: ["pear.ts"] }).hits.map((hit) => hit.id)).toContain(focused);
    expect(recall(store, { paths: ["src/fruit"] }).hits.map((hit) => hit.id)).toContain(focused);
  });

  it("keeps the index in sync with edits, archiving, and project status", () => {
    const { store, root, projectId } = trackedStore();
    const sessionId = finalize(store, root, "edit", { title: "Prune branches" });
    expect(recall(store, { q: "grafting" }).hits).toHaveLength(0);

    store.updateSessionSummary({
      sessionId,
      idempotencyKey: "edit-summary",
      mode: "replace",
      summary: "Switched the grafting procedure.",
    });
    expect(recall(store, { q: "grafting" }).hits.map((hit) => hit.id)).toEqual([sessionId]);

    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "graft-pattern",
      kind: "pattern",
      title: "Grafting checklist",
      body: "Seal the cut.",
    });
    if (recorded.outcome !== "knowledge_recorded") {
      throw new Error("Expected Knowledge");
    }
    expect(recall(store, { q: "grafting" }).hits).toHaveLength(2);
    store.updateKnowledge({ projectRoot: root, knowledgeId: recorded.knowledge.id, status: "archived" });
    expect(recall(store, { q: "grafting" }).hits.map((hit) => hit.type)).toEqual(["session"]);

    store.updateProject(projectId, { status: "paused" });
    expect(recall(store, { q: "grafting" }).hits).toHaveLength(0);
    expect(store.recall({ q: "grafting", projectRoot: root })).toMatchObject({ outcome: "skipped" });
  });

  it("reports per-word hit counts when a word matches nothing", () => {
    const { store, root } = trackedStore();
    finalize(store, root, "words", { title: "Irrigation timer" });

    const result = recall(store, { q: "irrigation zzyzx" });
    expect(result.hits).toHaveLength(1);
    expect(result.termHits).toEqual([
      { term: "irrigation", count: 1 },
      { term: "zzyzx", count: 0 },
    ]);
    expect(recall(store, { q: "zzyzx" })).toMatchObject({ hits: [], termHits: [{ term: "zzyzx", count: 0 }] });
  });

  it("backfills the index for data written before the search migration", () => {
    const databasePath = join(tempDir(), "legacy.sqlite");
    const { store, root } = trackedStore(databasePath);
    const sessionId = finalize(store, root, "legacy", { title: "Legacy compost notes" });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TABLE search_chunks; DROP TABLE search_fts; DROP TABLE search_paths; DROP TABLE search_dirty;
      DELETE FROM schema_migrations WHERE version = 1;
    `);
    for (const { name } of database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_%'")
      .all() as Array<{ name: string }>) {
      database.exec(`DROP TRIGGER ${name}`);
    }
    database.close();

    const reopened = new WorkIntelligenceStore(databasePath);
    stores.push(reopened);
    expect(recall(reopened, { q: "compost" }).hits.map((hit) => hit.id)).toEqual([sessionId]);
  });
});

describe("context focus and search", () => {
  it("returns relevant Knowledge, decisions, and Sessions for a task and paths", () => {
    const { store, root } = trackedStore();
    const sessionId = finalize(store, root, "focus", {
      title: "Rework irrigation scheduler",
      summary: "Moved the irrigation scheduler to a queue.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["Use a durable queue for irrigation jobs."],
        verification: [],
        nextSteps: ["Retry policy for failed valves is not implemented."],
      },
      changedFiles: ["src/irrigation/scheduler.ts"],
    });
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "valve-gotcha",
      kind: "gotcha",
      title: "Irrigation valves report late",
      body: "Valve status arrives up to a minute late.",
    });

    const context = store.getContext(root, { task: "irrigation retry", paths: ["src/irrigation/scheduler.ts"] });
    if (context.outcome !== "context") {
      throw new Error("Expected context");
    }
    expect(context.relevant).toMatchObject({
      task: "irrigation retry",
      paths: ["src/irrigation/scheduler.ts"],
      knowledge: [expect.objectContaining({ title: "Irrigation valves report late" })],
      decisions: [expect.objectContaining({ sessionId, text: "Use a durable queue for irrigation jobs." })],
      sessions: [
        expect.objectContaining({ id: sessionId, openItems: ["Retry policy for failed valves is not implemented."] }),
      ],
    });

    const plain = store.getContext(root);
    expect(plain).not.toHaveProperty("relevant");
  });

  it("work_search ranks Sessions with the recall engine and returns digests", () => {
    const { store, root } = trackedStore();
    const sessionId = finalize(store, root, "search", {
      title: "Orchard map export",
      summary: "Exported the orchard map as SVG.",
      changedFiles: ["src/map/export.ts"],
    });
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "map-knowledge",
      kind: "pattern",
      title: "Orchard map export pattern",
      body: "Knowledge is not part of Session search.",
    });

    const results = store.search("map svg", root);
    if (!Array.isArray(results)) {
      throw new Error("Expected results");
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ session: { id: sessionId, changedFilesCount: 1 }, matchedIn: "summary" });
  });
});
