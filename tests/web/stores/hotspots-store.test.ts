import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useHotspotsStore } from "../../../apps/web/src/stores/hotspots.js";

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url }: StoreRequest): unknown {
  if (url.pathname === "/api/insights/hotspots") {
    return url.searchParams.get("projectId") === "paused"
      ? { outcome: "skipped", reason: "此專案已暫停記錄。" }
      : { outcome: "hotspots", groupBy: url.searchParams.get("groupBy"), items: [{ path: "src/a.ts" }] };
  }
  return {};
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

describe("hotspots store", () => {
  it("keys requests by project, grouping, and period, and reports a skipped project", async () => {
    const store = useHotspotsStore();
    store.setActive(true);
    await vi.waitFor(() => expect(store.hotspots).toHaveLength(1));
    const first = harness.calls.at(-1)!.url.searchParams;
    expect(first.get("groupBy")).toBe("file");
    expect(first.get("from")).toBe("2030-04-02");

    store.groupBy = "directory";
    store.period = "all";
    await vi.waitFor(() => expect(harness.calls.at(-1)!.url.searchParams.get("groupBy")).toBe("directory"));
    expect(harness.calls.at(-1)!.url.searchParams.has("from")).toBe(false);

    store.projectId = "paused";
    await vi.waitFor(() => expect(store.hotspotsError).toBe("此專案已暫停記錄。"));
    expect(store.hotspots).toEqual([]);
  });
});
