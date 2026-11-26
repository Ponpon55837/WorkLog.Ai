import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentReviewStore } from "../../../apps/web/src/stores/agent-review.js";
import { useSessionDecisionsStore } from "../../../apps/web/src/stores/session-decisions.js";
import { createStoreHarness, type StoreRequest } from "../helpers/store-harness.js";

const request = {
  id: "review-1",
  projectId: "project-1",
  status: "pending",
  requestedAt: "2026-10-01T00:00:00Z",
  itemCount: 3,
  omittedCount: 0,
  decisionCount: 2,
  candidateCount: 1,
  knowledgeCount: 2,
  appliedCount: 0,
  skippedCount: 0,
  openCount: 3,
};
const pageInfo = { page: 1, pageSize: 1, total: 1, totalPages: 1, from: 1, to: 1, hasPrevious: false, hasNext: false };
let harness: ReturnType<typeof createStoreHarness>;
let requestStatus = "pending";

function responder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/agent-review-requests" && method === "GET")
    return {
      outcome: "agent_review_requests",
      requests: [{ ...request, status: requestStatus }],
      pageInfo,
    };
  if (url.pathname === "/api/agent-review-requests" && method === "POST")
    return { outcome: "agent_review_request", request, duplicate: false };
  if (url.pathname === "/api/knowledge/candidates")
    return { outcome: "knowledge_candidates", items: [], openRequests: [], backlog: [] };
  if (url.pathname === "/api/session-decisions") return { outcome: "session_decisions", items: [], pendingCount: 0 };
  if (url.pathname === "/api/agent-review-knowledge") return { outcome: "agent_reviewed_knowledge", items: [] };
  return { outcome: "agent_review_overturned", itemKind: "decision" };
}

beforeEach(() => {
  requestStatus = "pending";
  harness = createStoreHarness(responder);
});
afterEach(async () => harness.cleanup());

describe("agent review store", () => {
  it("shows the latest open request for the project and hides cancelled ones", async () => {
    const store = useAgentReviewStore();
    store.setScope("project-1", "/work/orchard");
    store.setActive(true);
    await vi.waitFor(() => expect(store.requestLoaded).toBe(true));
    expect(store.latestRequest?.id).toBe("review-1");
    expect(store.hasOpenRequest).toBe(true);
    expect(harness.calls[0]?.url.search).toBe("?projectId=project-1&page=1&pageSize=1");

    requestStatus = "cancelled";
    store.setScope("project-1", "/work/orchard");
    await store.createRequest();
    await vi.waitFor(() => expect(store.latestRequest).toBeUndefined());
  });

  it("does not query without a single project", () => {
    const store = useAgentReviewStore();
    store.setActive(true);
    expect(harness.count("/api/agent-review-requests")).toBe(0);
  });

  it("reuses the idempotency key until a request is created", async () => {
    const store = useAgentReviewStore();
    store.setScope("project-1", "/work/orchard");
    harness.setResponder((input) => {
      if (input.method === "POST") throw new Error("offline");
      return responder(input);
    });
    await expect(store.createRequest()).rejects.toThrow();
    harness.setResponder(responder);
    await store.createRequest();
    const keys = harness.calls
      .filter((call) => call.method === "POST")
      .map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("loads Agent-processed lists only for the agent filter", async () => {
    const store = useAgentReviewStore();
    const decisions = useSessionDecisionsStore();
    decisions.setListActive(true, "/work/orchard");
    store.setActive(true);
    await vi.waitFor(() => expect(harness.count("/api/session-decisions")).toBe(1));
    expect(harness.calls.find((call) => call.url.pathname === "/api/session-decisions")?.url.search).toContain(
      "status=pending",
    );
    expect(harness.calls.some((call) => call.url.searchParams.get("reviewedBy") === "agent")).toBe(false);

    store.filter = "agent";
    await vi.waitFor(() =>
      expect(
        harness.calls.some(
          (call) =>
            call.url.pathname === "/api/session-decisions" && call.url.searchParams.get("status") === "agent_reviewed",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(store.reviewedCandidatesLoaded).toBe(true));
    expect(harness.calls.some((call) => call.url.searchParams.get("reviewedBy") === "agent")).toBe(true);
  });

  it("refreshes decisions and candidates after an overturn", async () => {
    const store = useAgentReviewStore();
    const decisions = useSessionDecisionsStore();
    decisions.setListActive(true, "/work/orchard");
    await vi.waitFor(() => expect(harness.count("/api/session-decisions")).toBe(1));
    const result = await store.overturn({ projectRoot: "/work/orchard", itemKind: "decision", itemId: "d1" });
    expect(result.outcome).toBe("agent_review_overturned");
    expect(harness.count("/api/session-decisions/d1/overturn", "POST")).toBe(1);
    await vi.waitFor(() => expect(harness.count("/api/session-decisions")).toBeGreaterThan(1));
  });

  it("loads Agent-processed Knowledge only while the list is active, keyed by project root", async () => {
    const store = useAgentReviewStore();
    store.setActive(true);
    await Promise.resolve();
    expect(harness.count("/api/agent-review-knowledge")).toBe(0);

    store.setScope("project-1", "/work/orchard");
    store.setKnowledgeActive(true);
    await vi.waitFor(() => expect(store.reviewedKnowledgeLoaded).toBe(true));
    expect(harness.calls.find((call) => call.url.pathname === "/api/agent-review-knowledge")?.url.search).toBe(
      "?projectRoot=%2Fwork%2Forchard",
    );

    store.setScope("project-2", "/work/harbour");
    await vi.waitFor(() =>
      expect(
        harness.calls.some(
          (call) =>
            call.url.pathname === "/api/agent-review-knowledge" &&
            call.url.searchParams.get("projectRoot") === "/work/harbour",
        ),
      ).toBe(true),
    );
    expect(harness.count("/api/agent-review-knowledge")).toBe(2);
  });

  it("refreshes the Agent-processed Knowledge list after overturning Knowledge", async () => {
    const store = useAgentReviewStore();
    store.setScope("project-1", "/work/orchard");
    store.setActive(true);
    store.setKnowledgeActive(true);
    await vi.waitFor(() => expect(harness.count("/api/agent-review-knowledge")).toBe(1));
    harness.setResponder((input) =>
      input.method === "POST" ? { outcome: "agent_review_overturned", itemKind: "knowledge" } : responder(input),
    );
    await store.overturn({ projectRoot: "/work/orchard", itemKind: "knowledge", itemId: "k1" });
    expect(harness.count("/api/knowledge/k1/overturn", "POST")).toBe(1);
    await vi.waitFor(() => expect(harness.count("/api/agent-review-knowledge")).toBeGreaterThan(1));
  });
});
