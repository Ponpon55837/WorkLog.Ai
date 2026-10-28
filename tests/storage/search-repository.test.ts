import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput, RecallResult } from "../../packages/core/src/index.js";
import {
  normalizePath,
  normalizeReference,
  parseQueryWords,
  pathMatchStrength,
  splitMarkdownSections,
  tokenize,
} from "../../packages/storage/src/search-text.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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

  it("hashes normalized raw sections and gives only their earliest Session full weight", () => {
    const databasePath = join(tempDir(), "raw-content-hash.sqlite");
    const { store, root } = trackedStore(databasePath);
    const first = finalize(store, root, "raw-plan-first", {
      title: "Imported handoff archive A",
      summary: "Imported planning notes.",
      handoffContent: "# Handoff\n## Archive\nThe fictional heliotrope siphon calibration remains on the future plan.",
      completedAt: "2026-09-01T00:00:00.000Z",
    });
    const second = finalize(store, root, "raw-plan-second", {
      title: "Imported handoff archive B",
      summary: "Imported planning notes.",
      handoffContent:
        "# Handoff\n## Archive\nThe fictional heliotrope   siphon calibration remains on the future plan.",
      completedAt: "2026-09-02T00:00:00.000Z",
    });

    const result = recall(store, { q: "heliotrope siphon calibration", projectRoot: root });
    const firstHit = result.hits.find((hit) => hit.id === first);
    const secondHit = result.hits.find((hit) => hit.id === second);
    expect(firstHit).toBeDefined();
    expect(secondHit).toBeDefined();
    expect(firstHit?.score).toBeGreaterThan((secondHit?.score ?? 0) * 5);

    const database = new DatabaseSync(databasePath);
    try {
      const hashes = database
        .prepare(
          "SELECT doc_id, content_hash FROM search_chunks WHERE field = 'raw' AND heading = 'Archive' AND doc_id IN (?, ?)",
        )
        .all(first, second) as Array<{ doc_id: string; content_hash: string | null }>;
      expect(hashes).toHaveLength(2);
      expect(hashes[0]?.content_hash).toBeTruthy();
      expect(hashes[0]?.content_hash).toBe(hashes[1]?.content_hash);
    } finally {
      database.close();
    }
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

  function seedUnlinkedGuidelines() {
    const { store, root } = trackedStore();
    for (let index = 0; index < 10; index += 1) {
      finalize(store, root, `cache-filler-${index}`, {
        title: `Compost turning ${index}`,
        summary: "Turned the compost.",
      });
    }
    const oldGuideline = finalize(store, root, "cache-old-guideline", {
      title: "Orchard cache fixed timeout guideline",
      summary: "The orchard cache must always use a fixed timeout; do not expire entries by events.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["Always require a fixed timeout for orchard cache entries."],
        verification: [],
        nextSteps: [],
      },
      completedAt: "2026-01-05T08:00:00.000Z",
    });
    const revisedGuideline = finalize(store, root, "cache-revised-guideline", {
      title: "Revised orchard cache fixed timeout guideline",
      summary: "The fixed timeout guideline was replaced with event-based expiration.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["Replace the timeout guideline with expiration on cache invalidation."],
        verification: [],
        nextSteps: [],
      },
      completedAt: "2026-01-19T08:00:00.000Z",
    });
    // The sessions have no parentSessionId or relatedSessionIds.
    const ids = recall(store, { q: "orchard cache fixed timeout guideline" }).hits.map((hit) => hit.id);
    return { ids, oldGuideline, revisedGuideline };
  }

  it("returns both unlinked guideline Sessions, with the newer correction ranked below the older one", () => {
    const { ids, oldGuideline, revisedGuideline } = seedUnlinkedGuidelines();

    expect(ids).toContain(oldGuideline);
    expect(ids).toContain(revisedGuideline);
    expect(ids.indexOf(revisedGuideline)).toBeGreaterThan(ids.indexOf(oldGuideline));
  });

  // Only the ordering is expected to fail, so a missing hit cannot make this known limitation pass.
  it.fails("KNOWN LIMITATION: a later unlinked Session does not supersede a close lexical match", () => {
    const { ids, oldGuideline, revisedGuideline } = seedUnlinkedGuidelines();

    expect(ids.indexOf(revisedGuideline)).toBeLessThan(ids.indexOf(oldGuideline));
  });

  it("can trace the four candidate supersession clues through existing synthetic records", () => {
    const { store, root } = trackedStore();
    const earlier = finalize(store, root, "signal-earlier", {
      title: "Orchard cache timeout guideline",
    });
    const contradictedKnowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "signal-contradicted-knowledge",
      kind: "pattern",
      title: "Synthetic fixed timeout rule",
      body: "Keep the synthetic orchard cache timeout fixed.",
      sessionId: earlier,
    });
    const supersededKnowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "signal-superseded-knowledge",
      kind: "pattern",
      title: "Synthetic expiry rule",
      body: "Keep the synthetic orchard cache timeout fixed.",
      sessionId: earlier,
    });
    if (contradictedKnowledge.outcome !== "knowledge_recorded") throw new Error("Expected synthetic Knowledge");
    if (supersededKnowledge.outcome !== "knowledge_recorded") throw new Error("Expected synthetic Knowledge");

    const middle = finalize(store, root, "signal-middle", {
      title: "Orchard cache timeout guideline review",
      parentSessionId: earlier,
    });
    const later = finalize(store, root, "signal-later", {
      title: "Revised orchard cache timeout guideline",
      summary: "Replace fixed timeouts with invalidation-driven expiration.",
      parentSessionId: middle,
      contradictedKnowledgeIds: [contradictedKnowledge.knowledge.id],
    });
    const replacement = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "signal-replacement-knowledge",
      kind: "pattern",
      title: "Synthetic event expiry rule",
      body: "Expire the synthetic orchard cache when invalidation arrives.",
      sessionId: later,
      supersedesId: supersededKnowledge.knowledge.id,
    });
    if (replacement.outcome !== "knowledge_recorded") throw new Error("Expected replacement Knowledge");

    const contradictionHistory = store.getKnowledgeHistory({
      projectRoot: root,
      knowledgeId: contradictedKnowledge.knowledge.id,
    });
    const replacementHistory = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: replacement.knowledge.id });
    expect(contradictionHistory.outcome === "knowledge_history" && contradictionHistory.feedback).toContainEqual(
      expect.objectContaining({ kind: "contradicted", sessionId: later }),
    );
    expect(
      contradictionHistory.outcome === "knowledge_history" && contradictionHistory.history[0]?.after,
    ).toMatchObject({ sessionId: earlier, review: { sessionId: later, reason: "contradicted" } });
    expect(replacementHistory.outcome === "knowledge_history" && replacementHistory.history[0]?.after).toMatchObject({
      sessionId: later,
      supersedesId: supersededKnowledge.knowledge.id,
    });

    const database = (store as unknown as { db: DatabaseSync }).db;
    expect(
      database
        .prepare(
          `SELECT 1 FROM session_links
           WHERE relation = 'continues' AND session_id = ? AND related_session_id = ?`,
        )
        .get(later, earlier),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          `WITH RECURSIVE continuation_paths(later, earlier) AS (
             SELECT session_id, related_session_id FROM session_links WHERE relation = 'continues'
             UNION
             SELECT paths.later, links.related_session_id
             FROM continuation_paths paths
             JOIN session_links links ON links.session_id = paths.earlier AND links.relation = 'continues'
           )
           SELECT 1 FROM continuation_paths WHERE later = ? AND earlier = ?`,
        )
        .get(later, earlier),
    ).toEqual({ 1: 1 });

    const rankedIds = recall(store, { q: "orchard cache timeout guideline" }).hits.map((hit) => hit.id);
    expect(rankedIds.indexOf(later)).toBeLessThan(rankedIds.indexOf(earlier));
  });

  it("puts a Session that continues an earlier hit directly above it when it scores close enough", () => {
    const { store, root } = trackedStore();
    // Unrelated history gives the query words a meaningful document frequency.
    for (let index = 0; index < 10; index += 1) {
      finalize(store, root, `vent-filler-${index}`, {
        title: `Compost turning ${index}`,
        summary: "Turned the compost.",
      });
    }
    const plan = finalize(store, root, "vent-plan", {
      title: "Greenhouse vent motor calibration plan",
      summary: "Plan to calibrate the greenhouse vent motor before winter.",
      completedAt: "2026-01-05T08:00:00.000Z",
    });
    const done = finalize(store, root, "vent-done", {
      title: "Vent motor calibration verified",
      summary: "The calibration held after a strong wind test.",
      parentSessionId: plan,
      completedAt: "2026-01-12T08:00:00.000Z",
    });
    const weak = finalize(store, root, "vent-weak", {
      title: "Door hinge oiled",
      summary: "Oiled the greenhouse door hinge.",
      parentSessionId: plan,
      completedAt: "2026-01-13T08:00:00.000Z",
    });
    const unlinked = finalize(store, root, "vent-unlinked", {
      title: "Vent motor calibration notes",
      summary: "Notes about vent motor calibration for another greenhouse.",
      completedAt: "2026-01-14T08:00:00.000Z",
    });

    const ids = recall(store, { q: "greenhouse vent motor calibration" }).hits.map((hit) => hit.id);
    expect(ids.indexOf(done)).toBe(ids.indexOf(plan) - 1);
    // A continuation that barely matches keeps its own place below the earlier Session.
    expect(ids.indexOf(weak)).toBeGreaterThan(ids.indexOf(plan));
    expect(ids).toContain(unlinked);
  });

  it("ranks a record that answers in structured fields above a long handoff that only mentions the words in raw text", () => {
    const { store, root } = trackedStore();
    // Unrelated history gives the query words a meaningful document frequency.
    for (let index = 0; index < 10; index += 1) {
      finalize(store, root, `raw-filler-${index}`, {
        title: `Compost turning ${index}`,
        summary: "Turned the compost.",
      });
    }
    const answer = finalize(store, root, "raw-answer", {
      title: "Sprinkler valve schedule",
      summary: "The sprinkler valve schedule now opens before sunrise.",
      completedAt: "2026-02-01T08:00:00.000Z",
    });
    // Two query words in the title, the other two only in raw text: full coverage before raw-only words counted half.
    const handoff = finalize(store, root, "raw-handoff", {
      title: "Orchard sprinkler notes",
      summary: "Imported historical handoff notes.",
      handoffContent: "# Notes\n## Season\nThe crew asked about the valve and its schedule during the walk.",
      completedAt: "2026-02-01T08:00:00.000Z",
    });

    const ids = recall(store, { q: "orchard sprinkler valve schedule" }).hits.map((hit) => hit.id);
    expect(ids.indexOf(answer)).toBeLessThan(ids.indexOf(handoff));
    // The raw-only record is ranked lower but still returned.
    expect(ids).toContain(handoff);
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
      DELETE FROM schema_migrations WHERE version IN (1, 20);
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

describe("recall by date range", () => {
  it("filters Sessions by completion and Knowledge by last update in SQL, for recall and search", () => {
    const { store, root } = trackedStore();
    const june = finalize(store, root, "june", {
      title: "Irrigation valve repair",
      completedAt: "2031-06-15T10:00:00.000Z",
    });
    const july = finalize(store, root, "july", {
      title: "Irrigation valve repair follow-up",
      completedAt: "2031-07-02T10:00:00.000Z",
    });
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "valve-knowledge",
      kind: "gotcha",
      title: "Irrigation valve washers",
      body: "Replace the washer before tightening the valve.",
    });
    if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected knowledge");

    const ids = (range: { from?: string; to?: string }) => {
      const result = store.recall({ q: "irrigation valve", projectRoot: root, ...range }) as RecallResult;
      return result.hits.map((hit) => hit.id).sort();
    };
    expect(ids({ from: "2031-06-01", to: "2031-06-30" })).toEqual([june]);
    expect(ids({ from: "2031-07-01" })).toEqual([july]);
    // Knowledge is dated by its last update (today), so it falls inside a range that ends in 2031.
    expect(ids({ to: "2031-06-15" })).toEqual([june, knowledge.knowledge.id].sort());
    expect(ids({})).toEqual([june, july, knowledge.knowledge.id].sort());

    const searched = store.search("irrigation valve", root, { from: "2031-07-01", to: "2031-07-31" });
    expect(Array.isArray(searched) && searched.map((item) => item.session.id)).toEqual([july]);
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
