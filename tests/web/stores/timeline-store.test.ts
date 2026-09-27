import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useGraphStore } from "../../../apps/web/src/stores/graph.js";
import { useTimelineStore } from "../../../apps/web/src/stores/timeline.js";

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url }: StoreRequest): unknown {
  if (url.pathname === "/api/insights/timeline") {
    return url.searchParams.get("projectId") === "paused"
      ? { outcome: "skipped", reason: "此專案已暫停記錄。" }
      : {
          outcome: "timeline",
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          projects: [],
          sessions: [],
          knowledgeEvents: [],
          links: [],
          truncated: false,
        };
  }
  if (url.pathname === "/api/graph/path") {
    return {
      outcome: "graph_path",
      found: true,
      steps: [{ edge: { id: "edge-1" }, reason: "step" }],
      searchedNodes: 2,
    };
  }
  if (url.pathname === "/api/graph") {
    return { outcome: "graph", projects: [], nodes: [], edges: [], sourceProjectIds: [], sourceSessionIds: [] };
  }
  return {};
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2031, 2, 20, 12));
  harness = createStoreHarness(responder);
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.cleanup();
});

describe("timeline store", () => {
  it("requests the chosen range up to today and reports a skipped project", async () => {
    const store = useTimelineStore();
    store.setActive(true);
    await vi.waitFor(() => expect(store.timeline).not.toBeNull());
    expect(store.timeline).toMatchObject({ from: "2031-02-19", to: "2031-03-20" });

    store.range = "7";
    await vi.waitFor(() => expect(store.timeline?.from).toBe("2031-03-14"));

    store.projectId = "paused";
    await vi.waitFor(() => expect(store.timelineError).toBe("此專案已暫停記錄。"));
    expect(store.timeline).toBeNull();
  });
});

describe("graph path", () => {
  it("finds a path between two nodes, highlights its edges, and clears it", async () => {
    const store = useGraphStore();
    store.findGraphPath("session:a", "file:p:b");
    await vi.waitFor(() => expect(store.graphPath?.found).toBe(true));
    expect([...store.graphPathEdgeIds]).toEqual(["edge-1"]);
    const request = harness.calls.find((call) => call.url.pathname === "/api/graph/path");
    expect(request?.url.searchParams.get("from")).toBe("session:a");

    store.graphShowDerived = true;
    await vi.waitFor(() =>
      expect(harness.calls.some((call) => call.url.searchParams.get("includeDerived") === "true")).toBe(true),
    );
    store.clearGraphPath();
    expect(store.graphPath).toBeNull();
    expect(store.graphPathEdgeIds.size).toBe(0);
  });
});
