import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-evidence-"));
  tempDirs.push(root);
  const databasePath = join(root, "evidence.sqlite");
  const open = () => {
    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    return store;
  };
  const store = open();
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
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
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const record = (key: string, title: string, body = "Smoke the hive before opening the brood box.") => {
    tick();
    const result = store.recordKnowledge({ projectRoot: root, idempotencyKey: key, kind: "gotcha", title, body });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected knowledge");
    return result.knowledge.id;
  };
  const confirm = (knowledgeId: string) => {
    tick();
    return store.updateKnowledge({ projectRoot: root, knowledgeId, confirm: true });
  };
  return { store, root, project, databasePath, open, tick, finalize, record, confirm };
}

describe("Knowledge evidence strength", () => {
  it("counts Session confirmations, contradictions, and manual confirmations with their sources", () => {
    const { store, root, finalize, record, confirm } = setup();
    const knowledgeId = record("smoke", "Smoke the hive first");
    const first = finalize("first", { appliedKnowledgeIds: [knowledgeId] });
    const second = finalize("second", { appliedKnowledgeIds: [knowledgeId] });
    const third = finalize("third", { contradictedKnowledgeIds: [knowledgeId] });
    confirm(knowledgeId);

    const listed = store.searchKnowledge({ projectRoot: root });
    const item = listed.outcome === "knowledge" ? listed.items[0] : undefined;
    expect(item?.evidence).toMatchObject({ confirmed: 3, contradicted: 1 });
    expect(item!.evidence!.lastConfirmedAt! > item!.evidence!.lastContradictedAt!).toBe(true);

    const history = store.getKnowledgeHistory({ projectRoot: root, knowledgeId });
    expect(history.outcome === "knowledge_history" && history.feedback).toEqual([
      expect.objectContaining({ kind: "manual_confirm" }),
      expect.objectContaining({ kind: "contradicted", sessionId: third, sessionTitle: "Session third" }),
      expect.objectContaining({ kind: "applied", sessionId: second }),
      expect.objectContaining({ kind: "applied", sessionId: first }),
    ]);
    expect(history.outcome === "knowledge_history" && history.feedback[0]?.sessionId).toBeUndefined();
  });

  it("backfills only certain feedback from the audit history when upgrading", () => {
    const { store, root, open, databasePath, finalize, record, confirm, tick } = setup();
    const knowledgeId = record("smoke", "Smoke the hive first");
    finalize("applied", { appliedKnowledgeIds: [knowledgeId] });
    finalize("contradicted", { contradictedKnowledgeIds: [knowledgeId] });
    confirm(knowledgeId);
    tick();
    // A plain edit leaves an audit row that is not feedback.
    store.updateKnowledge({ projectRoot: root, knowledgeId, title: "Smoke the hive before opening it" });
    stores.splice(stores.indexOf(store), 1);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE knowledge_feedback; DELETE FROM schema_migrations WHERE version = 17;");
    expect((database.prepare("SELECT COUNT(*) AS count FROM knowledge_audit").get() as { count: number }).count).toBe(
      5,
    );
    database.close();

    const upgraded = open();
    const history = upgraded.getKnowledgeHistory({ projectRoot: root, knowledgeId });
    expect(history.outcome === "knowledge_history" && history.feedback.map((item) => item.kind)).toEqual([
      "manual_confirm",
      "contradicted",
      "applied",
    ]);
    expect(history.outcome === "knowledge_history" && history.knowledge.evidence).toMatchObject({
      confirmed: 2,
      contradicted: 1,
    });
  });

  it("ranks well-confirmed Knowledge above equal matches and disputed Knowledge below them", () => {
    const { store, root, finalize, record } = setup();
    const neutral = record("neutral", "Varroa mite count procedure");
    const trusted = record("trusted", "Varroa mite count procedure");
    const disputed = record("disputed", "Varroa mite count procedure");
    finalize("confirm-1", { appliedKnowledgeIds: [trusted, disputed] });
    finalize("confirm-2", { appliedKnowledgeIds: [trusted] });
    finalize("contradict", { contradictedKnowledgeIds: [disputed] });

    const result = store.recall({ q: "varroa mite count", projectRoot: root });
    const hits = result.outcome === "recall" ? result.hits.filter((hit) => hit.type === "knowledge") : [];
    expect(hits.map((hit) => hit.id)).toEqual([trusted, neutral, disputed]);
    expect(hits[0]?.evidence).toEqual({ confirmed: 2, contradicted: 0 });
    expect(hits[2]).toMatchObject({ needsReview: true, evidence: { confirmed: 1, contradicted: 1 } });
  });

  it("travels with portable exports and is removed with its project", () => {
    const { store, project, root, finalize, record, confirm } = setup();
    const knowledgeId = record("smoke", "Smoke the hive first");
    finalize("applied", { appliedKnowledgeIds: [knowledgeId] });
    confirm(knowledgeId);

    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.knowledge_feedback).toHaveLength(2);
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const imported = destination.importProjectData({ bundle, remap: [] });
    expect(imported.additions.knowledge_feedback).toBe(2);

    const deleted = store.deleteProject(project.id, "Apiary");
    expect(deleted.deletedCounts).toMatchObject({ knowledgeFeedback: 2 });
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({ outcome: "skipped" });
  });
});
