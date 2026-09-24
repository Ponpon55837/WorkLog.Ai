import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCandidateInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-candidates-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Meadow", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, handoffContent?: string) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [`Decided ${key}.`], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      ...(handoffContent ? { handoffContent } : {}),
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result.session.id;
  };
  const candidate = (sourceSessionId: string, title: string): KnowledgeCandidateInput => ({
    sourceSessionId,
    kind: "gotcha",
    title,
    body: `${title} body.`,
    appliesTo: ["src/meadow/**"],
    rationale: "The handoff describes the failure and its fix.",
  });
  return { store, root, projectId: project.id, finalize, candidate };
}

describe("Knowledge candidates", () => {
  it("proposes candidates from uncovered Sessions and records only accepted ones as Knowledge", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first", "# Handoff\n## Gotcha\nThe sprinkler lease expired silently.");
    const second = finalize("second");

    const request = store.requestKnowledgeCandidates(root);
    if (request.outcome !== "knowledge_candidate_request") {
      throw new Error("Expected request");
    }
    expect(request.request.sourceSessionIds.sort()).toEqual([first, second].sort());
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({
      duplicate: true,
      request: { id: request.request.id },
    });
    const context = store.getContext(root);
    expect(context.outcome === "context" && context.pendingRequests.knowledgeCandidates).toHaveLength(1);

    const candidateContext = store.getKnowledgeCandidateContext({ projectRoot: root });
    if (candidateContext.outcome !== "knowledge_candidate_context") {
      throw new Error("Expected candidate context");
    }
    expect(candidateContext.request.status).toBe("processing");
    expect(candidateContext.sessions.find((session) => session.id === first)?.handoff).toContain("sprinkler lease");

    expect(
      store.submitKnowledgeCandidates({ requestId: request.request.id, candidates: [candidate("elsewhere", "Bad")] }),
    ).toMatchObject({ outcome: "invalid_candidates" });
    const submitted = store.submitKnowledgeCandidates({
      requestId: request.request.id,
      candidates: [candidate(first, "Sprinkler lease expires silently"), candidate(second, "Not reusable")],
    });
    if (submitted.outcome !== "knowledge_candidates_submitted") {
      throw new Error("Expected submission");
    }
    expect(submitted.request).toMatchObject({ status: "completed", candidateCount: 2 });
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({ items: [] });

    const [accept, reject] = submitted.candidates;
    const accepted = store.decideKnowledgeCandidate({
      candidateId: accept!.id,
      decision: "accept",
      edits: { title: "Sprinkler lease expires without an error" },
    });
    expect(accepted).toMatchObject({
      outcome: "knowledge_candidate_decided",
      candidate: { status: "accepted" },
      knowledge: {
        title: "Sprinkler lease expires without an error",
        sessionId: first,
        appliesTo: ["src/meadow/**"],
      },
    });
    expect(store.decideKnowledgeCandidate({ candidateId: reject!.id, decision: "reject" })).toMatchObject({
      candidate: { status: "rejected" },
    });
    expect(store.decideKnowledgeCandidate({ candidateId: accept!.id, decision: "reject" })).toMatchObject({
      outcome: "already_decided",
    });

    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({ items: [], openRequests: [] });
    expect(store.listKnowledgeCandidates({ projectRoot: root, status: "accepted" })).toMatchObject({
      items: [{ id: accept!.id }],
    });
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({ outcome: "knowledge_candidates_not_needed" });

    const third = finalize("third");
    const next = store.requestKnowledgeCandidates(root);
    expect(next.outcome === "knowledge_candidate_request" && next.request.sourceSessionIds).toEqual([third]);
  });

  it("recovers abandoned processing requests and respects the project policy", () => {
    const { store, root, projectId, finalize } = setup();
    finalize("one");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const request = store.requestKnowledgeCandidates(root);
    store.getKnowledgeCandidateContext({ projectRoot: root });
    vi.setSystemTime(Date.UTC(2030, 0, 1, 1));
    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({
      openRequests: [{ status: "failed", failureReason: expect.stringContaining("30 分鐘") }],
    });
    expect(store.getKnowledgeCandidateContext({ projectRoot: root })).toMatchObject({
      outcome: "knowledge_candidate_context",
      request: { status: "processing" },
    });

    store.updateProject(projectId, { status: "paused" });
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({ outcome: "skipped" });
    expect(
      request.outcome === "knowledge_candidate_request" &&
        store.submitKnowledgeCandidates({ requestId: request.request.id, candidates: [] }),
    ).toMatchObject({ outcome: "skipped" });
  });
});
