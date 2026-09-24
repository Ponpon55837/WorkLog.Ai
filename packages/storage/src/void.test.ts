import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput } from "@work-intelligence/core";
import { WorkIntelligenceStore } from "./store.js";

// Fictional fixtures only.
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-void-test-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Void project", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, overrides: Partial<FinalizeSessionInput> = {}) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `Beehive ${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [`Decision ${key}.`], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "not_run" },
      ...overrides,
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result.session.id;
  };
  return { store, root, projectId: project.id, finalize };
}

describe("voiding Sessions", () => {
  it("hides a voided Session everywhere except its own detail, and restores it", () => {
    const { store, root, finalize } = setup();
    const kept = finalize("kept");
    const mistake = finalize("mistake");

    const voided = store.setSessionVoid({ sessionId: mistake, voided: true, reason: "Recorded as a test." });
    expect(voided).toMatchObject({
      outcome: "session_void_updated",
      duplicate: false,
      session: { id: mistake, voided: { reason: "Recorded as a test." } },
    });

    expect(store.listSessions().map((session) => session.id)).toEqual([kept]);
    expect(store.listSessions({ voided: "only" }).map((session) => session.id)).toEqual([mistake]);
    expect(store.listSessions({ voided: "include" })).toHaveLength(2);
    expect(store.getDashboardSummary().finalizedSessions).toBe(1);

    const report = store.getReport({ period: "week" });
    expect(report.outcome === "report" && report.sessions.map((session) => session.id)).toEqual([kept]);

    const graph = store.getGraph({});
    expect(graph.outcome === "graph" && graph.nodes.some((node) => node.sessionId === mistake)).toBe(false);

    const context = store.getContext(root);
    if (context.outcome !== "context") {
      throw new Error("Expected context");
    }
    expect(context.recentSessions.map((session) => session.id)).toEqual([kept]);
    expect(context.recentDecisions.map((decision) => decision.sessionId)).toEqual([kept]);
    expect(context.metadataFollowUps.needsBackfill).toBe(1);

    const recall = store.recall({ q: "beehive mistake" });
    expect(recall.outcome === "recall" && recall.hits.map((hit) => hit.id)).not.toContain(mistake);

    const detail = store.getSessionDetail(mistake);
    expect(detail?.session.voided?.reason).toBe("Recorded as a test.");
    expect(detail?.voidHistory).toEqual([
      expect.objectContaining({ targetType: "session", action: "voided", reason: "Recorded as a test." }),
    ]);

    expect(store.setSessionVoid({ sessionId: mistake, voided: true, reason: "Again." })).toMatchObject({
      duplicate: true,
      session: { voided: { reason: "Recorded as a test." } },
    });

    const restored = store.setSessionVoid({ sessionId: mistake, voided: false });
    expect(restored).toMatchObject({ outcome: "session_void_updated", duplicate: false });
    expect(restored.outcome === "session_void_updated" && restored.session.voided).toBeUndefined();
    expect(store.listSessions()).toHaveLength(2);
    const afterRestore = store.recall({ q: "beehive mistake" });
    expect(afterRestore.outcome === "recall" && afterRestore.hits.map((hit) => hit.id)).toContain(mistake);
    expect(store.getSessionDetail(mistake)?.voidHistory.map((entry) => entry.action)).toEqual(["restored", "voided"]);
  });

  it("requires a reason, reports missing Sessions, and respects the project policy", () => {
    const { store, projectId, finalize } = setup();
    const sessionId = finalize("policy");

    expect(() => store.setSessionVoid({ sessionId, voided: true, reason: "  " })).toThrow(/reason/);
    expect(store.setSessionVoid({ sessionId: "missing", voided: true, reason: "x" })).toEqual({
      outcome: "not_found",
      sessionId: "missing",
    });
    store.updateProject(projectId, { status: "paused" });
    expect(store.setSessionVoid({ sessionId, voided: true, reason: "x" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });
});

describe("voiding evidence", () => {
  it("keeps voided evidence in detail but drops it from reports and the graph", () => {
    const { store, finalize } = setup();
    const sessionId = finalize("evidence");
    const attached = store.attachEvidence({
      sessionId,
      kind: "test-result",
      reference: "hive-tests.log",
      summary: "Wrong log attached.",
    });
    if (attached.outcome !== "evidence_attached") {
      throw new Error("Expected evidence");
    }
    const evidenceId = attached.evidence.id;

    const countAttached = () => {
      const report = store.getReport({ period: "week", includeAllEvidence: true });
      return report.outcome === "report"
        ? report.evidence.filter((item) => item.reference === "hive-tests.log").length
        : -1;
    };
    const graphHasEvidence = () => {
      const graph = store.getGraph({});
      return graph.outcome === "graph" && graph.nodes.some((node) => node.kind === "evidence");
    };
    expect(countAttached()).toBe(1);
    expect(graphHasEvidence()).toBe(true);

    expect(store.setEvidenceVoid({ evidenceId, voided: true, reason: "Belongs to another run." })).toMatchObject({
      outcome: "evidence_void_updated",
      duplicate: false,
      evidence: { id: evidenceId, voided: { reason: "Belongs to another run." } },
    });
    expect(countAttached()).toBe(0);
    expect(graphHasEvidence()).toBe(false);
    const detail = store.getSessionDetail(sessionId);
    expect(detail?.evidence[0]?.voided?.reason).toBe("Belongs to another run.");
    expect(detail?.voidHistory[0]).toMatchObject({ targetType: "evidence", targetId: evidenceId });

    store.setEvidenceVoid({ evidenceId, voided: false });
    expect(countAttached()).toBe(1);
    expect(store.setEvidenceVoid({ evidenceId: "missing", voided: false })).toEqual({
      outcome: "not_found",
      evidenceId: "missing",
    });
  });
});
