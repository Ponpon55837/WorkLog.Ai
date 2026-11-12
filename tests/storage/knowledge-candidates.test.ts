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

function recorded(store: WorkIntelligenceStore, root: string, key: string, title: string, body = `${title}.`): string {
  const result = store.recordKnowledge({ projectRoot: root, idempotencyKey: key, kind: "gotcha", title, body });
  if (result.outcome !== "knowledge_recorded") throw new Error("Expected recorded Knowledge");
  return result.knowledge.id;
}

function openRequest(store: WorkIntelligenceStore, root: string): string {
  const result = store.requestKnowledgeCandidates(root);
  if (result.outcome !== "knowledge_candidate_request") throw new Error("Expected a candidate request");
  return result.request.id;
}

function submitted(store: WorkIntelligenceStore, requestId: string, candidates: KnowledgeCandidateInput[]) {
  const result = store.submitKnowledgeCandidates({ requestId, candidates });
  if (result.outcome !== "knowledge_candidates_submitted") throw new Error("Expected submitted candidates");
  return result.candidates;
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

    const token = `ghs_${"U".repeat(36)}`;
    expect(
      store.submitKnowledgeCandidates({ requestId: request.request.id, candidates: [candidate("elsewhere", "Bad")] }),
    ).toMatchObject({ outcome: "invalid_candidates" });
    const submitted = store.submitKnowledgeCandidates({
      requestId: request.request.id,
      candidates: [candidate(first, `Sprinkler lease ${token}`), candidate(second, "Not reusable")],
    });
    if (submitted.outcome !== "knowledge_candidates_submitted") {
      throw new Error("Expected submission");
    }
    expect(submitted.redactions).toMatchObject({ total: 2 });
    expect(JSON.stringify(submitted.candidates)).not.toContain(token);
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

  it("lists archived Knowledge and rejected candidates in the context and leaves scope and verification to reads", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    const active = recorded(store, root, "active", "Meadow gate opens inward");
    const archived = recorded(store, root, "archived", "Meadow pump needs priming");
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived, status: "archived" });
    const firstRequest = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: firstRequest });
    const rejected = submitted(store, firstRequest, [candidate(first, "Meadow fence posts lean north")])[0]!;
    store.decideKnowledgeCandidate({ candidateId: rejected.id, decision: "reject" });

    finalize("second");
    const context = store.getKnowledgeCandidateContext({ requestId: openRequest(store, root) });
    if (context.outcome !== "knowledge_candidate_context") throw new Error("Expected candidate context");
    expect(context.existingKnowledge).toEqual([
      { id: active, kind: "gotcha", title: "Meadow gate opens inward" },
      { id: archived, kind: "gotcha", title: "Meadow pump needs priming", status: "archived" },
      { id: rejected.id, kind: "gotcha", title: "Meadow fence posts lean north", status: "rejected" },
    ]);
    expect(context).not.toHaveProperty("existingKnowledgeOmitted");
    expect(context).toMatchObject({
      omittedWorkSummarySections: ["scope", "verification"],
      sessionReadWith: "work_get_session",
    });
    expect(Object.keys(context.sessions[0]!.workSummary ?? {})).toEqual(["outcomes", "decisions", "nextSteps"]);
  });

  it("flags submitted candidates that overlap the project's Knowledge or earlier candidates, advisory only", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    const active = recorded(
      store,
      root,
      "dup-active",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error after one hour.",
    );
    const archived = recorded(
      store,
      root,
      "dup-archived",
      "Valve timer drifts after restart",
      "The valve timer drifts by a minute after each controller restart.",
    );
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived, status: "archived" });
    const firstRequest = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: firstRequest });
    const rejected = submitted(store, firstRequest, [
      { ...candidate(first, "Hose reel jams when wet"), body: "The hose reel jams when its spool is wet." },
    ])[0]!;
    store.decideKnowledgeCandidate({ candidateId: rejected.id, decision: "reject" });

    const second = finalize("second");
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const result = submitted(store, request, [
      {
        ...candidate(second, "Sprinkler lease expires silently after an hour"),
        body: "The sprinkler lease expires without an error.",
      },
      {
        ...candidate(second, "Valve timer drifts after a restart"),
        body: "The valve timer drifts after a controller restart.",
      },
      { ...candidate(second, "Hose reel jams when the spool is wet"), body: "The hose reel jams when wet." },
      { ...candidate(second, "Compost bin lid warps in sun"), body: "Direct sunlight warps the compost bin lid." },
    ]);
    expect(
      result.map((item) => item.overlaps?.map(({ relation, type, id, status }) => ({ relation, type, id, status }))),
    ).toEqual([
      [{ relation: "possible_duplicate", type: "knowledge", id: active, status: "active" }],
      [{ relation: "overlaps_archived", type: "knowledge", id: archived, status: "archived" }],
      [{ relation: "overlaps_rejected", type: "candidate", id: rejected.id, status: "rejected" }],
      undefined,
    ]);
    expect(result[0]!.overlaps![0]!.score).toBeGreaterThanOrEqual(0.3);
    expect(result.every((item) => item.status === "proposed")).toBe(true);
    // Advisory only: nothing existing changed.
    expect(store.searchKnowledge({ projectRoot: root, status: "active" })).toMatchObject({ items: [{ id: active }] });
    expect(store.listKnowledgeCandidates({ projectRoot: root, status: "rejected" })).toMatchObject({
      items: [{ id: rejected.id }],
    });
  });

  it("never compares candidates across projects", () => {
    const { store, root, finalize, candidate } = setup();
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-candidates-other-"));
    tempDirs.push(otherRoot);
    const other = store.addProject("Orchard", otherRoot);
    store.updateProject(other.id, { status: "tracked" });
    recorded(
      store,
      otherRoot,
      "other-dup",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error.",
    );
    const first = finalize("first");
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const context = store.getKnowledgeCandidateContext({ requestId: request });
    expect(context.outcome === "knowledge_candidate_context" && context.existingKnowledge).toEqual([]);
    const result = submitted(store, request, [
      {
        ...candidate(first, "Sprinkler lease expires silently"),
        body: "The sprinkler lease expires without an error.",
      },
    ]);
    expect(result[0]).not.toHaveProperty("overlaps");
  });

  it("returns the stored candidates and the same advisories when the same payload is submitted again", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    recorded(
      store,
      root,
      "replay-active",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error.",
    );
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const payload = [
      {
        ...candidate(first, "  Sprinkler lease expires silently  "),
        body: "The sprinkler lease expires without an error.",
      },
      candidate(first, "Compost bin lid warps in sun"),
    ];
    const once = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    const again = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    if (once.outcome !== "knowledge_candidates_submitted" || again.outcome !== "knowledge_candidates_submitted")
      throw new Error("Expected both submissions to return the candidates.");
    expect(again.duplicate).toBe(true);
    expect(again.candidates).toEqual(once.candidates);
    expect(once.candidates[0]!.overlaps).toHaveLength(1);
    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({ items: { length: 2 } });
    expect(
      store.submitKnowledgeCandidates({ requestId: request, candidates: [candidate(first, "A different payload")] }),
    ).toMatchObject({ outcome: "request_not_open" });
  });
});
