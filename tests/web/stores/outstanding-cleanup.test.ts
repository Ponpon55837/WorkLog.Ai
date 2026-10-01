import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutstandingCleanupStore } from "../../../apps/web/src/stores/outstanding-cleanup.js";
import { useOutstandingItemsStore } from "../../../apps/web/src/stores/outstanding-items.js";
import { createStoreHarness, jsonResponse, type StoreRequest } from "../helpers/store-harness.js";

const requestRecord = {
  id: "cleanup-1",
  projectId: "project-1",
  projectName: "Fixture",
  status: "awaiting_review",
  requestedAt: "2026-09-20T00:00:00Z",
  itemCount: 120,
  examinedCount: 120,
  proposalCount: 120,
  pendingProposalCount: 120,
};
const pageInfo = {
  page: 1,
  pageSize: 100,
  total: 120,
  totalPages: 2,
  from: 1,
  to: 100,
  hasPrevious: false,
  hasNext: true,
  truncated: false,
};
const decisionRefreshScenarios = [
  { name: "a committed acceptance", conflict: false },
  { name: "a real conflict", conflict: true },
] as const;
let harness: ReturnType<typeof createStoreHarness>;
function responder({ url, method, body }: StoreRequest): unknown {
  if (url.pathname === "/api/outstanding-cleanup/requests" && method === "GET")
    return { outcome: "outstanding_cleanup_requests", requests: [requestRecord], pageInfo };
  if (url.pathname.endsWith("/proposals"))
    return { outcome: "outstanding_cleanup_proposals", request: requestRecord, proposals: [], pageInfo };
  if (url.pathname.endsWith("/decisions"))
    return {
      outcome: "outstanding_cleanup_proposals_decided",
      request: requestRecord,
      proposalIds: (body as { proposalIds: string[] }).proposalIds,
      decision: "accept",
      duplicate: false,
    };
  if (url.pathname === "/api/outstanding-items") return { outcome: "outstanding_items", items: [], pageInfo };
  return {};
}
beforeEach(() => {
  harness = createStoreHarness(responder);
});
afterEach(async () => harness.cleanup());

describe("outstanding cleanup store", () => {
  it("requires one project, keys review filters, caps All at 100, and invalidates outstanding items on acceptance", async () => {
    const store = useOutstandingCleanupStore();
    const items = useOutstandingItemsStore();
    store.setActive(true);
    await Promise.resolve();
    expect(harness.count("/api/outstanding-cleanup/requests")).toBe(0);
    items.projectId = "project-1";
    items.setListActive(true);
    store.requestId = "cleanup-1";
    store.requestPageSize = "all";
    store.proposalPageSize = "all";
    await vi.waitFor(() => expect(store.requestPageInfo.truncated).toBe(true));
    await vi.waitFor(() => expect(store.proposalPageInfo.truncated).toBe(true));
    const latest = () => [...harness.calls].reverse().find((call) => call.url.pathname.endsWith("/proposals"));
    expect(latest()?.url.searchParams.get("pageSize")).toBe("100");
    store.reviewStatus = "rejected";
    await vi.waitFor(() => expect(latest()?.url.searchParams.get("reviewStatus")).toBe("rejected"));
    store.proposalPage = 2;
    await vi.waitFor(() => expect(latest()?.url.searchParams.get("page")).toBe("2"));
    const beforeItems = harness.count("/api/outstanding-items");
    const beforeProposals = harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals");
    await store.decide(["proposal-1"], "accept");
    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(beforeItems));
    expect(harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals")).toBeGreaterThan(beforeProposals);
  });
  it("keeps cross-project responses out of review and refreshes proposals after an atomic conflict", async () => {
    const store = useOutstandingCleanupStore();
    useOutstandingItemsStore().projectId = "project-1";
    store.requestId = "cleanup-1";
    store.setActive(true);
    await vi.waitFor(() => expect(store.selectedRequest?.id).toBe("cleanup-1"));
    harness.setResponder((input) =>
      input.url.pathname.endsWith("/decisions")
        ? jsonResponse({ code: "conflict", error: "Conflict" }, 409)
        : responder(input),
    );
    const before = harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals");
    await expect(store.decide(["proposal-1"], "accept")).rejects.toThrow("整批未套用");
    await vi.waitFor(() =>
      expect(harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals")).toBeGreaterThan(before),
    );
    useOutstandingItemsStore().projectId = "project-2";
    await vi.waitFor(() => expect(store.proposalError).toContain("其他專案"));
    expect(store.proposals).toEqual([]);
  });

  it.each(decisionRefreshScenarios)("preserves $name when its proposal refresh is aborted", async ({ conflict }) => {
    const items = useOutstandingItemsStore();
    items.projectId = "project-1";
    const store = useOutstandingCleanupStore();
    store.requestId = "cleanup-1";
    store.setActive(true);
    await vi.waitFor(() => expect(store.selectedRequest?.id).toBe("cleanup-1"));
    const proposalPath = "/api/outstanding-cleanup/requests/cleanup-1/proposals";
    await vi.waitFor(() => expect(harness.count(proposalPath)).toBe(1));

    let holdNextProposalRead = true;
    let proposalReadAborted = false;
    let notifyProposalReadStarted: () => void = () => undefined;
    const proposalReadStarted = new Promise<void>((resolve) => {
      notifyProposalReadStarted = resolve;
    });
    harness.setResponder((request) => {
      if (conflict && request.url.pathname.endsWith("/decisions"))
        return jsonResponse({ code: "conflict", error: "Conflict" }, 409);
      if (request.url.pathname === proposalPath && request.method === "GET" && holdNextProposalRead) {
        holdNextProposalRead = false;
        notifyProposalReadStarted();
        return new Promise<never>((_resolve, reject) => {
          const signal = request.signal;
          if (!signal) {
            reject(new Error("The proposal refresh should receive an abort signal."));
            return;
          }
          const onAbort = () => {
            proposalReadAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      return responder(request);
    });

    const decision = store.decide(["proposal-1"], "accept");
    await proposalReadStarted;
    const refresh = store.reload();
    if (conflict) await expect(decision).rejects.toThrow("整批未套用");
    else await expect(decision).resolves.toBeUndefined();
    await refresh;

    expect(proposalReadAborted).toBe(true);
  });
});
