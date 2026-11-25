import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentReviewRequest,
  AgentReviewVerdict,
  SubmitAgentReviewVerdictsResult,
} from "../../packages/core/src/index.js";
import { replaceSessionDecisions } from "../../packages/storage/src/session-decision-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const BASE_TIME = "2026-10-01T09:00:00.000Z";

interface Fixture {
  store: WorkIntelligenceStore;
  db: DatabaseSync;
  root: string;
  projectId: string;
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function trackedProject(store: WorkIntelligenceStore, name: string): { root: string; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-"));
  tempDirs.push(root);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { root, projectId: project.id };
}

function setup(): Fixture {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return { store, db: (store as unknown as { db: DatabaseSync }).db, ...trackedProject(store, "Orchard") };
}

function finalize(
  fixture: Pick<Fixture, "store" | "root">,
  key: string,
  decisions: string[],
  completedAt = BASE_TIME,
): { sessionId: string; decisionIds: string[] } {
  const result = fixture.store.finalizeSession({
    projectRoot: fixture.root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: `Fictional summary for ${key}.`,
    completedAt,
    workSummary: {
      outcomes: [`Outcome of ${key}`],
      scope: [],
      decisions: decisions.map((text) => ({ text, origin: "agent_autonomous" as const })),
      verification: [],
      nextSteps: [],
    },
    changedFiles: [],
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  const detail = fixture.store.getSessionDetail(result.session.id);
  return { sessionId: result.session.id, decisionIds: (detail?.decisions ?? []).map((decision) => decision.id) };
}

function proposeCandidate(fixture: Fixture, sourceSessionId: string, title: string): string {
  const request = fixture.store.requestKnowledgeCandidates(fixture.root);
  if (request.outcome !== "knowledge_candidate_request") throw new Error("Expected a candidate request.");
  const submitted = fixture.store.submitKnowledgeCandidates({
    requestId: request.request.id,
    candidates: [
      {
        sourceSessionId,
        kind: "gotcha",
        title,
        body: `${title} body.`,
        appliesTo: ["src/orchard/**"],
        rationale: "The handoff describes the failure and its fix.",
      },
    ],
  });
  if (submitted.outcome !== "knowledge_candidates_submitted") throw new Error("Expected submitted candidates.");
  return submitted.candidates[0]!.id;
}

function openReview(fixture: Fixture, key = "review-1"): AgentReviewRequest {
  const result = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: key });
  if (result.outcome !== "agent_review_request") throw new Error(`Expected a request, received ${result.outcome}.`);
  return result.request;
}

function submitted(
  fixture: Fixture,
  requestId: string,
  verdicts: AgentReviewVerdict[],
  key = "submit-1",
  complete?: boolean,
): Extract<SubmitAgentReviewVerdictsResult, { outcome: "agent_review_verdicts_submitted" }> {
  const result = fixture.store.submitAgentReviewVerdicts({
    requestId,
    idempotencyKey: key,
    verdicts,
    ...(complete === undefined ? {} : { complete }),
  });
  if (result.outcome !== "agent_review_verdicts_submitted")
    throw new Error(`Expected a submission, got ${result.outcome}.`);
  return result;
}

function listedRequests(
  fixture: Fixture,
  input: Parameters<WorkIntelligenceStore["listAgentReviewRequests"]>[0] = {},
): AgentReviewRequest[] {
  const result = fixture.store.listAgentReviewRequests(input);
  if (result.outcome !== "agent_review_requests") throw new Error("Expected a request list.");
  return result.requests;
}

function decisionVerdict(
  itemId: string,
  verdict: "confirm" | "reject" | "promote",
  extra: Partial<Extract<AgentReviewVerdict, { itemKind: "decision" }>> = {},
): AgentReviewVerdict {
  return { itemKind: "decision", itemId, verdict, reason: `Fictional reason for ${verdict}.`, ...extra };
}

function promoteDraft(title: string) {
  return { kind: "decision" as const, title, body: `${title} body.` };
}

describe("Agent review requests", () => {
  it("snapshots pending Agent decisions and proposed candidates, and reuses the open request", () => {
    const fixture = setup();
    const { sessionId } = finalize(fixture, "a", ["Use the shared crate cache", "Pin the base image"]);
    proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");

    const created = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" });
    expect(created).toMatchObject({
      outcome: "agent_review_request",
      duplicate: false,
      request: {
        status: "pending",
        itemCount: 3,
        omittedCount: 0,
        decisionCount: 2,
        candidateCount: 1,
        appliedCount: 0,
        skippedCount: 0,
        openCount: 3,
      },
    });

    const sameKey = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" });
    const otherKey = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-2" });
    const web = fixture.store.createAgentReviewRequest({ projectId: fixture.projectId, idempotencyKey: "review-3" });
    for (const result of [sameKey, otherKey, web]) {
      expect(result).toMatchObject({ outcome: "agent_review_request", duplicate: true });
    }
    expect(fixture.store.listAgentReviewRequests({ projectId: fixture.projectId })).toMatchObject({
      outcome: "agent_review_requests",
      requests: [{ itemCount: 3 }],
    });
  });

  it("answers agent_review_not_needed when nothing waits for an Agent", () => {
    const fixture = setup();
    expect(fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" })).toMatchObject({
      outcome: "agent_review_not_needed",
      projectId: fixture.projectId,
    });
    expect(listedRequests(fixture)).toEqual([]);
  });

  it("rejects an idempotency key already used for another project", () => {
    const first = setup();
    finalize(first, "a", ["Keep one lockfile"]);
    openReview(first, "shared-key");
    const other = trackedProject(first.store, "Meadow");
    finalize({ store: first.store, root: other.root }, "b", ["Rename the module"]);
    expect(first.store.requestAgentReview({ projectRoot: other.root, idempotencyKey: "shared-key" })).toEqual({
      outcome: "rejected",
      reason: "idempotency_conflict",
    });
  });

  it("skips untracked projects", () => {
    const fixture = setup();
    fixture.store.updateProject(fixture.projectId, { status: "paused" });
    expect(fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("leaves out decisions of voided Sessions and decisions a person already reviewed", () => {
    const fixture = setup();
    const kept = finalize(fixture, "kept", ["Keep this decision", "Review this by hand"]);
    const voided = finalize(fixture, "voided", ["Voided decision"]);
    fixture.store.reviewSessionDecision({
      decisionId: kept.decisionIds[1]!,
      projectRoot: fixture.root,
      reviewStatus: "confirmed",
    });
    fixture.db.prepare("UPDATE sessions SET voided_at = ? WHERE id = ?").run(BASE_TIME, voided.sessionId);
    const request = openReview(fixture);
    expect(request.itemCount).toBe(1);
    const context = fixture.store.getAgentReviewContext({ requestId: request.id });
    expect(context).toMatchObject({ items: [{ id: kept.decisionIds[0] }] });
  });

  it("persists how many eligible items the 500 item cap left out", () => {
    const fixture = setup();
    const { sessionId } = finalize(fixture, "a", ["Seed decision"]);
    const insert = fixture.db.prepare(
      `INSERT INTO session_decisions (id, session_id, project_id, position, text, origin, review_status)
       VALUES (?, ?, ?, ?, ?, 'agent_autonomous', 'pending')`,
    );
    for (let index = 1; index <= 504; index += 1) {
      insert.run(`bulk-${index}`, sessionId, fixture.projectId, index, `Bulk decision ${index}`);
    }
    const created = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" });
    expect(created).toMatchObject({ duplicate: false, remaining: 5, request: { itemCount: 500, omittedCount: 5 } });
    expect(listedRequests(fixture, { projectId: fixture.projectId })[0]).toMatchObject({
      itemCount: 500,
      omittedCount: 5,
      decisionCount: 500,
    });
  });
});

describe("Agent review context", () => {
  it("claims the request and describes each open item with its Session and Knowledge", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Use the shared crate cache", "Pin the base image"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    const request = openReview(fixture);

    const context = fixture.store.getAgentReviewContext({ requestId: request.id });
    if (context.outcome !== "agent_review_context") throw new Error("Expected context.");
    expect(context.request.status).toBe("processing");
    expect(context.request.startedAt).toBeDefined();
    expect(context.items.map((item) => [item.itemKind, item.id, item.state])).toEqual([
      ["decision", decisionIds[0], "open"],
      ["decision", decisionIds[1], "open"],
      ["candidate", candidateId, "open"],
    ]);
    expect(context.items[0]).toMatchObject({
      text: "Use the shared crate cache",
      sourceSession: { id: sessionId, title: "Session a", outcomes: ["Outcome of a"] },
    });
    expect(context.items[0]!.sourceSession?.otherDecisions).toEqual(["Pin the base image"]);
    expect(context.items[2]).toMatchObject({ title: "Cache keys include the lockfile", kind: "gotcha" });
    expect(context.existingKnowledge).toEqual([]);
    expect(context.pageInfo).toMatchObject({ page: 1, total: 3 });
    expect(context.truncated).toBe(false);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(24_000);
  });

  it("finds the open request by project root and pages through large snapshots", () => {
    const fixture = setup();
    const { sessionId } = finalize(fixture, "a", ["Seed decision"]);
    const insert = fixture.db.prepare(
      `INSERT INTO session_decisions (id, session_id, project_id, position, text, origin, review_status)
       VALUES (?, ?, ?, ?, ?, 'agent_autonomous', 'pending')`,
    );
    for (let index = 1; index <= 24; index += 1) {
      insert.run(`bulk-${index}`, sessionId, fixture.projectId, index, `Bulk decision ${index}`);
    }
    openReview(fixture);
    const first = fixture.store.getAgentReviewContext({ projectRoot: fixture.root });
    const third = fixture.store.getAgentReviewContext({ projectRoot: fixture.root, page: 3 });
    if (first.outcome !== "agent_review_context" || third.outcome !== "agent_review_context") {
      throw new Error("Expected context pages.");
    }
    expect(first.items).toHaveLength(10);
    expect(first.existingKnowledge).toBeDefined();
    expect(third.items).toHaveLength(5);
    expect(third.existingKnowledge).toBeUndefined();
    expect(third.pageInfo).toMatchObject({ page: 3, total: 25 });
  });

  it("shortens long text to stay inside the budget without dropping items", () => {
    const fixture = setup();
    const long = "x".repeat(1_900);
    const { decisionIds } = finalize(
      fixture,
      "a",
      Array.from({ length: 10 }, (_, index) => `${index}-${long}`),
    );
    const request = openReview(fixture);
    const context = fixture.store.getAgentReviewContext({ requestId: request.id });
    if (context.outcome !== "agent_review_context") throw new Error("Expected context.");
    expect(context.items.map((item) => item.id)).toEqual(decisionIds);
    expect(context.truncated).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(24_000);
  });

  it("marks items a person reviewed or that changed since the snapshot", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision", "Gamma decision"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    const request = openReview(fixture);
    fixture.store.reviewSessionDecision({
      decisionId: decisionIds[0]!,
      projectRoot: fixture.root,
      reviewStatus: "rejected",
    });
    fixture.db
      .prepare("UPDATE session_decisions SET text = 'Beta decision, reworded' WHERE id = ?")
      .run(decisionIds[1]!);
    fixture.db.prepare("UPDATE knowledge_candidates SET body = 'Edited body.' WHERE id = ?").run(candidateId);
    const context = fixture.store.getAgentReviewContext({ requestId: request.id });
    if (context.outcome !== "agent_review_context") throw new Error("Expected context.");
    expect(context.items.map((item) => item.state)).toEqual(["reviewed", "stale", "open", "stale"]);
  });

  it("recovers a request an Agent abandoned in processing", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T09:00:00.000Z"));
    const fixture = setup();
    finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    fixture.store.getAgentReviewContext({ requestId: request.id });

    vi.setSystemTime(new Date("2026-10-02T09:31:00.000Z"));
    expect(listedRequests(fixture, { projectId: fixture.projectId })[0]).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("30"),
    });
    expect(fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "again" })).toMatchObject({
      duplicate: true,
      request: { id: request.id },
    });
    expect(fixture.store.getAgentReviewContext({ requestId: request.id })).toMatchObject({
      request: { status: "processing" },
    });
  });

  it("reports unknown and closed requests", () => {
    const fixture = setup();
    finalize(fixture, "a", ["Alpha decision"]);
    expect(fixture.store.getAgentReviewContext({ requestId: "missing" })).toMatchObject({ outcome: "not_found" });
    const request = openReview(fixture);
    fixture.store.cancelAgentReviewRequest(request.id);
    expect(fixture.store.getAgentReviewContext({ requestId: request.id })).toMatchObject({
      outcome: "request_not_open",
      request: { status: "cancelled" },
    });
  });
});

describe("Agent review verdicts", () => {
  it("applies decision and candidate verdicts directly and attributes them to the Agent", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision", "Gamma decision"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    const request = openReview(fixture);

    const result = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "confirm"),
      decisionVerdict(decisionIds[1]!, "reject"),
      decisionVerdict(decisionIds[2]!, "promote", { knowledge: promoteDraft("Gamma becomes a rule") }),
      {
        itemKind: "candidate",
        itemId: candidateId,
        verdict: "accept",
        reason: "The rationale quotes the fix.",
        edits: { title: "Cache keys include the lockfile hash" },
      },
    ]);
    expect(result.duplicate).toBe(false);
    expect(result.results.map((entry) => entry.outcome)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(result.results[2]!.knowledgeId).toBeDefined();
    expect(result.results[3]!.knowledgeId).toBeDefined();
    expect(result.request).toMatchObject({ status: "completed", appliedCount: 4, skippedCount: 0, openCount: 0 });

    const agentReviewed = fixture.store.listSessionDecisions({ projectRoot: fixture.root, status: "agent_reviewed" });
    if (agentReviewed.outcome !== "session_decisions") throw new Error("Expected decisions.");
    expect(agentReviewed.items.map((item) => [item.reviewStatus, item.reviewedBy])).toEqual(
      expect.arrayContaining([
        ["confirmed", "agent"],
        ["rejected", "agent"],
        ["promoted", "agent"],
      ]),
    );
    expect(agentReviewed.items.find((item) => item.reviewStatus === "promoted")).toMatchObject({
      reviewReason: "Fictional reason for promote.",
      reviewRequestId: request.id,
      knowledgeId: result.results[2]!.knowledgeId,
    });
    expect(agentReviewed.pendingCount).toBe(0);

    const candidates = fixture.store.listKnowledgeCandidates({ projectRoot: fixture.root, reviewedBy: "agent" });
    if (candidates.outcome !== "knowledge_candidates") throw new Error("Expected candidates.");
    expect(candidates.items).toMatchObject([
      { id: candidateId, status: "accepted", reviewedBy: "agent", reviewRequestId: request.id },
    ]);
    const knowledge = fixture.store.searchKnowledge({ projectId: fixture.projectId, pageSize: 20 });
    expect(JSON.stringify(knowledge)).toContain("Cache keys include the lockfile hash");
  });

  it("reports requests with items left open and completes only when asked or when nothing is left", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(fixture);
    const partial = submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    expect(partial.request).toMatchObject({ status: "pending", appliedCount: 1, openCount: 1 });
    expect(partial.completion).toBeUndefined();

    const closing = submitted(fixture, request.id, [], "submit-2", true);
    expect(closing.request).toMatchObject({ status: "completed", appliedCount: 1, openCount: 1, omittedCount: 0 });
    expect(closing.completion).toEqual({ knowledgePages: [] });
    expect(fixture.store.listSessionDecisions({ projectRoot: fixture.root })).toMatchObject({ pendingCount: 1 });
  });

  it("names knowledge pages that cite a reviewed Session on completion", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    fixture.store.requestKnowledgePageUpdate({ projectRoot: fixture.root, slug: "architecture" });
    const saved = fixture.store.saveKnowledgePage({
      projectRoot: fixture.root,
      slug: "architecture",
      idempotencyKey: "orchard-page",
      sections: [{ heading: "Build", content: "The build is cached.", sourceSessionIds: [sessionId] }],
    });
    expect(saved.outcome).toBe("knowledge_page_saved");
    const request = openReview(fixture);
    const result = submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    expect(result.completion?.knowledgePages).toEqual([
      { slug: "architecture", title: expect.any(String), reasons: ["cites_reviewed_session"] },
    ]);
  });

  it("skips items a person reviewed or that changed after the snapshot, and unknown items", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision", "Gamma decision"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    const request = openReview(fixture);
    fixture.store.reviewSessionDecision({
      decisionId: decisionIds[0]!,
      projectRoot: fixture.root,
      reviewStatus: "confirmed",
    });
    fixture.db
      .prepare("UPDATE session_decisions SET text = 'Beta decision, reworded' WHERE id = ?")
      .run(decisionIds[1]!);
    fixture.db.prepare("DELETE FROM knowledge_candidates WHERE id = ?").run(candidateId);

    const result = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "reject"),
      decisionVerdict(decisionIds[1]!, "reject"),
      { itemKind: "candidate", itemId: candidateId, verdict: "reject", reason: "Gone by now." },
      decisionVerdict("not-in-this-request", "confirm"),
      decisionVerdict(decisionIds[2]!, "confirm"),
    ]);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      "skipped_reviewed",
      "skipped_stale",
      "skipped_stale",
      "not_in_request",
      "applied",
    ]);
    expect(result.request).toMatchObject({ appliedCount: 1, skippedCount: 3, openCount: 0 });
    const kept = fixture.db
      .prepare("SELECT review_status, reviewed_by FROM session_decisions WHERE id = ?")
      .get(decisionIds[0]!);
    expect(kept).toMatchObject({ review_status: "confirmed", reviewed_by: "user" });
  });

  it("does not apply an item of another project", () => {
    const fixture = setup();
    finalize(fixture, "a", ["Alpha decision"]);
    const other = trackedProject(fixture.store, "Meadow");
    const foreign = finalize({ store: fixture.store, root: other.root }, "b", ["Foreign decision"]);
    const request = openReview(fixture);
    const result = submitted(fixture, request.id, [decisionVerdict(foreign.decisionIds[0]!, "confirm")]);
    expect(result.results).toEqual([
      { itemKind: "decision", itemId: foreign.decisionIds[0], outcome: "not_in_request" },
    ]);
    expect(fixture.store.listSessionDecisions({ projectRoot: other.root })).toMatchObject({ pendingCount: 1 });
  });

  it("redacts secrets from the reason before storing it", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    const token = `gho_${"B".repeat(36)}`;
    const result = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "confirm", { reason: `Checked with ${token}` }),
    ]);
    expect(result.redactions?.total).toBeGreaterThan(0);
    expect(JSON.stringify(fixture.db.prepare("SELECT * FROM agent_review_request_items").all())).not.toContain(token);
    expect(JSON.stringify(fixture.db.prepare("SELECT * FROM session_decisions").all())).not.toContain(token);
  });

  it("replays an identical submission and rejects the same key with another payload", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(fixture);
    const verdicts = [decisionVerdict(decisionIds[0]!, "confirm")];
    const first = submitted(fixture, request.id, verdicts);
    const replay = submitted(fixture, request.id, verdicts);
    expect(replay).toMatchObject({ duplicate: true, results: first.results });
    expect(
      fixture.store.submitAgentReviewVerdicts({
        requestId: request.id,
        idempotencyKey: "submit-1",
        verdicts: [decisionVerdict(decisionIds[1]!, "confirm")],
      }),
    ).toEqual({ outcome: "rejected", reason: "idempotency_conflict", requestId: request.id });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_review_submissions").get()).toEqual({ count: 1 });
  });

  it("refuses verdicts without an open request", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(fixture);
    submitted(fixture, request.id, [], "close", true);
    expect(
      fixture.store.submitAgentReviewVerdicts({
        requestId: request.id,
        idempotencyKey: "late",
        verdicts: [decisionVerdict(decisionIds[0]!, "confirm")],
      }),
    ).toEqual({ outcome: "rejected", reason: "request_not_open", requestId: request.id });
    expect(
      fixture.store.submitAgentReviewVerdicts({ requestId: "missing", idempotencyKey: "late", verdicts: [] }),
    ).toMatchObject({ outcome: "not_found" });
    expect(fixture.store.listSessionDecisions({ projectRoot: fixture.root })).toMatchObject({ pendingCount: 2 });
  });

  it("takes a failed request back when an Agent submits verdicts for it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T09:00:00.000Z"));
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    fixture.store.getAgentReviewContext({ requestId: request.id });
    vi.setSystemTime(new Date("2026-10-02T09:45:00.000Z"));
    const result = submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    expect(result.request).toMatchObject({ status: "completed", appliedCount: 1 });
  });
});

describe("Agent review cancellation", () => {
  it("cancels an open request once, reports a repeat, and refuses a completed one", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    expect(fixture.store.cancelAgentReviewRequest(request.id)).toMatchObject({
      outcome: "agent_review_request_cancelled",
      duplicate: false,
      request: { status: "cancelled" },
    });
    expect(fixture.store.cancelAgentReviewRequest(request.id)).toMatchObject({ duplicate: true });
    expect(
      fixture.store.submitAgentReviewVerdicts({
        requestId: request.id,
        idempotencyKey: "late",
        verdicts: [decisionVerdict(decisionIds[0]!, "confirm")],
      }),
    ).toMatchObject({ outcome: "rejected", reason: "request_not_open" });

    const next = openReview(fixture, "review-2");
    expect(next.id).not.toBe(request.id);
    submitted(fixture, next.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    expect(fixture.store.cancelAgentReviewRequest(next.id)).toEqual({
      outcome: "rejected",
      reason: "request_closed",
      requestId: next.id,
    });
    expect(fixture.store.cancelAgentReviewRequest("missing")).toMatchObject({ outcome: "not_found" });
  });
});

describe("Overturning Agent verdicts", () => {
  it("returns a decision to the inbox and keeps it out of later Agent requests", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(fixture);
    submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "reject")], "submit-1", true);

    const overturned = fixture.store.overturnAgentReview({
      projectRoot: fixture.root,
      itemKind: "decision",
      itemId: decisionIds[0]!,
    });
    expect(overturned).toMatchObject({
      outcome: "agent_review_overturned",
      itemKind: "decision",
      decision: { id: decisionIds[0], reviewStatus: "pending" },
    });
    expect(
      fixture.db.prepare("SELECT reviewed_by, review_reason FROM session_decisions WHERE id = ?").get(decisionIds[0]!),
    ).toEqual({
      reviewed_by: null,
      review_reason: null,
    });
    expect(
      fixture.db.prepare("SELECT overturned_at FROM agent_review_request_items WHERE item_id = ?").get(decisionIds[0]!),
    ).toEqual({ overturned_at: expect.any(String) });

    const next = openReview(fixture, "review-2");
    expect(next).toMatchObject({ itemCount: 1, decisionCount: 1 });
    const context = fixture.store.getAgentReviewContext({ requestId: next.id });
    expect(context).toMatchObject({ items: [{ id: decisionIds[1] }] });
    expect(fixture.store.listSessionDecisions({ projectRoot: fixture.root })).toMatchObject({
      pendingCount: 2,
      items: expect.arrayContaining([expect.objectContaining({ id: decisionIds[0] })]),
    });
  });

  it("returns a candidate to proposed and archives the Knowledge an accept created", () => {
    const fixture = setup();
    const { sessionId } = finalize(fixture, "a", ["Alpha decision"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    const request = openReview(fixture);
    const result = submitted(fixture, request.id, [
      { itemKind: "candidate", itemId: candidateId, verdict: "accept", reason: "Supported by the handoff." },
    ]);
    const knowledgeId = result.results[0]!.knowledgeId!;

    expect(
      fixture.store.overturnAgentReview({ projectRoot: fixture.root, itemKind: "candidate", itemId: candidateId }),
    ).toMatchObject({
      outcome: "agent_review_overturned",
      candidate: { id: candidateId, status: "proposed" },
      knowledge: { id: knowledgeId, action: "archived", status: "archived" },
    });
    expect(fixture.db.prepare("SELECT status FROM knowledge WHERE id = ?").get(knowledgeId)).toEqual({
      status: "archived",
    });
  });

  it("archives Knowledge that was edited afterwards without losing the edit", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    const knowledgeId = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "promote", { knowledge: promoteDraft("Alpha becomes a rule") }),
    ]).results[0]!.knowledgeId!;
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId, title: "Alpha, edited by a person" });

    expect(
      fixture.store.overturnAgentReview({ projectRoot: fixture.root, itemKind: "decision", itemId: decisionIds[0]! }),
    ).toMatchObject({ knowledge: { id: knowledgeId, action: "archived", status: "archived" } });
    expect(fixture.db.prepare("SELECT title, status FROM knowledge WHERE id = ?").get(knowledgeId)).toEqual({
      title: "Alpha, edited by a person",
      status: "archived",
    });
  });

  it("leaves Knowledge that is already archived as it is", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    const knowledgeId = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "promote", { knowledge: promoteDraft("Alpha becomes a rule") }),
    ]).results[0]!.knowledgeId!;
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId, status: "archived" });

    expect(
      fixture.store.overturnAgentReview({ projectRoot: fixture.root, itemKind: "decision", itemId: decisionIds[0]! }),
    ).toMatchObject({
      outcome: "agent_review_overturned",
      decision: { reviewStatus: "pending" },
      knowledge: { id: knowledgeId, action: "unchanged", status: "archived" },
    });
  });

  it("reports missing Knowledge instead of failing when it was deleted", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    const knowledgeId = submitted(fixture, request.id, [
      decisionVerdict(decisionIds[0]!, "promote", { knowledge: promoteDraft("Alpha becomes a rule") }),
    ]).results[0]!.knowledgeId!;
    fixture.db.exec("PRAGMA foreign_keys = OFF");
    fixture.db.prepare("DELETE FROM knowledge WHERE id = ?").run(knowledgeId);
    fixture.db.exec("PRAGMA foreign_keys = ON");

    const result = fixture.store.overturnAgentReview({
      projectRoot: fixture.root,
      itemKind: "decision",
      itemId: decisionIds[0]!,
    });
    expect(result).toMatchObject({
      outcome: "agent_review_overturned",
      decision: { id: decisionIds[0], reviewStatus: "pending" },
      knowledge: { action: "missing" },
    });
  });

  it("does not report Knowledge for verdicts that created none", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    const result = fixture.store.overturnAgentReview({
      projectRoot: fixture.root,
      itemKind: "decision",
      itemId: decisionIds[0]!,
    });
    expect(result).toMatchObject({ outcome: "agent_review_overturned" });
    expect(result).not.toHaveProperty("knowledge");
  });

  it("refuses items no Agent reviewed and unknown items", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    fixture.store.reviewSessionDecision({
      decisionId: decisionIds[0]!,
      projectRoot: fixture.root,
      reviewStatus: "confirmed",
    });
    expect(
      fixture.store.overturnAgentReview({ projectRoot: fixture.root, itemKind: "decision", itemId: decisionIds[0]! }),
    ).toEqual({ outcome: "rejected", reason: "not_agent_reviewed" });
    expect(
      fixture.store.overturnAgentReview({ projectRoot: fixture.root, itemKind: "candidate", itemId: "missing" }),
    ).toMatchObject({ outcome: "not_found" });
  });
});

describe("Reviewer attribution", () => {
  it("records the user for human decisions and reads rows without attribution as the user", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const candidateId = proposeCandidate(fixture, sessionId, "Cache keys include the lockfile");
    fixture.store.reviewSessionDecision({
      decisionId: decisionIds[0]!,
      projectRoot: fixture.root,
      reviewStatus: "confirmed",
    });
    fixture.store.decideKnowledgeCandidate({ candidateId, decision: "reject" });
    fixture.db
      .prepare(
        "UPDATE session_decisions SET review_status = 'rejected', reviewed_at = ?, reviewed_by = NULL WHERE id = ?",
      )
      .run(BASE_TIME, decisionIds[1]!);

    const decisions = fixture.store.listSessionDecisions({ projectRoot: fixture.root, status: "all" });
    if (decisions.outcome !== "session_decisions") throw new Error("Expected decisions.");
    expect(decisions.items.map((item) => item.reviewedBy)).toEqual(["user", "user"]);
    expect(fixture.store.listSessionDecisions({ projectRoot: fixture.root, status: "agent_reviewed" })).toMatchObject({
      items: [],
    });
    const rejected = fixture.store.listKnowledgeCandidates({ projectRoot: fixture.root, status: "rejected" });
    if (rejected.outcome !== "knowledge_candidates") throw new Error("Expected candidates.");
    expect(rejected.items).toMatchObject([{ id: candidateId, reviewedBy: "user" }]);
    expect(fixture.store.listKnowledgeCandidates({ projectRoot: fixture.root, reviewedBy: "agent" })).toMatchObject({
      items: [],
    });
  });

  it("lets a person overrule an Agent verdict directly and take over the attribution", () => {
    const fixture = setup();
    const { decisionIds } = finalize(fixture, "a", ["Alpha decision"]);
    const request = openReview(fixture);
    submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    const reviewed = fixture.store.reviewSessionDecision({
      decisionId: decisionIds[0]!,
      projectRoot: fixture.root,
      reviewStatus: "confirmed",
    });
    expect(reviewed).toMatchObject({ duplicate: false, decision: { reviewedBy: "user" } });
    expect(fixture.store.listSessionDecisions({ projectRoot: fixture.root, status: "agent_reviewed" })).toMatchObject({
      items: [],
    });
  });

  it("keeps the Agent attribution when a Session's decisions are rewritten with the same text", () => {
    const fixture = setup();
    const { sessionId, decisionIds } = finalize(fixture, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(fixture);
    submitted(fixture, request.id, [decisionVerdict(decisionIds[0]!, "reject")]);

    replaceSessionDecisions(fixture.db, sessionId, fixture.projectId, [
      { text: "Alpha decision", origin: "agent_autonomous" },
      { text: "Beta decision", origin: "agent_autonomous" },
    ]);
    expect(
      fixture.db
        .prepare("SELECT id, reviewed_by, review_reason, review_request_id FROM session_decisions WHERE id = ?")
        .get(decisionIds[0]!),
    ).toEqual({
      id: decisionIds[0],
      reviewed_by: "agent",
      review_reason: "Fictional reason for reject.",
      review_request_id: request.id,
    });
  });
});

describe("Agent review data lifecycle", () => {
  it("exports and imports requests, submissions and items with their attribution", () => {
    const source = setup();
    const { decisionIds } = finalize(source, "a", ["Alpha decision", "Beta decision"]);
    const request = openReview(source);
    submitted(source, request.id, [decisionVerdict(decisionIds[0]!, "confirm")]);
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(bundle.tables.agent_review_requests).toHaveLength(1);
    expect(bundle.tables.agent_review_submissions).toHaveLength(1);
    expect(bundle.tables.agent_review_request_items).toHaveLength(2);

    const target = new WorkIntelligenceStore(":memory:");
    stores.push(target);
    const targetRoot = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-import-"));
    tempDirs.push(targetRoot);
    const input = { bundle, remap: [{ from: source.root, to: targetRoot }], strategy: "merge" as const };
    expect(target.importProjectData(input).conflicts).toEqual(
      expect.not.objectContaining({ agent_review_requests: 1 }),
    );
    const imported = target.exportProjectData({ type: "all" });
    expect(imported.tables.agent_review_requests).toHaveLength(1);
    expect(imported.tables.agent_review_request_items).toHaveLength(2);
    const decision = imported.tables.session_decisions.find((row) => row.id === decisionIds[0]);
    expect(decision).toMatchObject({ reviewed_by: "agent", review_request_id: request.id });
  });
});
