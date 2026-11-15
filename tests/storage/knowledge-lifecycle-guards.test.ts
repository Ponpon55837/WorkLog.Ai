import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. A backfilled finalize must not move a confirmation back in time, and a replaced
// Knowledge must not be restored while its replacement is active.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-guards-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Orchard", root);
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
    return result;
  };
  const record = (key: string, supersedesId?: string) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "pattern",
      title: `Pear ${key}`,
      body: "Thin the fruit in June.",
      ...(supersedesId ? { supersedesId } : {}),
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    return result.knowledge;
  };
  const historyOf = (id: string) => {
    const result = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: id });
    if (result.outcome !== "knowledge_history") throw new Error("Expected history");
    return result;
  };
  return { root, store, finalize, record, historyOf, tick };
}

describe("backfilled confirmation", () => {
  it("keeps a later confirmation when a Session that finished earlier applies the Knowledge", () => {
    const { finalize, record, historyOf } = setup();
    const knowledge = record("k");
    const recent = finalize("recent", { appliedKnowledgeIds: [knowledge.id] });
    const confirmedAt = historyOf(knowledge.id).knowledge.lastConfirmedAt;
    expect(confirmedAt).toBe(recent.session.completedAt);

    // Reported afterwards for work that finished a day earlier: the feedback is a fact and stays, the baseline does not.
    finalize("backfill", {
      appliedKnowledgeIds: [knowledge.id],
      completedAt: "2029-12-31T00:00:00.000Z",
    });
    const after = historyOf(knowledge.id);
    expect(after.knowledge.lastConfirmedAt).toBe(confirmedAt);
    expect(after.knowledge.lastConfirmedSessionId).toBe(recent.session.id);
    expect(after.feedback.filter((entry) => entry.kind === "applied")).toHaveLength(2);
    expect(after.knowledge.evidence).toMatchObject({ confirmed: 2 });
    expect(after.history.filter((entry) => entry.action === "updated")).toHaveLength(2);
  });

  it("moves forward for a later Session, and sets it when there was no confirmation", () => {
    const { finalize, record, historyOf } = setup();
    const knowledge = record("k");
    const first = finalize("first", { appliedKnowledgeIds: [knowledge.id] });
    const second = finalize("second", { appliedKnowledgeIds: [knowledge.id] });
    expect(historyOf(knowledge.id).knowledge).toMatchObject({
      lastConfirmedAt: second.session.completedAt,
      lastConfirmedSessionId: second.session.id,
    });
    expect(first.session.id).not.toBe(second.session.id);

    // With no earlier confirmation, a backfilled one is still recorded.
    const other = record("other");
    finalize("early", { appliedKnowledgeIds: [other.id], completedAt: "2029-12-30T00:00:00.000Z" });
    expect(historyOf(other.id).knowledge.lastConfirmedAt).toBe("2029-12-30T00:00:00.000Z");
  });

  it("does not move a manual confirmation back either", () => {
    const { store, root, finalize, record, historyOf, tick } = setup();
    const knowledge = record("manual");
    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, confirm: true });
    const confirmedAt = historyOf(knowledge.id).knowledge.lastConfirmedAt;
    finalize("backfill", { appliedKnowledgeIds: [knowledge.id], completedAt: "2029-12-31T00:00:00.000Z" });
    expect(historyOf(knowledge.id).knowledge.lastConfirmedAt).toBe(confirmedAt);
  });
});

describe("restoring replaced Knowledge", () => {
  it("rejects restoring an archived item that an active item supersedes", () => {
    const { store, root, record, historyOf, tick } = setup();
    const older = record("older");
    const newer = record("newer", older.id);
    expect(historyOf(older.id).knowledge.status).toBe("archived");

    tick();
    const result = store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, status: "active" });
    expect(result).toEqual({
      outcome: "rejected",
      reason: "superseded_by_active",
      knowledgeId: older.id,
      successorId: newer.id,
    });
    // Nothing changed: still archived, no audit row for a restore.
    const after = historyOf(older.id);
    expect(after.knowledge.status).toBe("archived");
    expect(after.history.map((entry) => entry.action)).toEqual(["archived", "created"]);

    // Other edits of the archived item are still allowed.
    tick();
    expect(
      store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, title: "Pear older (kept)" }),
    ).toMatchObject({ outcome: "knowledge_updated", knowledge: { status: "archived" } });
  });

  it("restores it once the successor is archived, and setting the status it already has is a plain update", () => {
    const { store, root, record, historyOf, tick } = setup();
    const older = record("older");
    const newer = record("newer", older.id);
    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: newer.id, status: "archived" });
    tick();
    expect(store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, status: "active" })).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: { status: "active" },
    });
    expect(historyOf(older.id).history[0]).toMatchObject({ action: "restored" });

    // Setting the status an item already has is a plain update.
    tick();
    expect(store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, status: "active" })).toMatchObject({
      outcome: "knowledge_updated",
    });
  });

  it("restores an archived item that nothing replaced", () => {
    const { store, root, record, tick } = setup();
    const standalone = record("standalone");
    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: standalone.id, status: "archived" });
    tick();
    expect(store.updateKnowledge({ projectRoot: root, knowledgeId: standalone.id, status: "active" })).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: { status: "active" },
    });
  });

  it("is decided inside the write lock, so a successor recorded in between still blocks the restore", () => {
    const { store, root, record, tick } = setup();
    const older = record("older");
    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, status: "archived" });
    // A second connection's write after the caller looked: the check reads the database again under the lock.
    tick();
    const successor = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "late-successor",
      kind: "pattern",
      title: "Pear successor",
      body: "Replaces the archived rule.",
      supersedesId: older.id,
    });
    if (successor.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    tick();
    expect(store.updateKnowledge({ projectRoot: root, knowledgeId: older.id, status: "active" })).toMatchObject({
      outcome: "rejected",
      successorId: successor.knowledge.id,
    });
  });
});
