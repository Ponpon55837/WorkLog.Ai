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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-cleanup-api-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { root, store, project };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  title: string,
  nextSteps: string[],
  completedAt: string,
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title,
    summary: `${title} synthetic summary.`,
    workSummary: {
      outcomes: [`${title} synthetic outcome.`],
      scope: [],
      decisions: [],
      verification: [],
      nextSteps,
    },
    changedFiles: [],
    verification: { status: "passed", summary: "Synthetic test verification." },
    completedAt,
  });
  if (result.outcome !== "finalized") throw new Error(`Expected a finalized fixture Session; got ${result.outcome}.`);
  return result.session;
}

function pendingItems(store: WorkIntelligenceStore, projectId: string) {
  const result = store.listOutstandingItems({ projectId, status: "pending", pageSize: 100 });
  if (result.outcome !== "outstanding_items") throw new Error("Expected pending fixture items.");
  return result.items;
}

describe("outstanding cleanup REST routes", () => {
  it("creates a fixed context, submits proposals, and accepts or rejects each proposal explicitly", async () => {
    const { root, store, project } = createFixture("Cleanup REST review fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const firstText = "Confirm the first cleanup obligation.";
    const secondText = "Confirm the second cleanup obligation.";
    const source = finalize(
      store,
      root,
      "cleanup-rest-source",
      "Cleanup REST source",
      [firstText, secondText],
      "2026-09-01T12:00:00.000Z",
    );
    const evidence = finalize(
      store,
      root,
      "cleanup-rest-evidence",
      "Cleanup REST verification",
      [],
      "2026-09-02T12:00:00.000Z",
    );
    const items = pendingItems(store, project.id);
    const first = items.find((item) => item.text === firstText);
    const second = items.find((item) => item.text === secondText);
    if (!first || !second) throw new Error("Expected the two synthetic obligations.");

    const creation = await requestJson<{
      outcome: string;
      duplicate: boolean;
      request: { id: string; status: string; itemCount: number };
    }>(handler, "/api/outstanding-cleanup/requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "cleanup-rest-request" },
    });
    expect(creation.status).toBe(201);
    expect(creation.body).toMatchObject({
      outcome: "outstanding_cleanup_request_created",
      duplicate: false,
      request: { status: "pending", itemCount: 2 },
    });
    const requestId = creation.body.request.id;
    expect(source.id).toBeTruthy();

    const replay = await requestJson<{ duplicate: boolean; request: { id: string } }>(
      handler,
      "/api/outstanding-cleanup/requests",
      { method: "POST", body: { projectId: project.id, idempotencyKey: "cleanup-rest-request" } },
    );
    expect(replay).toMatchObject({ status: 201, body: { duplicate: true, request: { id: requestId } } });
    const listedRequests = await requestJson<{ outcome: string; requests: Array<{ id: string }> }>(
      handler,
      `/api/outstanding-cleanup/requests?projectId=${encodeURIComponent(project.id)}&pageSize=5`,
    );
    expect(listedRequests).toMatchObject({
      status: 200,
      body: { outcome: "outstanding_cleanup_requests", requests: [expect.objectContaining({ id: requestId })] },
    });

    const context = await requestJson<{
      outcome: string;
      items: Array<{ id: string; sourceSessionId: string; stale: boolean }>;
      sessions: Array<{ id: string }>;
    }>(handler, `/api/outstanding-cleanup/requests/${requestId}/context`);
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      outcome: "outstanding_cleanup_context",
      items: expect.arrayContaining([
        expect.objectContaining({ id: first.id, sourceSessionId: source.id, stale: false }),
        expect.objectContaining({ id: second.id, sourceSessionId: source.id, stale: false }),
      ]),
    });
    expect(context.body.sessions.map(({ id }) => id)).toContain(evidence.id);

    const proposalBody = {
      idempotencyKey: "cleanup-rest-submission",
      examinedItemIds: [first.id, second.id],
      proposals: [
        {
          itemId: first.id,
          status: "completed",
          reason: "The later verification Session confirms completion.",
          evidenceSessionIds: [evidence.id],
        },
        {
          itemId: second.id,
          status: "not_needed",
          reason: "The later verified result makes this obligation unnecessary.",
          evidenceSessionIds: [evidence.id],
        },
      ],
    };
    const submitted = await requestJson<{
      outcome: string;
      duplicate: boolean;
      proposalIds: string[];
    }>(handler, `/api/outstanding-cleanup/requests/${requestId}/proposals`, {
      method: "POST",
      body: proposalBody,
    });
    expect(submitted).toMatchObject({
      status: 201,
      body: { outcome: "outstanding_cleanup_proposals_submitted", duplicate: false },
    });
    const replayedSubmission = await requestJson<{ duplicate: boolean; proposalIds: string[] }>(
      handler,
      `/api/outstanding-cleanup/requests/${requestId}/proposals`,
      { method: "POST", body: proposalBody },
    );
    expect(replayedSubmission).toMatchObject({
      status: 201,
      body: { duplicate: true, proposalIds: submitted.body.proposalIds },
    });
    expect(pendingItems(store, project.id).map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]));
    const beforeDecisions = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;

    const proposalList = await requestJson<{
      outcome: string;
      proposals: Array<{ id: string; itemId: string; reviewStatus: string }>;
    }>(handler, `/api/outstanding-cleanup/requests/${requestId}/proposals?pageSize=10`);
    expect(proposalList.status).toBe(200);
    expect(proposalList.body.proposals).toHaveLength(2);
    const firstProposal = proposalList.body.proposals.find(({ itemId }) => itemId === first.id);
    const secondProposal = proposalList.body.proposals.find(({ itemId }) => itemId === second.id);
    if (!firstProposal || !secondProposal) throw new Error("Expected both review proposals.");

    const accepted = await requestJson<{ outcome: string; decision: string }>(
      handler,
      `/api/outstanding-cleanup/requests/${requestId}/decisions`,
      { method: "POST", body: { proposalIds: [firstProposal.id], decision: "accept" } },
    );
    expect(accepted).toMatchObject({
      status: 200,
      body: { outcome: "outstanding_cleanup_proposals_decided", decision: "accept" },
    });
    const rejected = await requestJson<{ outcome: string; decision: string }>(
      handler,
      `/api/outstanding-cleanup/requests/${requestId}/decisions`,
      { method: "POST", body: { proposalIds: [secondProposal.id], decision: "reject" } },
    );
    expect(rejected).toMatchObject({
      status: 200,
      body: { outcome: "outstanding_cleanup_proposals_decided", decision: "reject" },
    });
    expect(pendingItems(store, project.id).map(({ id }) => id)).toContain(second.id);
    expect(store.listOutstandingItems({ projectId: project.id, status: "completed", pageSize: 10 })).toMatchObject({
      items: [expect.objectContaining({ id: first.id, status: "completed" })],
    });
    const afterDecisions = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;
    expect(afterDecisions.length).toBe(beforeDecisions.length + 1);
    expect(afterDecisions.at(-1)).toMatchObject({
      item_id: first.id,
      cleanup_request_id: requestId,
      cleanup_proposal_id: firstProposal.id,
      from_status: "pending",
      to_status: "completed",
    });
  });

  it("rejects a stale accept batch atomically, skips paused projects, cancels without changing items, and masks errors", async () => {
    const { root, store, project } = createFixture("Cleanup REST stale fixture");
    const handler = startApi(store);
    resources.push({ handler, store, root });
    const texts = ["Preserve atomic proposal one.", "Preserve atomic proposal two."];
    finalize(store, root, "cleanup-rest-stale-source", "Stale cleanup source", texts, "2026-09-01T12:00:00.000Z");
    const evidenceOne = finalize(
      store,
      root,
      "cleanup-rest-evidence-one",
      "Evidence one",
      [],
      "2026-09-02T12:00:00.000Z",
    );
    const evidenceTwo = finalize(
      store,
      root,
      "cleanup-rest-evidence-two",
      "Evidence two",
      [],
      "2026-09-03T12:00:00.000Z",
    );
    const items = pendingItems(store, project.id);
    const first = items.find((item) => item.text === texts[0]);
    const second = items.find((item) => item.text === texts[1]);
    if (!first || !second) throw new Error("Expected two cleanup snapshot items.");
    const creation = await requestJson<{ request: { id: string } }>(handler, "/api/outstanding-cleanup/requests", {
      method: "POST",
      body: { projectId: project.id, idempotencyKey: "cleanup-rest-stale-request" },
    });
    const requestId = creation.body.request.id;
    const submitted = await requestJson<{ proposalIds: string[] }>(
      handler,
      `/api/outstanding-cleanup/requests/${requestId}/proposals`,
      {
        method: "POST",
        body: {
          idempotencyKey: "cleanup-rest-stale-submit",
          examinedItemIds: [first.id, second.id],
          proposals: [
            {
              itemId: first.id,
              status: "completed",
              reason: "Evidence one verifies the first item.",
              evidenceSessionIds: [evidenceOne.id],
            },
            {
              itemId: second.id,
              status: "completed",
              reason: "Evidence two verifies the second item.",
              evidenceSessionIds: [evidenceTwo.id],
            },
          ],
        },
      },
    );
    expect(submitted.status).toBe(201);
    store.updateSessionSummary({
      sessionId: evidenceTwo.id,
      idempotencyKey: "cleanup-rest-correct-evidence",
      summary: "Corrected evidence invalidates the saved proposal fingerprint.",
    });
    const beforeEvents = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;
    const staleAccept = await requestJson<{ code: string; details: { reason: string; proposalIds: string[] } }>(
      handler,
      `/api/outstanding-cleanup/requests/${requestId}/decisions`,
      { method: "POST", body: { proposalIds: submitted.body.proposalIds, decision: "accept" } },
    );
    expect(staleAccept).toMatchObject({
      status: 409,
      body: { code: "conflict", details: { reason: "stale_proposal", proposalIds: [expect.any(String)] } },
    });
    expect(pendingItems(store, project.id).map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(store.exportProjectData({ type: "project", projectId: project.id }).tables.outstanding_item_events).toEqual(
      beforeEvents,
    );
    expect(
      await requestJson<{ proposals: Array<{ reviewStatus: string }> }>(
        handler,
        `/api/outstanding-cleanup/requests/${requestId}/proposals`,
      ),
    ).toMatchObject({ status: 200, body: { proposals: [{ reviewStatus: "pending" }, { reviewStatus: "pending" }] } });

    const pausedRoot = join(root, "paused-project");
    const paused = store.addProject("Cleanup REST paused fixture", pausedRoot);
    store.updateProject(paused.id, { status: "tracked" });
    finalize(
      store,
      pausedRoot,
      "cleanup-rest-paused-source",
      "Paused source",
      ["Leave this paused item alone."],
      "2026-09-01T12:00:00.000Z",
    );
    store.updateProject(paused.id, { status: "paused" });
    const skipped = await requestJson<{ outcome: string; projectStatus: string }>(
      handler,
      "/api/outstanding-cleanup/requests",
      { method: "POST", body: { projectId: paused.id, idempotencyKey: "cleanup-rest-paused-request" } },
    );
    expect(skipped).toMatchObject({ status: 200, body: { outcome: "skipped", projectStatus: "paused" } });

    const cancelProjectRoot = join(root, "cancel-project");
    const cancelProject = store.addProject("Cleanup REST cancellation fixture", cancelProjectRoot);
    store.updateProject(cancelProject.id, { status: "tracked" });
    const cancelText = "Cancellation leaves the outstanding item pending.";
    finalize(
      store,
      cancelProjectRoot,
      "cleanup-rest-cancel-source",
      "Cancel source",
      [cancelText],
      "2026-09-01T12:00:00.000Z",
    );
    const cancelCreate = await requestJson<{ request: { id: string } }>(handler, "/api/outstanding-cleanup/requests", {
      method: "POST",
      body: { projectId: cancelProject.id, idempotencyKey: "cleanup-rest-cancel-request" },
    });
    const cancelled = await requestJson<{ outcome: string; request: { status: string } }>(
      handler,
      `/api/outstanding-cleanup/requests/${cancelCreate.body.request.id}/cancel`,
      { method: "POST", body: {} },
    );
    expect(cancelled).toMatchObject({
      status: 200,
      body: { outcome: "outstanding_cleanup_request_cancelled", request: { status: "cancelled" } },
    });
    expect(pendingItems(store, cancelProject.id).map(({ text }) => text)).toContain(cancelText);

    vi.spyOn(store, "getOutstandingCleanupContext").mockImplementation(() => {
      throw new Error("private database path and SQL details");
    });
    const masked = await requestJson<{ error: string; code: string }>(
      handler,
      `/api/outstanding-cleanup/requests/${cancelCreate.body.request.id}/context`,
    );
    expect(masked).toMatchObject({ status: 500, body: { error: "Internal server error.", code: "internal_error" } });
    expect(JSON.stringify(masked.body)).not.toContain("private database path");
  });
});
