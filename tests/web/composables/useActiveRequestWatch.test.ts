import { createRenderer, h, nextTick, ref } from "vue";
import type { Ref, RendererOptions } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveRequestWatch } from "../../../apps/web/src/composables/useActiveRequestWatch.js";

type Request = { id: string; status: string };
type HostNode = { type: string; children: HostNode[]; parent?: HostNode; text?: string };

function hostNode(type: string, text?: string): HostNode {
  return { type, children: [], ...(text ? { text } : {}) };
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert(node, parent, anchor) {
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) {
      parent.children.push(node);
    } else {
      parent.children.splice(index, 0, node);
    }
  },
  remove(node) {
    if (!node.parent) {
      return;
    }
    const index = node.parent.children.indexOf(node);
    if (index >= 0) {
      node.parent.children.splice(index, 1);
    }
    node.parent = undefined;
  },
  createElement: (type) => hostNode(type),
  createText: (text) => hostNode("#text", text),
  createComment: (text) => hostNode("#comment", text),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
    node.children = [];
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling(node) {
    if (!node.parent) {
      return null;
    }
    const index = node.parent.children.indexOf(node);
    return node.parent.children[index + 1] ?? null;
  },
} satisfies RendererOptions<HostNode, HostNode>);

let visibilityState: DocumentVisibilityState;
let visibilityListeners: Set<EventListener>;
let removeListener: ReturnType<typeof vi.fn>;
const mountedApps: Array<{ unmount: () => void }> = [];

function changeVisibility(state: DocumentVisibilityState): void {
  visibilityState = state;
  for (const listener of visibilityListeners) {
    listener(new Event("visibilitychange"));
  }
}

function mountWatcher(intervalMs = 1_000): {
  app: ReturnType<typeof renderer.createApp>;
  requests: Ref<Request[]>;
  scope: Ref<string>;
  check: ReturnType<typeof vi.fn<() => Promise<void>>>;
  onSettled: ReturnType<typeof vi.fn<(request: Request, status: string | undefined) => void>>;
} {
  const requests = ref<Request[]>([]);
  const scope = ref("report:week");
  const check = vi.fn(async (): Promise<void> => undefined);
  const onSettled = vi.fn((_request: Request, _status: string | undefined): void => undefined);
  const app = renderer.createApp({
    setup() {
      useActiveRequestWatch({
        requests: () => requests.value,
        check,
        onSettled,
        scope: () => scope.value,
        intervalMs,
      });
      return () => h("root");
    },
  });
  app.mount(hostNode("container"));
  mountedApps.push(app);
  return { app, requests, scope, check, onSettled };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = "visible";
  visibilityListeners = new Set();
  removeListener = vi.fn((_type: string, listener: EventListener): void => {
    visibilityListeners.delete(listener);
  });
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: vi.fn((_type: string, listener: EventListener): void => {
      visibilityListeners.add(listener);
    }),
    removeEventListener: removeListener,
  });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) {
    app.unmount();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useActiveRequestWatch", () => {
  it("checks active requests at the configured interval", async () => {
    const { requests, check } = mountWatcher(500);
    requests.value = [{ id: "request-1", status: "pending" }];
    await nextTick();

    await vi.advanceTimersByTimeAsync(499);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledOnce();
  });

  it("pauses while hidden and checks immediately when the tab becomes visible", async () => {
    const { requests, check } = mountWatcher();
    requests.value = [{ id: "request-1", status: "processing" }];
    await nextTick();
    changeVisibility("hidden");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(check).not.toHaveBeenCalled();
    changeVisibility("visible");
    await nextTick();
    expect(check).toHaveBeenCalledOnce();
  });

  it("reports a completed request once with its final status", async () => {
    const { requests, onSettled } = mountWatcher();
    const pending = { id: "request-1", status: "pending" };
    requests.value = [pending];
    await nextTick();
    requests.value = [{ ...pending, status: "completed" }];
    await nextTick();
    requests.value = [];
    await nextTick();

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(pending, "completed");
  });

  it("reports when an active request disappears from the list", async () => {
    const { requests, onSettled } = mountWatcher();
    const pending = { id: "request-1", status: "processing" };
    requests.value = [pending];
    await nextTick();
    requests.value = [];
    await nextTick();

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(pending, undefined);
  });

  it("clears request tracking when the scope changes", async () => {
    const { requests, scope, onSettled } = mountWatcher();
    requests.value = [{ id: "request-1", status: "pending" }];
    await nextTick();
    scope.value = "report:quarter";
    await nextTick();
    requests.value = [];
    await nextTick();

    expect(onSettled).not.toHaveBeenCalled();
  });

  it("clears its timer and visibility listener when unmounted", async () => {
    const { app, requests } = mountWatcher();
    requests.value = [{ id: "request-1", status: "pending" }];
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);

    app.unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
