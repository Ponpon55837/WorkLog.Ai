import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutstandingCleanupStore } from "../../../apps/web/src/stores/outstanding-cleanup.js";
import { useOutstandingItemsStore } from "../../../apps/web/src/stores/outstanding-items.js";
import { useProjectsStore } from "../../../apps/web/src/stores/projects.js";
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
      input.url.pathname === "/api/outstanding-cleanup/requests" && !input.url.searchParams.has("status")
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
  it("exposes the request waiting for the Agent and cancels it by id", async () => {
    const waiting = { ...requestRecord, id: "cleanup-2", status: "pending" };
    harness.setResponder((input) => {
      if (input.url.pathname === "/api/outstanding-cleanup/requests" && input.method === "GET")
        return { outcome: "outstanding_cleanup_requests", requests: [waiting, requestRecord], pageInfo };
      if (input.url.pathname === "/api/outstanding-cleanup/requests/cleanup-2/cancel")
        return {
          outcome: "outstanding_cleanup_request_cancelled",
          request: { ...waiting, status: "cancelled" },
          duplicate: false,
        };
      return responder(input);
    });
    const items = useOutstandingItemsStore();
    items.projectId = "project-1";
    const store = useOutstandingCleanupStore();
    store.setActive(true);
    await vi.waitFor(() => expect(store.activeRequest?.id).toBe("cleanup-2"));
    expect(harness.calls.some((call) => call.url.searchParams.get("status") === "pending")).toBe(true);

    await store.cancelRequest("cleanup-2");

    expect(harness.count("/api/outstanding-cleanup/requests/cleanup-2/cancel", "POST")).toBe(1);
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

  it("counts pending items for each tracked project when none is chosen, leaving out projects with none", async () => {
    const totals: Record<string, number> = { "project-1": 4, "project-2": 2, "project-3": 0 };
    harness.setResponder((input) => {
      if (input.url.pathname === "/api/projects")
        return [
          { id: "project-1", name: "Orchard", status: "tracked" },
          { id: "project-2", name: "Barn", status: "tracked" },
          { id: "project-3", name: "Empty", status: "tracked" },
          { id: "project-4", name: "Paused", status: "paused" },
        ];
      if (input.url.pathname === "/api/outstanding-items")
        return {
          outcome: "outstanding_items",
          items: [],
          pageInfo: { ...pageInfo, total: totals[input.url.searchParams.get("projectId") ?? ""] ?? 9 },
        };
      return responder(input);
    });
    await useProjectsStore().loadProjects();
    const store = useOutstandingCleanupStore();
    store.setActive(true);

    await vi.waitFor(() => expect(store.pendingProjectsLoaded).toBe(true));

    expect(store.pendingProjects).toEqual([
      { projectId: "project-1", projectName: "Orchard", pendingCount: 4 },
      { projectId: "project-2", projectName: "Barn", pendingCount: 2 },
    ]);
    expect(harness.count("/api/outstanding-cleanup/requests")).toBe(0);
    store.chooseProject("project-2");
    expect(useOutstandingItemsStore().projectId).toBe("project-2");
  });
});
