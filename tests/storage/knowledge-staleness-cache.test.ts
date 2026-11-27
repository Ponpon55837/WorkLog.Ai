import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput, KnowledgeRecord } from "../../packages/core/src/index.js";
import { setAppliesToBudgetProbe, type AppliesToBudget } from "../../packages/storage/src/applies-to-match.js";
import type { KnowledgeService } from "../../packages/storage/src/knowledge-service.js";
import { setStalenessUnitLimits } from "../../packages/storage/src/later-change-index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  setStalenessUnitLimits(undefined);
  setAppliesToBudgetProbe(undefined);
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-staleness-cache-"));
  tempDirs.push(root);
  const databasePath = join(root, "cache.sqlite");
  const open = () => {
    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    return store;
  };
  const store = open();
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (target: WorkIntelligenceStore, key: string, overrides: Partial<FinalizeSessionInput> = {}) => {
    tick();
    const result = target.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      ...overrides,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result;
  };
  const record = (key: string, appliesTo: string[]): KnowledgeRecord => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "gotcha",
      title: `Tree ${key}`,
      body: "Prune before the first frost.",
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    return result.knowledge;
  };
  const staleOf = (target: WorkIntelligenceStore, id: string) => {
    const result = target.searchKnowledge({ projectRoot: root, limit: 50 });
    if (result.outcome !== "knowledge") throw new Error("Expected Knowledge list");
    return result.items.find((item) => item.id === id);
  };
  return { root, store, open, finalize, record, staleOf, tick };
}

describe("remembered Knowledge staleness", () => {
  it("flips to stale after a later Session changes a matching file, with a warm cache on the same store", () => {
    const { store, finalize, record, staleOf } = setup();
    const knowledge = record("a", ["src/tree/**"]);
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeUndefined();
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeUndefined();

    const touching = finalize(store, "touching", { changedFiles: ["src/tree/a.ts"] });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toMatchObject({ sessionId: touching.session.id });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toMatchObject({ sessionId: touching.session.id });
  });

  it("flips back after the Knowledge is confirmed", () => {
    const { store, root, finalize, record, staleOf, tick } = setup();
    const knowledge = record("b", ["src/tree/**"]);
    finalize(store, "touching", { changedFiles: ["src/tree/a.ts"] });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeDefined();
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeDefined();

    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, confirm: true });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeUndefined();

    finalize(store, "touching-again", { changedFiles: ["src/tree/b.ts"] });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeDefined();
    finalize(store, "applied", { changedFiles: [], appliedKnowledgeIds: [knowledge.id] });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeUndefined();
  });

  it("is not served across connections: a write by another connection is visible", () => {
    const { store, open, finalize, record, staleOf } = setup();
    const knowledge = record("c", ["src/tree/**"]);
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeUndefined();
    const other = open();
    expect(staleOf(other, knowledge.id)?.possiblyStale).toBeUndefined();

    finalize(other, "other-writes", { changedFiles: ["src/tree/a.ts"] });
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeDefined();
    expect(staleOf(other, knowledge.id)?.possiblyStale).toBeDefined();
  });

  it("remembers a complete call but nothing from a call whose budget ran out or left a record unchecked", () => {
    const { store, finalize, record, staleOf } = setup();
    const knowledge = record("d", ["src/tree/**"]);
    finalize(store, "touching", { changedFiles: ["src/tree/a.ts"] });
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe(budgets);

    staleOf(store, knowledge.id);
    const afterFirst = budgets.length;
    expect(afterFirst).toBeGreaterThan(0);
    staleOf(store, knowledge.id);
    expect(budgets.length).toBe(afterFirst);

    setStalenessUnitLimits({ history: 1 });
    expect(staleOf(store, knowledge.id)?.stalenessUnchecked).toBe(true);
    const unchecked = budgets.length;
    expect(staleOf(store, knowledge.id)?.stalenessUnchecked).toBe(true);
    expect(budgets.length).toBeGreaterThan(unchecked);

    setStalenessUnitLimits(undefined);
    expect(staleOf(store, knowledge.id)?.possiblyStale).toBeDefined();
    expect(staleOf(store, knowledge.id)?.stalenessUnchecked).toBeUndefined();
  });

  it("never holds more than its key cap", () => {
    const { store, record } = setup();
    // 600 durable writes cost about 35 ms each on a Windows runner (fsync), enough to hit the test timeout; this test is
    // about the cache's size, not durability, so this connection skips the fsync.
    (store as unknown as { db: DatabaseSync }).db.exec("PRAGMA synchronous = OFF");
    const records = Array.from({ length: 600 }, (_, index) => record(`bulk-${index}`, [`src/tree-${index}/**`]));
    const service = (store as unknown as { knowledgeService: KnowledgeService }).knowledgeService;
    const cache = (service as unknown as { stalenessResults: { values: Map<string, unknown> } }).stalenessResults;
    service.withKnowledgeTrustMany(records);
    expect(cache.values.size).toBeLessThanOrEqual(512);
    for (let start = 0; start < 600; start += 100) service.withKnowledgeTrustMany(records.slice(start, start + 100));
    expect(cache.values.size).toBeLessThanOrEqual(512);
    expect(cache.values.size).toBeGreaterThan(0);
  });
});
