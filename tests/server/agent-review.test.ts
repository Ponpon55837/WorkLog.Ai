import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler, type ApiHandler } from "../../apps/server/src/server.js";

const resources: Array<{ handler: ApiHandler; store: WorkIntelligenceStore; root: string }> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    resource.handler.closeEventStreams();
    resource.store.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function startApi(store: WorkIntelligenceStore): ApiHandler {
  return createApiHandler(store);
}

async function requestJson<T>(
  handler: ApiHandler,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const request = Readable.from(
    options.body === undefined ? [] : [JSON.stringify(options.body)],
  ) as unknown as IncomingMessage;
  Object.assign(request, {
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    method: options.method ?? "GET",
    url: path,
  });
  const result = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    payload: "",
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
      this.headersSent = true;
      return this;
    },
    end(payload?: string | Uint8Array) {
      this.payload = payload === undefined ? "" : Buffer.from(payload).toString("utf8");
      this.writableEnded = true;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  await handler(request, result as unknown as ServerResponse);
  return { status: result.statusCode, body: JSON.parse(result.payload || "null") as T };
}

function createFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-api-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { root, store, project };
}

function finalizeDecisions(store: WorkIntelligenceStore, root: string, key: string, decisions: string[]) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: `Fictional summary for ${key}.`,
    completedAt: "2026-10-01T09:00:00.000Z",
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
  return (store.getSessionDetail(result.session.id)?.decisions ?? []).map((decision) => decision.id);
}

function createStaleKnowledge(store: WorkIntelligenceStore, root: string, key: string): string {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z"));
  const recorded = store.recordKnowledge({
    projectRoot: root,
    idempotencyKey: `${key}-knowledge`,
    kind: "gotcha",
    title: `Fictional rule for ${key}`,
    body: "Keep the fictional lease file in step with its docs.",
    appliesTo: ["packages/fictional/lease.ts"],
  });
  if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected recorded Knowledge.");
  vi.setSystemTime(new Date("2026-10-03T08:00:00.000Z"));
  const finalized = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: `${key}-session`,
    title: `Session ${key}`,
    summary: `Fictional summary for ${key}.`,
    completedAt: "2026-10-02T09:00:00.000Z",
    workSummary: { outcomes: [`Outcome of ${key}`], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["packages/fictional/lease.ts"],
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  return recorded.knowledge.id;
}

function confirmKnowledgeVerdict(store: WorkIntelligenceStore, projectId: string, root: string, key: string) {
  const knowledgeId = createStaleKnowledge(store, root, key);
  const request = store.createAgentReviewRequest({ projectId, idempotencyKey: `${key}-request` });
  if (request.outcome !== "agent_review_request") throw new Error("Expected a request.");
  const context = store.getAgentReviewContext({ requestId: request.request.id });
  if (context.outcome !== "agent_review_context") throw new Error("Expected context.");
  const submitted = store.submitAgentReviewVerdicts({
    requestId: request.request.id,
    idempotencyKey: `${key}-submit`,
    verdicts: [
      { itemKind: "knowledge", itemId: knowledgeId, verdict: "confirm", reason: "Still true after the change." },
    ],
    complete: true,
  });
  if (submitted.outcome !== "agent_review_verdicts_submitted") throw new Error("Expected submitted verdicts.");
  return { knowledgeId, request: request.request };
}

describe("Agent review REST routes", () => {
  it("creates, lists, and cancels requests, then overturns an Agent verdict", async () => {
    const { root, store, project } = createFixture("Agent review REST fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const [decisionId, userDecisionId] = finalizeDecisions(store, root, "agent-review-rest", [
      "Keep the retry budget small.",
      "Name the queue after the team.",
    ]);

    const created = await requestJson<{
      outcome: string;
      duplicate: boolean;
      request: { id: string; status: string; itemCount: number };
    }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "agent-review-rest-request" },
    });
    expect(created).toMatchObject({
      status: 201,
      body: { outcome: "agent_review_request", duplicate: false, request: { status: "pending", itemCount: 2 } },
    });
    const requestId = created.body.request.id;

    const listed = await requestJson<{ outcome: string; requests: Array<{ id: string }> }>(
      handler,
      `/api/agent-review-requests?projectId=${encodeURIComponent(project.id)}&status=pending`,
    );
    expect(listed).toMatchObject({
      status: 200,
      body: { outcome: "agent_review_requests", requests: [expect.objectContaining({ id: requestId })] },
    });

    const submitted = store.submitAgentReviewVerdicts({
      requestId,
      idempotencyKey: "agent-review-rest-submit",
      verdicts: [{ itemKind: "decision", itemId: decisionId!, verdict: "confirm", reason: "The Session confirms it." }],
      complete: true,
    });
    expect(submitted.outcome).toBe("agent_review_verdicts_submitted");

    const agentReviewed = await requestJson<{ items: Array<{ id: string; reviewedBy: string }> }>(
      handler,
      `/api/session-decisions?projectRoot=${encodeURIComponent(root)}&status=agent_reviewed`,
    );
    expect(agentReviewed.body.items).toEqual([expect.objectContaining({ id: decisionId, reviewedBy: "agent" })]);

    const refused = await requestJson<{ code: string; details: { reason: string } }>(
      handler,
      `/api/session-decisions/${userDecisionId}/overturn`,
      { method: "POST", body: { projectRoot: root } },
    );
    expect(refused).toMatchObject({
      status: 409,
      body: { code: "conflict", details: { reason: "not_agent_reviewed" } },
    });

    const overturned = await requestJson<{ outcome: string; decision: { reviewStatus: string } }>(
      handler,
      `/api/session-decisions/${decisionId}/overturn`,
      { method: "POST", body: { projectRoot: root } },
    );
    expect(overturned).toMatchObject({
      status: 200,
      body: { outcome: "agent_review_overturned", decision: { reviewStatus: "pending" } },
    });

    const missing = await requestJson<{ outcome: string }>(
      handler,
      "/api/knowledge/candidates/missing-candidate/overturn",
      { method: "POST", body: { projectRoot: root } },
    );
    expect(missing).toMatchObject({ status: 200, body: { outcome: "not_found" } });

    const cancelled = await requestJson<{ code: string; details: { reason: string } }>(
      handler,
      `/api/agent-review-requests/${requestId}/cancel`,
      { method: "POST", body: {} },
    );
    expect(cancelled).toMatchObject({ status: 409, body: { code: "conflict", details: { reason: "request_closed" } } });

    const candidates = await requestJson<{ outcome: string }>(
      handler,
      `/api/knowledge/candidates?projectRoot=${encodeURIComponent(root)}&reviewedBy=agent&status=accepted`,
    );
    expect(candidates).toMatchObject({ status: 200, body: { outcome: "knowledge_candidates" } });
  });

  it("lists the Knowledge pages of completed requests only, with their current state", async () => {
    const { root, store, project } = createFixture("Agent review REST pages fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const [decisionId] = finalizeDecisions(store, root, "agent-review-rest-pages", ["Keep the retry budget small."]);
    const queued = store.requestKnowledgePageUpdate({
      projectRoot: root,
      slug: "operations",
      title: "Operations",
      question: "How is the service run?",
    });
    expect(queued.outcome).toBe("knowledge_page_update_requested");
    const created = await requestJson<{ request: { id: string } }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "agent-review-rest-pages-request" },
    });
    const listPath = `/api/agent-review-requests?projectId=${encodeURIComponent(project.id)}`;

    const open = await requestJson<{ requests: Array<Record<string, unknown>> }>(handler, listPath);
    expect(open.body.requests[0]).not.toHaveProperty("knowledgePages");

    store.submitAgentReviewVerdicts({
      requestId: created.body.request.id,
      idempotencyKey: "agent-review-rest-pages-submit",
      verdicts: [{ itemKind: "decision", itemId: decisionId!, verdict: "confirm", reason: "The Session confirms it." }],
      complete: true,
    });
    const completed = await requestJson<{ requests: Array<Record<string, unknown>> }>(handler, listPath);
    expect(completed.body.requests[0]).toMatchObject({
      status: "completed",
      knowledgePages: [{ slug: "operations", title: "Operations", reasons: ["queued_for_update"], state: "pending" }],
    });
  });

  it("lists Knowledge the Agent confirmed and overturns the confirmation", async () => {
    const { root, store, project } = createFixture("Agent review REST knowledge fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const { knowledgeId, request } = confirmKnowledgeVerdict(store, project.id, root, "agent-review-rest-knowledge");
    vi.useRealTimers();
    expect(request.knowledgeCount).toBe(1);

    const listed = await requestJson<{
      outcome: string;
      items: Array<{ knowledge: { id: string }; verdict: string; reason: string }>;
    }>(handler, `/api/agent-review-knowledge?projectRoot=${encodeURIComponent(root)}`);
    expect(listed).toMatchObject({
      status: 200,
      body: {
        outcome: "agent_reviewed_knowledge",
        items: [{ knowledge: { id: knowledgeId }, verdict: "confirm", reason: "Still true after the change." }],
      },
    });

    const overturned = await requestJson<{
      outcome: string;
      reviewedKnowledge: { knowledge: { id: string }; action: string };
    }>(handler, `/api/knowledge/${knowledgeId}/overturn`, { method: "POST", body: { projectRoot: root } });
    expect(overturned).toMatchObject({
      status: 200,
      body: {
        outcome: "agent_review_overturned",
        reviewedKnowledge: { knowledge: { id: knowledgeId }, action: "confirmation_withdrawn" },
      },
    });

    const after = await requestJson<{ items: unknown[] }>(handler, "/api/agent-review-knowledge");
    expect(after).toMatchObject({ status: 200, body: { items: [] } });
    const again = await requestJson<{ code: string; details: { reason: string } }>(
      handler,
      `/api/knowledge/${knowledgeId}/overturn`,
      { method: "POST", body: { projectRoot: root } },
    );
    expect(again).toMatchObject({ status: 409, body: { code: "conflict", details: { reason: "not_agent_reviewed" } } });
  });

  it("keeps candidate overturn routed to candidates beside the Knowledge overturn", async () => {
    const { root, store } = createFixture("Agent review REST routing fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const candidate = await requestJson<{ outcome: string }>(
      handler,
      "/api/knowledge/candidates/missing-candidate/overturn",
      { method: "POST", body: { projectRoot: root } },
    );
    expect(candidate).toMatchObject({ status: 200, body: { outcome: "not_found" } });
    const knowledge = await requestJson<{ outcome: string }>(handler, "/api/knowledge/missing-knowledge/overturn", {
      method: "POST",
      body: { projectRoot: root },
    });
    expect(knowledge).toMatchObject({ status: 200, body: { outcome: "not_found" } });
  });

  it("cancels an open request and reports nothing to review quietly", async () => {
    const { root, store, project } = createFixture("Agent review REST cancel fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const empty = await requestJson<{ outcome: string }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "agent-review-rest-empty" },
    });
    expect(empty).toMatchObject({ status: 200, body: { outcome: "agent_review_not_needed" } });

    finalizeDecisions(store, root, "agent-review-rest-cancel", ["Pin the toolchain."]);
    const created = await requestJson<{ request: { id: string } }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "agent-review-rest-cancel-request" },
    });
    const cancelled = await requestJson<{ outcome: string; request: { status: string } }>(
      handler,
      `/api/agent-review-requests/${created.body.request.id}/cancel`,
      { method: "POST", body: {} },
    );
    expect(cancelled).toMatchObject({
      status: 200,
      body: { outcome: "agent_review_request_cancelled", request: { status: "cancelled" } },
    });
  });

  it("rejects invalid input and skips untracked projects", async () => {
    const { root, store, project } = createFixture("Agent review REST policy fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });

    const invalid = await requestJson<{ code: string }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: project.id },
    });
    expect(invalid).toMatchObject({ status: 400, body: { code: "invalid_input" } });
    const unknownField = await requestJson<{ code: string }>(handler, "/api/session-decisions/x/overturn", {
      method: "POST",
      body: { projectRoot: root, itemKind: "candidate", extra: true },
    });
    expect(unknownField.status).toBe(400);
    const invalidKnowledge = await requestJson<{ code: string }>(handler, "/api/knowledge/x/overturn", {
      method: "POST",
      body: { projectRoot: root, extra: true },
    });
    expect(invalidKnowledge).toMatchObject({ status: 400, body: { code: "invalid_input" } });
    const missingRoot = await requestJson<{ code: string }>(handler, "/api/knowledge/x/overturn", {
      method: "POST",
      body: {},
    });
    expect(missingRoot.status).toBe(400);
    const invalidQuery = await requestJson<{ code: string }>(
      handler,
      `/api/agent-review-knowledge?projectRoot=${"a".repeat(1_001)}`,
    );
    expect(invalidQuery).toMatchObject({ status: 400, body: { code: "invalid_input" } });

    const paused = store.addProject("Agent review REST paused fixture", join(root, "paused"));
    store.updateProject(paused.id, { status: "paused" });
    const skipped = await requestJson<{ outcome: string }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: paused.id, idempotencyKey: "agent-review-rest-paused" },
    });
    expect(skipped).toMatchObject({ status: 200, body: { outcome: "skipped" } });
    const pausedRoot = join(root, "paused");
    const listSkipped = await requestJson<{ outcome: string }>(
      handler,
      `/api/agent-review-knowledge?projectRoot=${encodeURIComponent(pausedRoot)}`,
    );
    expect(listSkipped).toMatchObject({ status: 200, body: { outcome: "skipped" } });
    const overturnSkipped = await requestJson<{ outcome: string }>(handler, "/api/knowledge/x/overturn", {
      method: "POST",
      body: { projectRoot: pausedRoot },
    });
    expect(overturnSkipped).toMatchObject({ status: 200, body: { outcome: "skipped" } });
  });

  it("counts pending items per tracked project and leaves out projects with nothing to review", async () => {
    const { root, store } = createFixture("Agent review pending fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const quietRoot = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-quiet-"));
    store.updateProject(store.addProject("Agent review quiet fixture", quietRoot).id, { status: "tracked" });
    finalizeDecisions(store, root, "agent-review-pending", ["Keep the retry budget small.", "Name the queue."]);

    const pending = await requestJson<{ outcome: string; projects: unknown[] }>(handler, "/api/agent-review-pending");
    expect(pending).toMatchObject({
      status: 200,
      body: {
        outcome: "agent_review_pending",
        projects: [
          {
            projectName: "Agent review pending fixture",
            decisionCount: 2,
            candidateCount: 0,
            knowledgeCount: 0,
          },
        ],
      },
    });
    expect(pending.body.projects).toHaveLength(1);
    rmSync(quietRoot, { recursive: true, force: true });
  });

  it("masks internal errors", async () => {
    const { root, store } = createFixture("Agent review REST error fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    vi.spyOn(store, "listAgentReviewRequests").mockImplementation(() => {
      throw new Error("private database path and SQL details");
    });
    const masked = await requestJson<{ error: string; code: string }>(handler, "/api/agent-review-requests");
    expect(masked).toMatchObject({ status: 500, body: { error: "Internal server error.", code: "internal_error" } });
    expect(JSON.stringify(masked.body)).not.toContain("private database path");
    vi.spyOn(store, "listAgentReviewedKnowledge").mockImplementation(() => {
      throw new Error("private database path and SQL details");
    });
    vi.spyOn(store, "listAgentReviewPending").mockImplementation(() => {
      throw new Error("private database path and SQL details");
    });
    const maskedPending = await requestJson<{ code: string }>(handler, "/api/agent-review-pending");
    expect(maskedPending).toMatchObject({ status: 500, body: { code: "internal_error" } });
    const maskedKnowledge = await requestJson<{ code: string }>(handler, "/api/agent-review-knowledge");
    expect(maskedKnowledge).toMatchObject({ status: 500, body: { code: "internal_error" } });
  });
});
