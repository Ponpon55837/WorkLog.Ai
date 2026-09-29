import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutstandingItem, OutstandingItemStatus } from "@work-intelligence/core";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useOutstandingItemsStore } from "../../../apps/web/src/stores/outstanding-items.js";

const outstandingItem: OutstandingItem = {
  id: "item-1",
  sourceSessionId: "session-1",
  projectId: "project-1",
  projectName: "Project One",
  sourceSessionTitle: "First Session",
  sourceSessionCompletedAt: "2026-09-29T00:00:00.000Z",
  position: 0,
  text: "Follow up on the migration",
  status: "pending",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url, method, body }: StoreRequest): unknown {
  if (url.pathname === "/api/outstanding-items" && method === "GET") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    return {
      outcome: "outstanding_items",
      items: [outstandingItem],
      pageInfo: {
        page,
        pageSize,
        total: 1,
        totalPages: 1,
        from: 1,
        to: 1,
        hasPrevious: false,
        hasNext: false,
        truncated: false,
      },
    };
  }
  if (url.pathname === "/api/outstanding-items/item-1" && method === "PATCH") {
    const status = (body as { status: OutstandingItemStatus }).status;
    return { outcome: "outstanding_item_updated", duplicate: false, item: { ...outstandingItem, status } };
  }
  return {};
}

beforeEach(() => {
  harness = createStoreHarness(responder);
});

afterEach(async () => harness.cleanup());

describe("outstanding items store", () => {
  it("keys the list by each URL filter and pagination value, then invalidates it after a status update", async () => {
    const store = useOutstandingItemsStore();
    store.setListActive(true);
    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBe(1));

    store.projectId = "project-1";
    store.status = "not_needed";
    store.page = 2;
    store.pageSize = 20;

    const latestListRequest = () =>
      [...harness.calls].reverse().find((request) => request.url.pathname === "/api/outstanding-items");
    await vi.waitFor(() => expect(latestListRequest()?.url.searchParams.get("pageSize")).toBe("20"));
    expect(latestListRequest()?.url.searchParams.get("projectId")).toBe("project-1");
    expect(latestListRequest()?.url.searchParams.get("status")).toBe("not_needed");
    expect(latestListRequest()?.url.searchParams.get("page")).toBe("2");

    const listCountBeforeUpdate = harness.count("/api/outstanding-items");
    const updated = await store.updateStatus({ itemId: "item-1", status: "pending" });
    expect(updated.status).toBe("pending");
    expect(harness.count("/api/outstanding-items/item-1", "PATCH")).toBe(1);
    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(listCountBeforeUpdate));
  });
});
