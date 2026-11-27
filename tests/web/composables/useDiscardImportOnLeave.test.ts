import { createRenderer, h } from "vue";
import type { RendererOptions } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiscardImportOnLeave } from "../../../apps/web/src/composables/useDiscardImportOnLeave.js";
import { useProjectDataTransferStore } from "../../../apps/web/src/stores/project-data-transfer.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";

const router = vi.hoisted(() => ({ leaveGuards: new Set<() => unknown>() }));
vi.mock("vue-router", () => ({
  onBeforeRouteLeave: (guard: () => unknown) => router.leaveGuards.add(guard),
}));

vi.mock("../../../apps/web/src/composables/useConfirm", () => ({ confirmAction: async () => true }));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: () => undefined }) }));

type HostNode = { type: string; children: HostNode[] };

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert: (node, parent) => void parent.children.push(node),
  remove: () => undefined,
  createElement: (type) => ({ type, children: [] }),
  createText: (text) => ({ type: text, children: [] }),
  createComment: (text) => ({ type: text, children: [] }),
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: () => null,
  nextSibling: () => null,
} satisfies RendererOptions<HostNode, HostNode>);

const stagedHeader = { scope: { type: "all" }, projects: [] };
const emptyCounts = { additions: {}, updates: {}, keptLocal: {}, skipped: {}, conflicts: {} };
const stagedBody = {
  stagingId: "stage-1",
  expiresAt: "2031-01-01T00:30:00.000Z",
  header: stagedHeader,
  preview: { ...emptyCounts, selectedProjects: [] },
};

let harness: ReturnType<typeof createStoreHarness>;
let pageListeners: Map<string, Set<EventListener>>;

function deletes(): Array<{ path: string; keepalive: boolean | undefined }> {
  return harness.calls
    .filter((call) => call.method === "DELETE")
    .map((call) => ({ path: call.url.pathname, keepalive: call.keepalive }));
}

async function mountWithStagedFile(): Promise<{ unmount: () => void }> {
  const app = renderer.createApp({
    setup() {
      useDiscardImportOnLeave();
      return () => h("root");
    },
  });
  app.mount({ type: "container", children: [] });
  const file = new File(["{}"], "work.json", { type: "application/json" });
  await useProjectDataTransferStore().loadImportFile(file);
  return app;
}

beforeEach(() => {
  harness = createStoreHarness((request) =>
    request.url.pathname === "/api/import/staged" && request.method === "POST" ? jsonResponse(stagedBody, 201) : {},
  );
  pageListeners = new Map();
  router.leaveGuards.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: EventListener) =>
      pageListeners.set(type, (pageListeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type: string, listener: EventListener) => pageListeners.get(type)?.delete(listener),
  });
});

afterEach(async () => {
  await harness.cleanup();
});

describe("useDiscardImportOnLeave", () => {
  it("keeps the staged file across a remount, like a language switch, and stops listening for pagehide", async () => {
    const app = await mountWithStagedFile();
    expect(pageListeners.get("pagehide")?.size).toBe(1);
    app.unmount();
    expect(pageListeners.get("pagehide")?.size).toBe(0);

    const remounted = renderer.createApp({
      setup() {
        useDiscardImportOnLeave();
        return () => h("root");
      },
    });
    remounted.mount({ type: "container", children: [] });
    const store = useProjectDataTransferStore();
    expect(store.importFileName).toBe("work.json");
    harness.setResponder((request) =>
      request.url.pathname === "/api/import/staged/stage-1" && request.method === "POST"
        ? { changed: false, ...emptyCounts }
        : {},
    );
    await store.applyProjectDataImport();
    remounted.unmount();
    expect(
      harness.calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/import/staged/stage-1"),
    ).toHaveLength(1);
    expect(deletes()).toEqual([]);
  });

  it("discards the staged file when the route is left, without blocking the navigation", async () => {
    const app = await mountWithStagedFile();
    expect(router.leaveGuards.size).toBe(1);
    const [guard] = [...router.leaveGuards];
    expect(guard?.()).toBeUndefined();
    await vi.waitFor(() => expect(deletes()).toEqual([{ path: "/api/import/staged/stage-1", keepalive: undefined }]));
    app.unmount();
    expect(deletes()).toHaveLength(1);
  });

  it("discards with a keepalive request on pagehide", async () => {
    const app = await mountWithStagedFile();
    for (const listener of pageListeners.get("pagehide") ?? []) listener(new Event("pagehide"));
    await vi.waitFor(() => expect(deletes()).toEqual([{ path: "/api/import/staged/stage-1", keepalive: true }]));
    app.unmount();
    expect(deletes()).toHaveLength(1);
  });

  it("sends nothing when no file is staged", () => {
    const app = renderer.createApp({
      setup() {
        useDiscardImportOnLeave();
        return () => h("root");
      },
    });
    app.mount({ type: "container", children: [] });
    for (const listener of pageListeners.get("pagehide") ?? []) listener(new Event("pagehide"));
    app.unmount();
    expect(deletes()).toEqual([]);
  });
});
