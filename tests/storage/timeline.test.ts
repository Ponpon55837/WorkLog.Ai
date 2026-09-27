import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-timeline-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-20T12:00:00.000Z"));
  const finalize = (key: string, overrides: Partial<FinalizeSessionInput>) => {
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
  return { store, root, project, finalize };
}

describe("timeline", () => {
  it("returns overlapping Sessions, links between them, and Knowledge events in the range", () => {
    const { store, root, finalize } = setup();
    const spanning = finalize("spanning", {
      startedAt: "2031-02-27T09:00:00.000Z",
      completedAt: "2031-03-02T09:00:00.000Z",
    });
    const follow = finalize("follow", {
      completedAt: "2031-03-10T09:00:00.000Z",
      parentSessionId: spanning,
      verification: { status: "failed" },
    });
    finalize("outside", { completedAt: "2031-01-10T09:00:00.000Z" });
    const voided = finalize("voided", { completedAt: "2031-03-11T09:00:00.000Z" });
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });

    const old = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "old",
      kind: "gotcha",
      title: "Old hive rule",
      body: "Old.",
    });
    if (old.outcome !== "knowledge_recorded") throw new Error("Expected knowledge");
    finalize("contradicts", {
      completedAt: "2031-03-12T09:00:00.000Z",
      contradictedKnowledgeIds: [old.knowledge.id],
    });
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "new",
      kind: "gotcha",
      title: "New hive rule",
      body: "New.",
      supersedesId: old.knowledge.id,
    });

    const result = store.getTimeline({ projectRoot: root, from: "2031-03-01", to: "2031-03-20" });
    if (result.outcome !== "timeline") throw new Error("Expected timeline");
    expect(result.sessions.map((session) => session.title)).toEqual([
      "Session contradicts",
      "Session follow",
      "Session spanning",
    ]);
    expect(result.sessions.find((session) => session.id === spanning)?.startedAt).toBe("2031-02-27T09:00:00.000Z");
    expect(result.sessions.find((session) => session.id === follow)).toMatchObject({ verificationStatus: "failed" });
    expect(result.links).toEqual([{ sessionId: follow, relatedSessionId: spanning, relation: "continues" }]);
    expect(result.knowledgeEvents.map((event) => [event.title, event.kind])).toEqual(
      expect.arrayContaining([
        ["Old hive rule", "created"],
        ["Old hive rule", "contradicted"],
        ["Old hive rule", "superseded"],
        ["New hive rule", "created"],
      ]),
    );
    expect(result.truncated).toBe(false);
  });

  it("defaults to the last 30 days and skips projects that are not tracked", () => {
    const { store, root, project, finalize } = setup();
    finalize("recent", { completedAt: "2031-03-19T09:00:00.000Z" });
    const result = store.getTimeline({ projectRoot: root });
    expect(result).toMatchObject({ outcome: "timeline", from: "2031-02-19", to: "2031-03-20" });

    store.updateProject(project.id, { status: "paused" });
    expect(store.getTimeline({ projectRoot: root })).toMatchObject({ outcome: "skipped" });
    expect(store.getTimeline({})).toMatchObject({ outcome: "timeline", projects: [], sessions: [] });
  });
});
