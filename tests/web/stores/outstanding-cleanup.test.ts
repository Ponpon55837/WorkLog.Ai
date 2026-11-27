import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutstandingCleanupStore } from "../../../apps/web/src/stores/outstanding-cleanup.js";
import { useOutstandingItemsStore } from "../../../apps/web/src/stores/outstanding-items.js";
import { createStoreHarness, jsonResponse, type StoreRequest } from "../helpers/store-harness.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const requestRecord = {
  id: "cleanup-1",
  projectId: "project-1",
  projectName: "Fixture",
  status: "completed",
  requestedAt: "2026-09-20T00:00:00Z",
  itemCount: 120,
  examinedCount: 120,
  proposalCount: 120,
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
let harness: ReturnType<typeof createStoreHarness>;
function responder({ url, method, body }: StoreRequest): unknown {
  if (url.pathname === "/api/outstanding-cleanup/requests" && method === "GET")
    return { outcome: "outstanding_cleanup_requests", requests: [requestRecord], pageInfo };
  if (url.pathname.endsWith("/proposals"))
    return { outcome: "outstanding_cleanup_proposals", request: requestRecord, proposals: [], pageInfo };
  if (url.pathname === "/api/outstanding-items/batch" && method === "PATCH")
    return {
      outcome: "outstanding_items_updated",
      items: [],
      updatedItemIds: (body as { itemIds: string[] }).itemIds,
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
  it("keeps loaded request evidence during refresh and resets readiness for a different project", async () => {
    const items = useOutstandingItemsStore();
    items.projectId = "project-1";
    const store = useOutstandingCleanupStore();
    expect(store.requestsLoaded).toBe(false);
    store.setActive(true);
    await vi.waitFor(() => expect(store.requestsLoaded).toBe(true));
    let releaseRead: (value: unknown) => void = () => undefined;
    harness.setResponder((input) =>
      input.url.pathname === "/api/outstanding-cleanup/requests"
        ? new Promise((resolve) => {
            releaseRead = resolve;
          })
        : responder(input),
    );
    const refresh = store.reload();
    await vi.waitFor(() => expect(store.loading).toBe(true));
    expect(store.requestsLoaded).toBe(true);
    expect(store.requests[0]?.id).toBe("cleanup-1");
    releaseRead(responder(harness.calls.at(-1)!));
    await refresh;
    items.projectId = "project-2";
    await vi.waitFor(() => expect(store.requestsLoaded).toBe(false));
    releaseRead({ outcome: "outstanding_cleanup_requests", requests: [], pageInfo });
    await vi.waitFor(() => expect(store.requestsLoaded).toBe(true));
    expect(store.requests).toEqual([]);
  });
  it("requires one project, always reads applied verdicts, caps All at 100 and reopens closed items", async () => {
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
    expect(latest()?.url.searchParams.get("reviewStatus")).toBe("accepted");
    store.proposalPage = 2;
    await vi.waitFor(() => expect(latest()?.url.searchParams.get("page")).toBe("2"));
    const beforeItems = harness.count("/api/outstanding-items");
    const beforeProposals = harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals");
    await expect(
      store.reopen([
        { itemId: "item-1", status: "completed" },
        { itemId: "item-2", status: "completed" },
      ]),
    ).resolves.toBe(2);
    const batch = harness.calls.filter((call) => call.url.pathname === "/api/outstanding-items/batch");
    expect(batch).toHaveLength(1);
    expect(batch[0]?.body).toEqual({ itemIds: ["item-1", "item-2"], status: "pending", expectedStatus: "completed" });
    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(beforeItems));
    expect(harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals")).toBeGreaterThan(beforeProposals);
  });

  it("keeps cross-project responses out of the closed list and refreshes proposals after a failed reopen", async () => {
    const store = useOutstandingCleanupStore();
    useOutstandingItemsStore().projectId = "project-1";
    store.requestId = "cleanup-1";
    store.setActive(true);
    await vi.waitFor(() => expect(store.selectedRequest?.id).toBe("cleanup-1"));
    harness.setResponder((input) =>
      input.url.pathname === "/api/outstanding-items/batch"
        ? jsonResponse({ code: "conflict", error: "Conflict" }, 409)
        : responder(input),
    );
    const before = harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals");
    await expect(store.reopen([{ itemId: "item-1", status: "completed" }])).rejects.toThrow();
    await vi.waitFor(() =>
      expect(harness.count("/api/outstanding-cleanup/requests/cleanup-1/proposals")).toBeGreaterThan(before),
    );
    useOutstandingItemsStore().projectId = "project-2";
    await vi.waitFor(() => expect(store.proposalError).toBe(t("outstanding.thisRequestBelongsToAnother")));
    expect(store.proposals).toEqual([]);
  });
});
