import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useAgentReadsStore } from "../../../apps/web/src/stores/agent-reads.js";

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url }: StoreRequest): unknown {
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
    const params = harness.calls.at(-1)!.url.searchParams;
    expect(params.get("projectId")).toBe("project-1");
    expect(params.get("agent")).toBe("fiction-client");
    expect(params.get("pageSize")).toBe("100");
    expect(store.agentOptions).toEqual(["fiction-client"]);
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
