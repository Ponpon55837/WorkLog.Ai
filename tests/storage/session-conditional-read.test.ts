import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionAgentReadResult } from "../../packages/core/src/index.js";
import { sessionDetailQuerySchema } from "../../packages/schema/src/index.js";
import { extractAgentReadRecords } from "../../packages/storage/src/agent-read-audit-service.js";
import { sameSessionRevision } from "../../packages/storage/src/session-agent-read-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const cleanup: Array<() => void> = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wi-conditional-read-"));
  const store = new WorkIntelligenceStore(":memory:");
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.addProject("Synthetic Juniper", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, projectId: project.id };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  extra: Partial<Parameters<WorkIntelligenceStore["finalizeSession"]>[0]> = {},
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Fictional ${key}`,
    summary: `Fictional summary for ${key}.`,
    workSummary: {
      outcomes: ["Fictional outcome"],
      scope: ["src/fiction.ts"],
      decisions: [{ text: "Keep the fictional cache", origin: "agent_autonomous" }],
      verification: ["Fictional checks passed"],
      nextSteps: [],
    },
    changedFiles: ["src/fiction.ts"],
    verification: { status: "passed" },
    handoffContent: `Fictional handoff for ${key}.`,
    ...extra,
  });
  if (result.outcome !== "finalized") throw new Error("Fixture failed");
  return result.session;
}

function revisionOf(result: SessionAgentReadResult): string {
  if (result.outcome !== "session_detail" && result.outcome !== "session_unchanged")
    throw new Error(`Expected a Session, got ${result.outcome}`);
  return result.session.revision;
}

function revision(store: WorkIntelligenceStore, sessionId: string): string {
  return revisionOf(store.getSessionDetailForAgent({ sessionId }));
}

/** Reads with the held revision, expects the full body with a new revision, and returns it. */
function expectChanged(store: WorkIntelligenceStore, sessionId: string, known: string): string {
  const result = store.getSessionDetailForAgent({ sessionId, knownRevision: known });
  expect(result.outcome).toBe("session_detail");
  const next = revisionOf(result);
  expect(next).not.toBe(known);
  expect(store.getSessionDetailForAgent({ sessionId, knownRevision: next }).outcome).toBe("session_unchanged");
  return next;
}

afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

describe("work_get_session knownRevision", () => {
  it("returns only identity when the held revision still matches", () => {
    const { store, root } = setup();
    const session = finalize(store, root, "unchanged");
    const known = revision(store, session.id);
    expect(known).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: known })).toEqual({
      outcome: "session_unchanged",
      session: { id: session.id, projectId: session.projectId, title: session.title, revision: known },
    });
    expect(store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: "A".repeat(16) })).toMatchObject({
      outcome: "session_detail",
      session: { id: session.id, summary: session.summary, revision: known },
    });
  });

  it("keeps one revision per state across full, raw and projected reads; view and select apply only to a body", () => {
    const { store, root } = setup();
    const session = finalize(store, root, "projection");
    const known = revision(store, session.id);
    const raw = store.getSessionDetailForAgent({ sessionId: session.id, includeRawSnapshots: true });
    expect(raw).toMatchObject({ rawSnapshots: [{ content: "Fictional handoff for projection." }] });
    expect(revisionOf(raw)).toBe(known);
    for (const query of [{ view: "handoff" as const }, { select: ["session.summary" as const] }]) {
      expect(revisionOf(store.getSessionDetailForAgent({ sessionId: session.id, ...query }))).toBe(known);
      expect(store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: known, ...query }).outcome).toBe(
        "session_unchanged",
      );
    }
    const projected = store.getSessionDetailForAgent({
      sessionId: session.id,
      knownRevision: "B".repeat(16),
      select: ["session.summary"],
    });
    expect(projected).toMatchObject({
      outcome: "session_detail",
      projection: { includedFields: ["session.summary"] },
      session: { revision: known, summary: session.summary },
    });
    expect(projected).not.toHaveProperty("events");
  });

  it("keeps not_found and skipped unchanged without revealing a revision", () => {
    const { store, root, projectId } = setup();
    const session = finalize(store, root, "policy");
    const known = revision(store, session.id);
    for (const query of [{}, { view: "handoff" as const }])
      expect(store.getSessionDetailForAgent({ sessionId: "missing", knownRevision: known, ...query })).toEqual({
        outcome: "not_found",
        sessionId: "missing",
        reason: "Session does not exist.",
      });
    store.updateProject(projectId, { status: "paused" });
    for (const query of [{}, { view: "completion" as const }]) {
      const skipped = store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: known, ...query });
      expect(skipped).toMatchObject({ outcome: "skipped", sessionId: session.id, projectStatus: "paused" });
      expect(JSON.stringify(skipped)).not.toContain(known);
    }
  });

  it("rejects a revision of the wrong length or charset and compares equal lengths only", () => {
    for (const knownRevision of ["", "short", "A".repeat(15), "A".repeat(17), "abcdefghijklmno=", "abcdefghijklmn/+"])
      expect(sessionDetailQuerySchema.safeParse({ sessionId: "synthetic", knownRevision }).success).toBe(false);
    const { store, root } = setup();
    const session = finalize(store, root, "invalid");
    expect(() => store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: "nope" })).toThrow();
    expect(() =>
      store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: "nope", view: "handoff" }),
    ).toThrow();
    expect(sameSessionRevision(undefined, "A".repeat(16))).toBe(false);
    expect(sameSessionRevision("A".repeat(15), "A".repeat(16))).toBe(false);
    expect(sameSessionRevision("A".repeat(16), "A".repeat(16))).toBe(true);
  });

  it("reports void state in the unchanged identity", () => {
    const { store, root } = setup();
    const session = finalize(store, root, "voided");
    const known = revision(store, session.id);
    store.setSessionVoid({ sessionId: session.id, voided: true, reason: "Fictional duplicate." });
    const voided = expectChanged(store, session.id, known);
    expect(store.getSessionDetailForAgent({ sessionId: session.id, knownRevision: voided })).toMatchObject({
      outcome: "session_unchanged",
      session: { voided: { reason: "Fictional duplicate." } },
    });
  });

  it("returns the body after any change the detail shows, including changes made through other records", () => {
    const { store, root } = setup();
    const session = finalize(store, root, "subject");
    const other = finalize(store, root, "other");
    const id = session.id;
    let known = revision(store, id);
    const step = (mutate: () => unknown) => {
      mutate();
      known = expectChanged(store, id, known);
    };

    step(() =>
      store.updateSessionSummary({ sessionId: id, idempotencyKey: "summary", summary: "Fictional revision." }),
    );
    step(() => store.linkSessions({ sessionId: other.id, relatedSessionId: id, relation: "related", linked: true }));
    step(() => store.updateSessionTitle({ sessionId: other.id, title: "Fictional renamed neighbour" }));
    let diagramId = "";
    step(() => {
      const attached = store.attachDiagram({
        sessionId: id,
        idempotencyKey: "diagram",
        title: "Fictional flow",
        kind: "architecture",
        formatVersion: 1,
        source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }] }),
      });
      if (attached.outcome === "diagram_attached") diagramId = attached.diagram.id;
    });
    step(() => store.setDiagramVoid({ diagramId, voided: true, reason: "Fictional outdated flow." }));
    step(() => store.setDiagramVoid({ diagramId, voided: false }));
    const decisions = store.listSessionDecisions({ projectRoot: root, status: "all" });
    const decisionId =
      decisions.outcome === "session_decisions"
        ? decisions.items.find((decision) => decision.sessionId === id)?.id
        : undefined;
    if (!decisionId) throw new Error("Expected a fictional decision");
    step(() => store.reviewSessionDecision({ decisionId, projectRoot: root, reviewStatus: "confirmed" }));
    let knowledgeId = "";
    step(() => {
      const recorded = store.recordKnowledge({
        projectRoot: root,
        sessionId: id,
        idempotencyKey: "fictional-gotcha",
        kind: "gotcha",
        title: "Fictional gotcha",
        body: "Fictional body",
        appliesTo: ["src/fiction.ts"],
      });
      if (recorded.outcome === "knowledge_recorded") knowledgeId = recorded.knowledge.id;
    });
    if (!knowledgeId) throw new Error("Expected fictional Knowledge");
    // Feedback from another Session changes only the derived Knowledge trust shown in this detail.
    step(() => finalize(store, root, "confirming", { appliedKnowledgeIds: [knowledgeId] }));
  });

  it("is audited as session_unchanged with the Session id", () => {
    const { store, root } = setup();
    const session = finalize(store, root, "audit");
    const unchanged = store.getSessionDetailForAgent({
      sessionId: session.id,
      knownRevision: revision(store, session.id),
    });
    expect(extractAgentReadRecords(unchanged)).toEqual({
      projectId: session.projectId,
      sessionIds: [session.id],
      knowledgeIds: [],
    });
  });
});
