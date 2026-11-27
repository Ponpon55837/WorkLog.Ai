import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentKnowledgeQueryResult,
  FinalizeSessionInput,
  KnowledgeQuery,
  RecallResult,
  RelevantContext,
} from "../../packages/core/src/index.js";
import { staleFlags } from "../../packages/storage/src/stale-flags.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-retrieval-trust-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Saffron Farm", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root };
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
  if (result.outcome !== "finalized") throw new Error(`Expected ${key} to finalize, got ${result.outcome}`);
  return result.session.id;
}

function record(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  title: string,
  extra: { body?: string; appliesTo?: string[]; archived?: boolean } = {},
): string {
  const result = store.recordKnowledge({
    projectRoot: root,
    idempotencyKey: key,
    kind: "gotcha",
    title,
    body: extra.body ?? "A fictional saffron note.",
    tags: [],
    appliesTo: extra.appliesTo ?? [],
  });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Expected ${key} to record, got ${result.outcome}`);
  if (extra.archived) {
    store.updateKnowledge({ projectRoot: root, knowledgeId: result.knowledge.id, status: "archived" });
  }
  return result.knowledge.id;
}

function recall(store: WorkIntelligenceStore, input: Parameters<WorkIntelligenceStore["recall"]>[0]): RecallResult {
  const result = store.recall(input);
  if (result.outcome !== "recall") throw new Error(`Expected recall, got ${result.outcome}`);
  return result;
}

function relevantOf(
  store: WorkIntelligenceStore,
  root: string | undefined,
  focus: { task?: string; paths?: string[] },
): RelevantContext {
  const context = store.getContext(root, focus);
  if (context.outcome !== "context" || !context.relevant) throw new Error("Expected a focused context.");
  return context.relevant;
}

function searchKnowledge(store: WorkIntelligenceStore, query: KnowledgeQuery): AgentKnowledgeQueryResult {
  const result = store.searchKnowledgeForAgent(query);
  if (result.outcome !== "knowledge") throw new Error(`Expected a Knowledge result, got ${result.outcome}`);
  return result;
}

/** Distinct four-letter words no tokenizer rule splits or drops: qzaa, qzab, ... */
function distinctWords(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `qz${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
  );
}

describe("Knowledge confidence apart from Session confidence", () => {
  it("rates recall Knowledge hits alone, so a matching Session cannot stand in for Knowledge", () => {
    const { store, root } = setup();
    finalize(store, root, "dryer", { title: "Saffron stigma dryer calibration" });

    const withoutKnowledge = recall(store, { projectRoot: root, q: "saffron stigma dryer calibration" });
    expect(withoutKnowledge).toMatchObject({ confidence: "high", knowledgeConfidence: "none" });

    record(store, root, "dryer-rule", "Saffron stigma dryer calibration rule");
    const withKnowledge = recall(store, { projectRoot: root, q: "saffron stigma dryer calibration" });
    expect(withKnowledge).toMatchObject({ confidence: "high", knowledgeConfidence: "high" });
  });

  it("is none when nothing matches at all", () => {
    const { store, root } = setup();
    expect(recall(store, { projectRoot: root, q: "zzyzx" })).toMatchObject({
      confidence: "none",
      knowledgeConfidence: "none",
    });
  });

  it("counts a path-matched Knowledge as confident through appliesTo", () => {
    const { store, root } = setup();
    finalize(store, root, "dryer", { title: "Dryer work", changedFiles: ["src/dryer/heater.ts"] });
    record(store, root, "dryer-scope", "Heater coil limits", { appliesTo: ["src/dryer/**"] });

    expect(recall(store, { projectRoot: root, paths: ["src/dryer/heater.ts"] })).toMatchObject({
      confidence: "high",
      knowledgeConfidence: "high",
    });
  });

  it("reports the same split in a focused context, with a fixed hint when no Knowledge was found", () => {
    const { store, root } = setup();
    finalize(store, root, "dryer", { title: "Saffron stigma dryer calibration" });

    const scoped = relevantOf(store, root, { task: "saffron stigma dryer calibration" });
    expect(scoped).toMatchObject({ confidence: "high", knowledgeConfidence: "none", knowledge: [] });
    expect(scoped.knowledgeHint).toContain("No Knowledge text matched this task");
    expect(scoped.knowledgeHint).toContain("pass `paths`");
    expect(scoped.knowledgeHint).not.toContain("projectRoot");

    const unscoped = relevantOf(store, undefined, { task: "saffron stigma dryer calibration" });
    expect(unscoped.knowledgeHint).toContain("`paths`");
    expect(unscoped.knowledgeHint).toContain("`projectRoot`");
  });

  it("words the hint for a call that already passed paths without asking for paths again", () => {
    const { store, root } = setup();
    finalize(store, root, "dryer", {
      title: "Saffron stigma dryer calibration",
      changedFiles: ["src/dryer/heater.ts"],
    });

    const relevant = relevantOf(store, root, {
      task: "saffron stigma dryer calibration",
      paths: ["src/dryer/heater.ts"],
    });
    expect(relevant).toMatchObject({ confidence: "high", knowledgeConfidence: "none", knowledge: [] });
    expect(relevant.knowledgeHint).toContain("covering these paths");
    expect(relevant.knowledgeHint).not.toContain("pass `paths`");
  });

  it("leaves the hint out and rates high once Knowledge is found", () => {
    const { store, root } = setup();
    finalize(store, root, "dryer", { title: "Saffron stigma dryer calibration" });
    record(store, root, "dryer-rule", "Saffron stigma dryer calibration rule");

    const relevant = relevantOf(store, root, { task: "saffron stigma dryer calibration" });
    expect(relevant).toMatchObject({ knowledgeConfidence: "high" });
    expect(relevant.knowledge).toHaveLength(1);
    expect(relevant).not.toHaveProperty("knowledgeHint");
  });
});

describe("termHits", () => {
  it("does not report words past the 32-term cap as matching nothing, and says it cut the query", () => {
    const { store, root } = setup();
    const words = distinctWords(34);
    finalize(store, root, "words", { title: `Wordlist ${words.slice(0, 3).join(" ")}` });

    const result = recall(store, { projectRoot: root, q: words.join(" ") });
    expect(result.termHitsTruncated).toBe(true);
    expect(result.termHits?.map((entry) => entry.term)).toEqual(words.slice(0, 32));
    expect(result.termHits?.some((entry) => entry.term === words[32] || entry.term === words[33])).toBe(false);

    const within = recall(store, { projectRoot: root, q: words.slice(0, 32).join(" ") });
    expect(within).not.toHaveProperty("termHitsTruncated");
  });

  it("counts a compound word by any of its parts, the way the ranking matches", () => {
    const { store, root } = setup();
    finalize(store, root, "pipeline", { title: "Retrieval pipeline" });
    finalize(store, root, "boundary", { title: "Trust boundary" });

    expect(recall(store, { projectRoot: root, q: "retrieval-trust zzyzx" }).termHits).toEqual([
      { term: "retrieval-trust", count: 2 },
      { term: "zzyzx", count: 0 },
    ]);
    expect(recall(store, { projectRoot: root, q: "retrievalTrust zzyzx" }).termHits).toEqual([
      { term: "retrievalTrust", count: 2 },
      { term: "zzyzx", count: 0 },
    ]);
  });

  it("adds per-word counts to a zero-hit Knowledge search, counting only the searched status", () => {
    const { store, root } = setup();
    record(store, root, "graft", "Graft apple scions in early spring");
    record(store, root, "prune", "Prune pear trees after harvest", { archived: true });

    const none = searchKnowledge(store, { projectRoot: root, q: "zzyzx quuxlet" });
    expect(none).toMatchObject({
      match: "none",
      termHits: [
        { term: "zzyzx", count: 0 },
        { term: "quuxlet", count: 0 },
      ],
    });
    expect(none.hint).toContain("contains any of these words");

    const relaxed = searchKnowledge(store, { projectRoot: root, q: "graft pear zzyzx" });
    expect(relaxed.match).toBe("relaxed");
    expect(relaxed.termHits).toEqual([
      { term: "graft", count: 1 },
      { term: "pear", count: 0 },
      { term: "zzyzx", count: 0 },
    ]);
    expect(relaxed).not.toHaveProperty("termHitsTruncated");
  });

  it("keeps the other-status pointer instead of claiming nothing exists when an archived record matches", () => {
    const { store, root } = setup();
    record(store, root, "prune", "Prune pear trees after harvest", { archived: true });

    const result = searchKnowledge(store, { projectRoot: root, q: "prune pear zzyzx" });
    expect(result.otherStatusMatches).toEqual({ archived: 1 });
    expect(result.termHits).toEqual([
      { term: "prune", count: 0 },
      { term: "pear", count: 0 },
      { term: "zzyzx", count: 0 },
    ]);
    expect(result.hint).toContain('pass status "archived"');
  });

  it("counts a Knowledge compound by any part and marks a query cut at 32 terms", () => {
    const { store, root } = setup();
    record(store, root, "graft", "Graft apple scions");

    expect(searchKnowledge(store, { projectRoot: root, q: "graft-prune zzyzx" }).termHits).toEqual([
      { term: "graft-prune", count: 1 },
      { term: "zzyzx", count: 0 },
    ]);

    const words = distinctWords(34);
    const long = searchKnowledge(store, { projectRoot: root, q: words.join(" ") });
    expect(long.termHitsTruncated).toBe(true);
    expect(long.termHits?.map((entry) => entry.term)).toEqual(words.slice(0, 32));
  });

  it("names the cut query on a strict answer too", () => {
    const { store, root } = setup();
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    record(store, root, "nato", "NATO list", { body: words.join(" ") });

    const result = searchKnowledge(store, { projectRoot: root, q: words.join(" ") });
    expect(result.match).toBe("strict");
    expect(result.effectiveQuery).toBe(words.slice(0, 8).join(" "));

    expect(searchKnowledge(store, { projectRoot: root, q: "alpha bravo" })).not.toHaveProperty("effectiveQuery");
  });
});

describe("synonym-only hits", () => {
  it("marks only the hits found through a built-in synonym", () => {
    const { store, root } = setup();
    const direct = finalize(store, root, "direct", { title: "Valve status route handler" });
    const viaSynonym = finalize(store, root, "synonym", { title: "Add endpoint for valve status" });

    const result = recall(store, { projectRoot: root, q: "route" });
    const byId = new Map(result.hits.map((hit) => [hit.id, hit]));
    expect(byId.get(direct)).toBeDefined();
    expect(byId.get(direct)).not.toHaveProperty("matchedVia");
    expect(byId.get(viaSynonym)).toMatchObject({ matchedVia: "synonym" });
    expect(byId.get(viaSynonym)?.matchedIn.length).toBeGreaterThan(0);

    const search = store.searchForAgent("route", root);
    if (search.outcome !== "search") throw new Error("Expected search");
    const marked = search.hits.filter((hit) => hit.matchedVia === "synonym").map((hit) => hit.session.id);
    expect(marked).toEqual([viaSynonym]);
    expect(search.hits.every((hit) => typeof hit.matchedIn === "string")).toBe(true);
  });

  it("does not mark a path-matched record", () => {
    const { store, root } = setup();
    const byPath = finalize(store, root, "path", { title: "Add endpoint", changedFiles: ["src/routes/valve.ts"] });

    const hit = recall(store, { projectRoot: root, q: "route", paths: ["src/routes/valve.ts"] }).hits.find(
      (item) => item.id === byPath,
    );
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty("matchedVia");
  });
});

describe("appliesTo and the date range", () => {
  it("applies from and to to path-scoped Knowledge as it does to text and path matches", () => {
    const { store, root } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 2, 15, 12));
    const id = record(store, root, "valves", "Valve pressure limits", { appliesTo: ["src/valves/**"] });
    const paths = ["src/valves/pump.ts"];
    const ids = (range: { from?: string; to?: string }) =>
      recall(store, { projectRoot: root, paths, ...range }).hits.map((hit) => hit.id);

    expect(ids({})).toEqual([id]);
    expect(ids({ from: "2031-03-01", to: "2031-03-31" })).toEqual([id]);
    expect(ids({ from: "2031-04-01" })).toEqual([]);
    expect(ids({ to: "2031-03-01" })).toEqual([]);
  });
});

describe("relevant Knowledge pages for a Chinese task", () => {
  function savePage(store: WorkIntelligenceStore, root: string, sessionId: string): void {
    store.requestKnowledgePageUpdate({ projectRoot: root, slug: "architecture" });
    const saved = store.saveKnowledgePage({
      projectRoot: root,
      slug: "architecture",
      idempotencyKey: "page-cjk",
      sections: [
        {
          heading: "快取策略",
          content: "快取失效後必須重新整理索引，並保留來源紀錄。",
          sourceSessionIds: [sessionId],
        },
      ],
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");
  }

  it("matches a task with no spaces through its character pairs", () => {
    const { store, root } = setup();
    savePage(store, root, finalize(store, root, "cache", { title: "Cache notes" }));

    const relevant = relevantOf(store, root, { task: "請處理快取失效的問題" });
    expect(relevant.knowledgePages?.map((page) => page.slug)).toEqual(["architecture"]);
  });

  it("does not match a page on one shared character pair", () => {
    const { store, root } = setup();
    savePage(store, root, finalize(store, root, "cache", { title: "Cache notes" }));

    expect(relevantOf(store, root, { task: "快取設計討論" }).knowledgePages ?? []).toEqual([]);
  });
});

describe("compact staleness detail", () => {
  it("keeps possiblyStale and adds the reason and count only when they carry information", () => {
    expect(staleFlags({})).toEqual({});
    expect(staleFlags({ possiblyStale: { reason: "applies_to_changed" } })).toEqual({ possiblyStale: true });
    expect(staleFlags({ possiblyStale: { reason: "broad_applies_to" }, broadChangesSince: 2 })).toEqual({
      possiblyStale: true,
      staleReason: "broad_applies_to",
      broadChangesSince: 2,
    });
    expect(staleFlags({ possiblyStale: true, staleReason: "broad_applies_to" })).toEqual({
      possiblyStale: true,
      staleReason: "broad_applies_to",
    });
    expect(staleFlags({ broadChangesSince: 0 })).toEqual({});
  });

  it("carries broadChangesSince onto recall hits and relaxed matches", () => {
    const { store, root } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 2, 1));
    record(store, root, "k", "Valve pressure limits", { appliesTo: ["src/valves/**"] });
    vi.setSystemTime(Date.UTC(2031, 2, 2));
    finalize(store, root, "bulk", {
      title: "Bulk rename",
      changedFiles: Array.from({ length: 25 }, (_, index) => `src/valves/file${index}.ts`),
    });

    const hit = recall(store, { projectRoot: root, q: "valve pressure limits" }).hits.find(
      (item) => item.type === "knowledge",
    );
    expect(hit).not.toHaveProperty("possiblyStale");
    expect(hit?.broadChangesSince).toBe(1);
    const relaxed = searchKnowledge(store, { projectRoot: root, q: "valve zzyzx" });
    expect(relaxed.relaxedMatches?.[0]?.broadChangesSince).toBe(1);
  });
});
