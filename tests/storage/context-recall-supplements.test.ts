import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextResult, FinalizeSessionInput, WorkSessionRecord } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

interface TestProject {
  root: string;
  store: WorkIntelligenceStore;
}

interface SessionOptions {
  parentSessionId?: string;
  relatedSessionIds?: string[];
  appliedKnowledgeIds?: string[];
  contradictedKnowledgeIds?: string[];
  changedFiles?: string[];
  completedAt?: string;
  decisions?: string[];
}

interface RecordedSession {
  id: string;
  record: WorkSessionRecord;
}

const stores: WorkIntelligenceStore[] = [];
const roots: string[] = [];
const LONG_DECISION =
  "The calibration procedure preserves the documented pressure limit and recovery sequence. ".repeat(6);
const LONG_TITLE = "Synthetic maintenance record documenting the safe recovery sequence and repeatable checks. ".repeat(
  4,
);

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createTrackedProject(): TestProject {
  const root = mkdtempSync(join(tmpdir(), "worklog-d1-context-"));
  roots.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Synthetic D1 context", root);
  store.updateProject(project.id, { status: "tracked" });
  return { root, store };
}

function finalizeSession(
  store: WorkIntelligenceStore,
  root: string,
  idempotencyKey: string,
  title: string,
  summary: string,
  options: SessionOptions = {},
): RecordedSession {
  const input: FinalizeSessionInput = {
    projectRoot: root,
    idempotencyKey,
    title,
    summary,
    workSummary: {
      outcomes: [],
      scope: [],
      decisions: options.decisions ?? [],
      verification: [],
      nextSteps: [],
    },
    changedFiles: options.changedFiles ?? [],
    verification: { status: "passed" },
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.relatedSessionIds ? { relatedSessionIds: options.relatedSessionIds } : {}),
    ...(options.appliedKnowledgeIds ? { appliedKnowledgeIds: options.appliedKnowledgeIds } : {}),
    ...(options.contradictedKnowledgeIds ? { contradictedKnowledgeIds: options.contradictedKnowledgeIds } : {}),
    ...(options.completedAt ? { completedAt: options.completedAt } : {}),
  };
  const result = store.finalizeSession(input);
  if (result.outcome !== "finalized") throw new Error(`Expected ${idempotencyKey} to finalize.`);
  return { id: result.session.id, record: result.session };
}

function recordKnowledge(
  store: WorkIntelligenceStore,
  root: string,
  idempotencyKey: string,
  title: string,
  body: string,
  options: { appliesTo?: string[]; supersedesId?: string } = {},
): string {
  const result = store.recordKnowledge({
    projectRoot: root,
    idempotencyKey,
    kind: "pattern",
    title,
    body,
    tags: ["synthetic", "d1"],
    ...(options.appliesTo ? { appliesTo: options.appliesTo } : {}),
    ...(options.supersedesId ? { supersedesId: options.supersedesId } : {}),
  });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Expected ${idempotencyKey} to create Knowledge.`);
  return result.knowledge.id;
}

function contextFor(store: WorkIntelligenceStore, root: string, task: string): ContextResult {
  const result = store.getContext(root, { task });
  if (result.outcome !== "context") throw new Error("Expected focused synthetic context.");
  if (!result.relevant) throw new Error("Expected focused context to include relevant results.");
  return result;
}

function directRecallIds(
  store: WorkIntelligenceStore,
  root: string,
  task: string,
  type: "session" | "knowledge",
): string[] {
  const result = store.recall({ projectRoot: root, q: task, limit: 20 });
  if (result.outcome !== "recall") throw new Error("Expected synthetic recall results.");
  return result.hits
    .filter((hit) => hit.type === type)
    .slice(0, 5)
    .map((hit) => hit.id);
}

function expectDirectListsKeepRecallOrder(
  context: ContextResult,
  sessionRecallIds: string[],
  knowledgeRecallIds: string[],
): void {
  const relevant = context.relevant;
  if (!relevant) throw new Error("Expected focused context to include relevant results.");
  expect(relevant.sessions.map((hit) => hit.id)).toEqual(sessionRecallIds.slice(0, relevant.sessions.length));
  expect(relevant.knowledge.map((hit) => hit.id)).toEqual(knowledgeRecallIds.slice(0, relevant.knowledge.length));
}

describe("task-aware context supplements", () => {
  it("adds compact one-hop related Session and applied Knowledge pointers with trust flags", () => {
    const { root, store } = createTrackedProject();
    const knowledgeId = recordKnowledge(
      store,
      root,
      "d1-supplement-trust-knowledge",
      "Pattern: ceramic nozzle recovery",
      "Reverse the nozzle before flushing ceramic residue from the line.",
      { appliesTo: ["src/ceramic-line.ts"] },
    );
    const related = finalizeSession(
      store,
      root,
      "d1-related",
      "Workshop packing checklist",
      "A fictional record of tools returned to storage.",
    );
    const source = finalizeSession(
      store,
      root,
      "d1-task-source",
      "Opal flow calibration task",
      "The opal flow calibration task verified the pressure return sequence.",
      {
        relatedSessionIds: [related.id],
        appliedKnowledgeIds: [knowledgeId],
        completedAt: "2030-01-01T00:00:00.000Z",
      },
    );
    finalizeSession(store, root, "d1-later-contradiction", "Routine line check", "A fictional follow-up check.", {
      contradictedKnowledgeIds: [knowledgeId],
      changedFiles: ["src/ceramic-line.ts"],
      completedAt: "2030-01-02T00:00:00.000Z",
    });

    const context = contextFor(store, root, "opal flow calibration");
    const supplements = context.relevant!.supplements ?? [];
    const sessionSupplement = supplements.find((item) => item.id === related.id);
    const knowledgeSupplement = supplements.find((item) => item.id === knowledgeId);

    expect(context.relevant!.sessions.map((hit) => hit.id)).toContain(source.id);
    expect(sessionSupplement).toEqual({
      type: "session",
      id: related.id,
      title: "Workshop packing checklist",
      includedBecause: { kind: "related_session", sourceSessionId: source.id, relation: "related" },
    });
    expect(knowledgeSupplement).toMatchObject({
      type: "knowledge",
      id: knowledgeId,
      title: "Pattern: ceramic nozzle recovery",
      includedBecause: { kind: "applied_knowledge", sourceSessionId: source.id },
      possiblyStale: true,
      needsReview: true,
    });
    expect(Object.keys(knowledgeSupplement ?? {}).sort()).toEqual(
      ["id", "includedBecause", "needsReview", "possiblyStale", "title", "type"].sort(),
    );
    expect(JSON.stringify(supplements)).not.toMatch(/excerpt|score|openItems/);
    expect(supplements.length).toBeLessThanOrEqual(4);
  });

  it("adds a direct parent Session pointer when its wording does not match the task", () => {
    const { root, store } = createTrackedProject();
    const parent = finalizeSession(
      store,
      root,
      "d1-live-parent",
      "Archive shelf maintenance record",
      "A fictional parent record with unrelated wording.",
    );
    const source = finalizeSession(
      store,
      root,
      "d1-live-parent-source",
      "Jade relay alignment task",
      "The jade relay alignment task completed its fictional checks.",
      { parentSessionId: parent.id },
    );

    const context = contextFor(store, root, "jade relay alignment");

    expect(context.relevant!.sessions.map((hit) => hit.id)).toContain(source.id);
    expect(context.relevant!.supplements).toContainEqual({
      type: "session",
      id: parent.id,
      title: "Archive shelf maintenance record",
      includedBecause: { kind: "related_session", sourceSessionId: source.id, relation: "parent" },
    });
  });

  it("keeps direct Session and Knowledge hits in the same order under a tight response budget", () => {
    const { root, store } = createTrackedProject();
    const omittedDirect = finalizeSession(
      store,
      root,
      "d1-tight-direct-target",
      "Quartz calibration task reference",
      `The quartz calibration task reference was checked. ${LONG_DECISION}`,
      { decisions: [LONG_DECISION, LONG_DECISION, LONG_DECISION] },
    );
    const appliedKnowledgeIds = [0, 1, 2, 3].map((index) =>
      recordKnowledge(
        store,
        root,
        `d1-tight-applied-${index}`,
        `Pattern: iridium fastener ${index}`,
        "A fictional fastener is stored with its matching tool.",
      ),
    );
    const source = finalizeSession(
      store,
      root,
      "d1-tight-source",
      "Quartz relay alignment calibration task",
      `The quartz relay alignment calibration task passed. ${LONG_DECISION}`,
      {
        relatedSessionIds: [omittedDirect.id],
        appliedKnowledgeIds,
        decisions: [LONG_DECISION, LONG_DECISION],
        completedAt: "2030-01-07T00:00:00.000Z",
      },
    );
    for (let index = 0; index < 3; index += 1) {
      finalizeSession(
        store,
        root,
        `d1-tight-filler-${index}`,
        `Quartz relay alignment calibration check ${index} ${LONG_TITLE}`,
        `The quartz relay alignment calibration check ${index} passed. ${LONG_DECISION}`,
        { decisions: [LONG_DECISION, LONG_DECISION], completedAt: `2030-01-0${index + 3}T00:00:00.000Z` },
      );
    }
    for (let index = 0; index < 5; index += 1) {
      recordKnowledge(
        store,
        root,
        `d1-tight-direct-knowledge-${index}`,
        `Pattern: quartz relay alignment calibration ${index} ${LONG_TITLE.repeat(2)}`,
        `The quartz relay alignment calibration pattern ${index} documents a fictional sequence. ${LONG_DECISION.repeat(2)}`,
      );
    }
    for (let index = 0; index < 12; index += 1) {
      recordKnowledge(
        store,
        root,
        `d1-tight-recent-noise-${index}`,
        `Pattern: unrelated recent fixture ${index}`,
        "A newer fictional fixture that does not match the focused task.",
      );
    }

    const task = "quartz relay alignment calibration";
    const expectedSessionIds = directRecallIds(store, root, task, "session");
    const expectedKnowledgeIds = directRecallIds(store, root, task, "knowledge");
    const context = contextFor(store, root, task);
    const omittedSessions = context.omitted?.find((item) => item.section === "relevant.sessions");
    const omittedSupplements = context.omitted?.find((item) => item.section === "relevant.supplements");

    expectDirectListsKeepRecallOrder(context, expectedSessionIds, expectedKnowledgeIds);
    expect(context.relevant!.sessions.map((hit) => hit.id)).toContain(source.id);
    expect(JSON.stringify(omittedSessions)).toContain(omittedDirect.id);
    expect(context.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(omittedDirect.id);
    expect(omittedSupplements).toBeDefined();
    expect(omittedSupplements!.count).toBeGreaterThan(0);
    expect(omittedSupplements!.reasons).toEqual(expect.arrayContaining([expect.stringContaining("預算")]));
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(9_800);
    expect(context.relevant!.sessions.map((hit) => hit.id)).not.toContain(omittedDirect.id);
    expect(expectedSessionIds).toContain(omittedDirect.id);
  });

  it("does not duplicate a Session already present in the direct relevant list", () => {
    const { root, store } = createTrackedProject();
    const related = finalizeSession(
      store,
      root,
      "d1-direct-related",
      "Amethyst valve recovery task",
      "A direct fixture for the same task.",
    );
    const source = finalizeSession(
      store,
      root,
      "d1-direct-source",
      "Amethyst valve recovery task procedure",
      "The amethyst valve recovery task procedure was verified.",
      { relatedSessionIds: [related.id] },
    );

    const context = contextFor(store, root, "amethyst valve recovery");
    expect(context.relevant!.sessions.map((hit) => hit.id)).toContain(source.id);
    expect(context.relevant!.sessions.map((hit) => hit.id)).toContain(related.id);
    expect(context.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(related.id);
  });

  it("excludes archived or superseded Knowledge and voided Sessions and sources", () => {
    const { root, store } = createTrackedProject();
    const archivedKnowledgeId = recordKnowledge(
      store,
      root,
      "d1-archived-knowledge",
      "Pattern: stored amber valve",
      "Keep the fictional valve in a labeled container.",
    );
    const supersededKnowledgeId = recordKnowledge(
      store,
      root,
      "d1-superseded-knowledge",
      "Pattern: old violet seal",
      "The old seal uses a fictional adhesive.",
    );
    const voidedLinked = finalizeSession(
      store,
      root,
      "d1-voided-linked",
      "Old inspection record",
      "A fictional old inspection.",
    );
    const liveSource = finalizeSession(
      store,
      root,
      "d1-exclusion-source",
      "Hazel engine check",
      "The hazel engine check inspected only fictional parts.",
      {
        parentSessionId: voidedLinked.id,
        appliedKnowledgeIds: [archivedKnowledgeId, supersededKnowledgeId],
      },
    );
    store.updateKnowledge({ projectRoot: root, knowledgeId: archivedKnowledgeId, status: "archived" });
    recordKnowledge(
      store,
      root,
      "d1-replacement-knowledge",
      "Pattern: current violet seal",
      "The replacement seal uses a fictional clamp.",
      { supersedesId: supersededKnowledgeId },
    );
    store.setSessionVoid({ sessionId: voidedLinked.id, voided: true, reason: "Synthetic void fixture." });

    const voidedSourceKnowledgeId = recordKnowledge(
      store,
      root,
      "d1-voided-source-knowledge",
      "Pattern: plum fastener",
      "A fictional latch turns once before release.",
    );
    const voidedSource = finalizeSession(
      store,
      root,
      "d1-voided-source-session",
      "Lilac compressor inspection",
      "The lilac compressor inspection checked a fictional latch.",
      { appliedKnowledgeIds: [voidedSourceKnowledgeId] },
    );
    store.setSessionVoid({ sessionId: voidedSource.id, voided: true, reason: "Synthetic void fixture." });

    const liveContext = contextFor(store, root, "hazel engine check");
    expect(liveContext.relevant!.sessions.map((hit) => hit.id)).toContain(liveSource.id);
    expect(liveContext.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(voidedLinked.id);
    expect(liveContext.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(archivedKnowledgeId);
    expect(liveContext.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(supersededKnowledgeId);

    const voidedSourceContext = contextFor(store, root, "lilac compressor inspection");
    expect(voidedSourceContext.relevant!.sessions.map((hit) => hit.id)).not.toContain(voidedSource.id);
    expect(voidedSourceContext.relevant!.supplements?.map((item) => item.id) ?? []).not.toContain(
      voidedSourceKnowledgeId,
    );
  });

  it("does not produce supplements without task or paths", () => {
    const { root, store } = createTrackedProject();
    const knowledgeId = recordKnowledge(
      store,
      root,
      "d1-no-focus-knowledge",
      "Pattern: indigo fastening",
      "Use a fictional hand tool.",
    );
    const parent = finalizeSession(
      store,
      root,
      "d1-no-focus-parent",
      "Archive shelf notes",
      "A fictional parent record.",
    );
    finalizeSession(store, root, "d1-no-focus-source", "Jade index task", "The jade index task was completed.", {
      parentSessionId: parent.id,
      appliedKnowledgeIds: [knowledgeId],
    });

    const context = store.getContext(root);
    if (context.outcome !== "context") throw new Error("Expected un-focused synthetic context.");
    expect(context.relevant).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("supplements");
  });
});
