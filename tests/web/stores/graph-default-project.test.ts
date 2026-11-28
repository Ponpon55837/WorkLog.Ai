import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useGraphStore } from "../../../apps/web/src/stores/graph.js";

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url }: StoreRequest): unknown {
  if (url.pathname === "/api/graph") {
    return {
      outcome: "graph",
      nodes: [],
      edges: [],
      projects: [],
      sourceProjectIds: [],
      sourceSessionIds: [],
      totalNodes: 0,
      totalEdges: 0,
      truncation: { nodesTruncated: false, edgesTruncated: false },
    };
  }
  return {};
}

beforeEach(() => {
  harness = createStoreHarness(responder);
});

afterEach(async () => harness.cleanup());

describe("graph default project", () => {
  it("waits for the default project before the first request and then scopes to it", async () => {
    const store = useGraphStore();
    store.setGraphActive(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.count("/api/graph")).toBe(0);

    store.resolveDefaultGraphProject("project-recent");

    await vi.waitFor(() => expect(harness.count("/api/graph")).toBe(1));
    expect(store.graphProjectId).toBe("project-recent");
    expect(harness.calls.find(({ url }) => url.pathname === "/api/graph")?.url.searchParams.get("projectId")).toBe(
      "project-recent",
    );
  });

  it("keeps a project that was already chosen", async () => {
    const store = useGraphStore();
    store.graphProjectId = "from-url";

    store.resolveDefaultGraphProject("project-recent");

    expect(store.graphProjectId).toBe("from-url");
  });

  it("applies the default once, so choosing all projects afterwards sticks", () => {
    const store = useGraphStore();
    store.resolveDefaultGraphProject("project-recent");
    store.graphProjectId = "";

    store.resolveDefaultGraphProject("project-other");

    expect(store.graphProjectId).toBe("");
  });

  it("starts unscoped when there is no project to default to", () => {
    const store = useGraphStore();
    store.resolveDefaultGraphProject(undefined);

    expect(store.graphProjectResolved).toBe(true);
    expect(store.graphProjectId).toBe("");
  });
});
