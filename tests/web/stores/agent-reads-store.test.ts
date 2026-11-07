import { useQueryCache } from "@pinia/colada";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useAgentReadsStore } from "../../../apps/web/src/stores/agent-reads.js";
import { queryKeys } from "../../../apps/web/src/stores/query-keys.js";

let harness: ReturnType<typeof createStoreHarness>;

const stats = {
  tools: [
    {
      tool: "work_recall",
      count: 3,
      errorCount: 1,
      timedCount: 3,
      p50Ms: 12,
      p95Ms: 40,
      maxMs: 40,
      errorCodes: { database_busy: 1 },
    },
  ],
};

function responder({ url }: StoreRequest): unknown {
  if (url.pathname === "/api/agent-reads/stats") return stats;
  return url.pathname === "/api/agent-reads"
    ? {
        items: [],
        pageInfo: { page: Number(url.searchParams.get("page") ?? 1), pageSize: 10, total: 0, totalPages: 1 },
        agents: ["fiction-client"],
      }
    : {};
}

beforeEach(() => {
  harness = createStoreHarness(responder);
});

afterEach(async () => {
  await harness.cleanup();
});

describe("agent reads store", () => {
  it("stays unloaded until active, then sends the filters and the capped page size", async () => {
    const store = useAgentReadsStore();
    store.projectId = "project-1";
    store.agent = "fiction-client";
    store.pageSize = "all";
    await nextTick();
    expect(harness.count("/api/agent-reads")).toBe(0);

    store.setListActive(true);
    await vi.waitFor(() => expect(store.loaded).toBe(true));
    const params = harness.calls.filter((call) => call.url.pathname === "/api/agent-reads").at(-1)!.url.searchParams;
    expect(params.get("projectId")).toBe("project-1");
    expect(params.get("agent")).toBe("fiction-client");
    expect(params.get("pageSize")).toBe("100");
    expect(store.agentOptions).toEqual(["fiction-client"]);
  });

  it("loads per-tool stats with the same filters under the agent reads key prefix", async () => {
    const store = useAgentReadsStore();
    store.projectId = "project-1";
    store.agent = "fiction-client";
    await nextTick();
    expect(harness.count("/api/agent-reads/stats")).toBe(0);
    expect(store.statsLoaded).toBe(false);

    store.setListActive(true);
    await vi.waitFor(() => expect(store.statsLoaded).toBe(true));
    const params = harness.calls.filter((call) => call.url.pathname === "/api/agent-reads/stats").at(-1)!.url
      .searchParams;
    expect(params.get("projectId")).toBe("project-1");
    expect(params.get("agentClient")).toBe("fiction-client");
    expect(params.has("page")).toBe(false);
    expect(store.toolStats).toEqual(stats.tools);
    expect(store.statsError).toBe("");

    const before = harness.count("/api/agent-reads/stats");
    await useQueryCache().invalidateQueries({ key: queryKeys.agentReads.all });
    await vi.waitFor(() => expect(harness.count("/api/agent-reads/stats")).toBeGreaterThan(before));
  });

  it("returns to page 1 on a filter change but keeps a page restored together with the filters", async () => {
    const store = useAgentReadsStore();
    store.page = 3;
    await nextTick();

    store.agent = "fiction-client";
    await nextTick();
    expect(store.page).toBe(1);

    store.projectId = "project-1";
    store.page = 2;
    await nextTick();
    expect(store.page).toBe(2);
  });
});
