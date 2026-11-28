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

  it("keeps the project named in the URL and never waits for a default", async () => {
    const store = useGraphStore();
    store.graphProjectParam = "from-url";
    store.setGraphActive(true);

    expect(store.graphProjectResolved).toBe(true);
    store.resolveDefaultGraphProject("project-recent");

    expect(store.graphProjectId).toBe("from-url");
    await vi.waitFor(() => expect(harness.count("/api/graph")).toBe(1));
  });

  it("starts on every project and keeps the choice when the URL says `all`", () => {
    const store = useGraphStore();
    store.graphProjectParam = "all";
    store.resolveDefaultGraphProject("project-recent");

    expect(store.graphProjectId).toBe("");
    expect(store.graphProjectParam).toBe("all");
  });

  it("returns to the project chosen last when the page opens again without a project in the URL", () => {
    const store = useGraphStore();
    store.chooseGraphProject("project-picked");

    store.graphProjectParam = "";
    expect(store.graphProjectResolved).toBe(false);
    store.resolveDefaultGraphProject("project-recent");

    expect(store.graphProjectId).toBe("project-picked");
  });

  it("returns to every project when that was chosen last", () => {
    const store = useGraphStore();
    store.chooseGraphProject("project-picked");
    store.chooseGraphProject("");

    store.graphProjectParam = "";
    expect(store.graphProjectParam).toBe("");
    store.resolveDefaultGraphProject("project-recent");

    expect(store.graphProjectId).toBe("");
    expect(store.graphProjectParam).toBe("all");
  });

  it("does not count the default as a choice", () => {
    const store = useGraphStore();
    store.resolveDefaultGraphProject("project-old");
    store.graphProjectParam = "";
    store.resolveDefaultGraphProject("project-new");

    expect(store.graphProjectId).toBe("project-new");
  });

  it("starts unscoped when there is no project to default to", () => {
    const store = useGraphStore();
    store.resolveDefaultGraphProject(undefined);

    expect(store.graphProjectResolved).toBe(true);
    expect(store.graphProjectId).toBe("");
  });
});
