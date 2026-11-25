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

    const paused = store.addProject("Agent review REST paused fixture", join(root, "paused"));
    store.updateProject(paused.id, { status: "paused" });
    const skipped = await requestJson<{ outcome: string }>(handler, "/api/agent-review-requests", {
      method: "POST",
      body: { projectId: paused.id, idempotencyKey: "agent-review-rest-paused" },
    });
    expect(skipped).toMatchObject({ status: 200, body: { outcome: "skipped" } });
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
  });
});
