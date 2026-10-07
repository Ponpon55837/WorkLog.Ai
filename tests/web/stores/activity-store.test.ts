import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useActivityStore } from "../../../apps/web/src/stores/activity.js";

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url }: StoreRequest): unknown {
  return url.pathname === "/api/insights/activity"
    ? {
        outcome: "activity",
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        days: [{ date: "2030-06-29", sessions: 2 }],
      }
    : {};
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 5, 30, 12));
  harness = createStoreHarness(responder);
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanup();
});

describe("activity store", () => {
  it("stays unloaded until active, then requests the 53-week range ending today", async () => {
    const store = useActivityStore();
    expect(store.activityLoaded).toBe(false);
    expect(harness.count("/api/insights/activity")).toBe(0);

    store.setActive(true);
    await vi.waitFor(() => expect(store.activityLoaded).toBe(true));
    const params = harness.calls.at(-1)!.url.searchParams;
    expect(params.get("to")).toBe("2030-06-30");
    expect(params.get("from")).toBe("2029-06-25");
    expect(store.days).toEqual([{ date: "2030-06-29", sessions: 2 }]);
  });
});
