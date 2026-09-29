import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutstandingItem, OutstandingItemStatus } from "@work-intelligence/core";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useOutstandingItemsStore } from "../../../apps/web/src/stores/outstanding-items.js";
import { useSessionsStore } from "../../../apps/web/src/stores/sessions.js";

const completedAt = "2026-09-29T00:00:00.000Z";
let harness: ReturnType<typeof createStoreHarness>;
let nextSteps: string[];
let sessionVoided: boolean;
let itemStatus: OutstandingItemStatus;

function createOutstandingItem(text: string, position: number, status: OutstandingItemStatus): OutstandingItem {
  return {
    id: `item-${position + 1}`,
    sourceSessionId: "session-1",
    projectId: "project-1",
    projectName: "Project One",
    sourceSessionTitle: "First Session",
    sourceSessionCompletedAt: completedAt,
    position,
    text,
    status,
    createdAt: completedAt,
    updatedAt: completedAt,
  };
}

function workResponder({ url, method, body }: StoreRequest): unknown {
  if (url.pathname === "/api/outstanding-items" && method === "GET") {
    const requestedStatus = (url.searchParams.get("status") ?? "pending") as OutstandingItemStatus;
    const items =
      sessionVoided || itemStatus !== requestedStatus
        ? []
        : nextSteps.map((text, position) => createOutstandingItem(text, position, itemStatus));
    const total = items.length;
    return {
      outcome: "outstanding_items",
      items,
      pageInfo: {
        page: 1,
        pageSize: 10,
        total,
        totalPages: Math.max(Math.ceil(total / 10), 1),
        from: total === 0 ? 0 : 1,
        to: total,
        hasPrevious: false,
        hasNext: false,
        truncated: false,
      },
    };
  }
  if (url.pathname === "/api/sessions/session-1/work-summary" && method === "PATCH") {
    const updatedNextSteps = (body as { workSummary?: { nextSteps?: string[] } }).workSummary?.nextSteps;
    if (updatedNextSteps) nextSteps = updatedNextSteps;
    return {
      outcome: "work_summary_updated",
      duplicate: false,
      session: { id: "session-1" },
      idempotencyKey: "edit-next-steps",
      mode: "patch",
      appliedWorkSummary: { nextSteps },
    };
  }
  if (url.pathname === "/api/sessions/session-1/void" && method === "PATCH") {
    sessionVoided = (body as { voided: boolean }).voided;
    return { outcome: "session_void_updated", sessionId: "session-1", voided: sessionVoided };
  }
  if (url.pathname === "/api/outstanding-items/item-1" && method === "PATCH") {
    itemStatus = (body as { status: OutstandingItemStatus }).status;
    return {
      outcome: "outstanding_item_updated",
      item: createOutstandingItem(nextSteps[0] ?? "Draft release notes", 0, itemStatus),
      duplicate: false,
    };
  }
  return {};
}

beforeEach(() => {
  nextSteps = ["Draft release notes"];
  sessionVoided = false;
  itemStatus = "pending";
  harness = createStoreHarness(workResponder);
});

afterEach(async () => harness.cleanup());

describe("Session mutations and outstanding items cache", () => {
  it("refreshes outstanding rows and total after editing nextSteps", async () => {
    const outstandingStore = useOutstandingItemsStore();
    outstandingStore.setListActive(true);
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(1));

    const listRequestCount = harness.count("/api/outstanding-items");
    const sessionsStore = useSessionsStore();
    await sessionsStore.saveSessionEdits({
      sessionId: "session-1",
      workSummary: {
        idempotencyKey: "edit-next-steps",
        sections: { nextSteps: ["Draft release notes", "Publish release notes"] },
      },
    });

    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(listRequestCount));
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(2));
    expect(outstandingStore.items.map((item) => item.text)).toEqual(["Draft release notes", "Publish release notes"]);
  });

  it("reloads pending and terminal views when an item moves from pending to completed", async () => {
    const outstandingStore = useOutstandingItemsStore();
    outstandingStore.setListActive(true);
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(1));
    expect(outstandingStore.items[0]?.status).toBe("pending");

    const listRequestCount = harness.count("/api/outstanding-items");
    await outstandingStore.updateStatus({ itemId: "item-1", status: "completed" });

    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(listRequestCount));
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(0));
    expect(outstandingStore.items).toEqual([]);

    outstandingStore.status = "completed";
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(1));
    expect(outstandingStore.items[0]?.status).toBe("completed");
  });

  it("refreshes outstanding rows and total after voiding a Session", async () => {
    const outstandingStore = useOutstandingItemsStore();
    outstandingStore.setListActive(true);
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(1));

    const listRequestCount = harness.count("/api/outstanding-items");
    const sessionsStore = useSessionsStore();
    await sessionsStore.setSessionVoid({ sessionId: "session-1", voided: true, reason: "Duplicate record" });

    await vi.waitFor(() => expect(harness.count("/api/outstanding-items")).toBeGreaterThan(listRequestCount));
    await vi.waitFor(() => expect(outstandingStore.pageInfo.total).toBe(0));
    expect(outstandingStore.items).toEqual([]);
  });
});
