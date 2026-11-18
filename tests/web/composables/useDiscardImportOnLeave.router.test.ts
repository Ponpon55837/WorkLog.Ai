import { createRenderer, h } from "vue";
import type { RendererOptions } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiscardImportOnLeave } from "../../../apps/web/src/composables/useDiscardImportOnLeave.js";
import { useProjectDataTransferStore } from "../../../apps/web/src/stores/project-data-transfer.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";

// The real router: the leave guard is registered through RouterView and fired by a real navigation.
type HostNode = { type: string; children: HostNode[]; parent?: HostNode };

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert: (node, parent, anchor) => {
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, node);
    else parent.children.push(node);
  },
  remove: (node) => {
    const siblings = node.parent?.children ?? [];
    const index = siblings.indexOf(node);
    if (index >= 0) siblings.splice(index, 1);
  },
  createElement: (type) => ({ type, children: [] }),
  createText: (text) => ({ type: text, children: [] }),
  createComment: (text) => ({ type: text, children: [] }),
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (node) => node.parent ?? null,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
} satisfies RendererOptions<HostNode, HostNode>);

const stagedBody = {
  stagingId: "stage-1",
  expiresAt: "2031-01-01T00:30:00.000Z",
  header: { scope: { type: "all" }, projects: [] },
  preview: {},
};

let harness: ReturnType<typeof createStoreHarness>;

beforeEach(() => {
  harness = createStoreHarness((request) =>
    request.url.pathname === "/api/import/staged" && request.method === "POST" ? jsonResponse(stagedBody, 201) : {},
  );
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
});

afterEach(async () => {
  await harness.cleanup();
});

describe("useDiscardImportOnLeave with a real router", () => {
  it("discards the staged file when a navigation leaves the route, and not on a navigation within it", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: "/projects",
          component: {
            setup() {
              useDiscardImportOnLeave();
              return () => h("projects");
            },
          },
        },
        { path: "/sessions", component: { render: () => h("sessions") } },
      ],
    });
    await router.push("/projects");
    const app = renderer.createApp({ render: () => h(RouterView) });
    app.use(router);
    app.mount({ type: "container", children: [] });
    await router.isReady();

    await useProjectDataTransferStore().loadImportFile(new File(["{}"], "work.json", { type: "application/json" }));
    await router.push({ path: "/projects", query: { tab: "backup" } });
    expect(harness.calls.filter((call) => call.method === "DELETE")).toEqual([]);

    await router.push("/sessions");
    await vi.waitFor(() =>
      expect(harness.calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname)).toEqual([
        "/api/import/staged/stage-1",
      ]),
    );
    app.unmount();
  });
});
