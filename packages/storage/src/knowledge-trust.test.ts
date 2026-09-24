import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput, KnowledgeRecord } from "@work-intelligence/core";
import { matchesAppliesTo } from "./search-text.js";
import { WorkIntelligenceStore } from "./store.js";

// Fictional fixtures only.
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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-trust-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  // Each write happens one minute after the previous one so "later than" comparisons are strict.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (key: string, overrides: Partial<FinalizeSessionInput> = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      ...overrides,
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result;
  };
  const record = (key: string, extra: { appliesTo?: string[]; supersedesId?: string } = {}): KnowledgeRecord => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "gotcha",
      title: `Hive ${key}`,
      body: "Queen excluder must be checked first.",
      ...extra,
    });
    if (result.outcome !== "knowledge_recorded") {
      throw new Error("Expected Knowledge");
    }
    return result.knowledge;
  };
  const knowledgeById = (id: string) => {
    for (const status of ["active", "archived"] as const) {
      const result = store.searchKnowledge({ projectRoot: root, status, limit: 50 });
      const found = result.outcome === "knowledge" ? result.items.find((item) => item.id === id) : undefined;
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return { store, root, finalize, record, knowledgeById, tick };
}

describe("appliesTo matching", () => {
  it("matches globs, directories, and path suffixes", () => {
    expect(matchesAppliesTo("src/hive/queen.ts", "src/hive/*.ts")).toBe(true);
    expect(matchesAppliesTo("src/hive/deep/queen.ts", "src/hive/*.ts")).toBe(false);
    expect(matchesAppliesTo("src/hive/deep/queen.ts", "src/**/queen.ts")).toBe(true);
    expect(matchesAppliesTo("src/queen.ts", "src/**/queen.ts")).toBe(true);
    expect(matchesAppliesTo("src/hive/queen.ts", "src/hive")).toBe(true);
    expect(matchesAppliesTo("src/hive.config.ts", "src/hive")).toBe(false);
    expect(matchesAppliesTo("src/a.b.ts", "src/a?b.ts")).toBe(true);
  });
});

describe("Knowledge trust", () => {
  it("flags Knowledge as possibly stale when a later Session changes its paths, until it is confirmed", () => {
    const { store, root, finalize, record, knowledgeById, tick } = setup();
    const knowledge = record("stale", { appliesTo: ["src/hive/**"] });
    expect(knowledgeById(knowledge.id)?.possiblyStale).toBeUndefined();

    finalize("unrelated", { changedFiles: ["docs/readme.md"] });
    expect(knowledgeById(knowledge.id)?.possiblyStale).toBeUndefined();
    const touching = finalize("touching", { changedFiles: ["src/hive/queen.ts", "docs/readme.md"] });
    finalize("touching-again", { changedFiles: ["src/hive/drone.ts"] });

    expect(knowledgeById(knowledge.id)?.possiblyStale).toMatchObject({
      sessionId: touching.session.id,
      paths: ["src/hive/queen.ts"],
      sessionCount: 2,
    });
    const context = store.getContext(root);
    expect(context.outcome === "context" && context.recentKnowledge[0]).toMatchObject({ possiblyStale: true });

    tick();
    const confirmed = store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, confirm: true });
    expect(confirmed).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: { lastConfirmedAt: expect.any(String) },
    });
    expect(confirmed.outcome === "knowledge_updated" && confirmed.knowledge.possiblyStale).toBeUndefined();
  });

  it("confirms applied Knowledge and flags contradicted Knowledge from finalize", () => {
    const { store, finalize, record, knowledgeById } = setup();
    const applied = record("applied", { appliesTo: ["src/hive/**"] });
    const contradicted = record("contradicted");

    const result = finalize("feedback", {
      changedFiles: ["src/hive/queen.ts"],
      appliedKnowledgeIds: [applied.id, "missing-knowledge"],
      contradictedKnowledgeIds: [contradicted.id],
    });
    expect(result.knowledgeWarnings).toEqual(["missing-knowledge: Knowledge was not found in this project."]);
    // The confirming Session itself changed the paths, so it does not make the Knowledge stale.
    expect(knowledgeById(applied.id)).toMatchObject({
      lastConfirmedSessionId: result.session.id,
      lastConfirmedAt: result.session.completedAt,
    });
    expect(knowledgeById(applied.id)?.possiblyStale).toBeUndefined();
    expect(knowledgeById(contradicted.id)?.review).toMatchObject({
      reason: "contradicted",
      sessionId: result.session.id,
    });

    const recall = store.recall({ q: "hive contradicted" });
    expect(recall.outcome === "recall" && recall.hits.find((hit) => hit.id === contradicted.id)).toMatchObject({
      needsReview: true,
    });

    const history = store.getKnowledgeHistory({
      projectRoot: store.getProjectById(contradicted.projectId)!.rootPath,
      knowledgeId: contradicted.id,
    });
    expect(history.outcome === "knowledge_history" && history.history[0]).toMatchObject({
      action: "updated",
      changedFields: ["review"],
    });

    finalize("reapplied", { appliedKnowledgeIds: [contradicted.id] });
    expect(knowledgeById(contradicted.id)?.review).toBeUndefined();
  });

  it("archives the superseded Knowledge and reports an unknown supersedesId", () => {
    const { store, root, record, knowledgeById } = setup();
    const old = record("old");
    const replacement = record("new", { supersedesId: old.id });
    expect(replacement.supersedesId).toBe(old.id);
    expect(knowledgeById(old.id)?.status).toBe("archived");

    const orphan = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "orphan",
      kind: "pattern",
      title: "Orphan",
      body: "Body.",
      supersedesId: "missing",
    });
    expect(orphan).toMatchObject({ warnings: ["supersedesId missing was not found in this project."] });
  });
});
