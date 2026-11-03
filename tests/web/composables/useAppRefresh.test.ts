import { useQueryCache } from "@pinia/colada";
import { getActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAppRefreshEvents } from "../../../apps/web/src/composables/useAppRefresh.js";
import { queryKeys } from "../../../apps/web/src/stores/query-keys.js";
import { updateApiConnection } from "../../../apps/web/src/composables/useApiConnection.js";
import { createStoreHarness } from "../helpers/store-harness.js";

class EventSourceMock {
  public static instance: EventSourceMock | undefined;
  public readonly listeners = new Map<string, EventListener[]>();

  public constructor() {
    EventSourceMock.instance = this;
  }

  public addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  public emit(name: string): void {
    this.listeners.get(name)?.forEach((listener) => listener(new Event(name)));
  }

  public close(): void {}
}

let cleanup: (() => Promise<void>) | undefined;
let stopRefreshEvents: (() => void) | undefined;

afterEach(async () => {
  stopRefreshEvents?.();
  stopRefreshEvents = undefined;
  updateApiConnection(true);
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function startRefreshEventsHarness() {
  const harness = createStoreHarness();
  cleanup = harness.cleanup;
  vi.stubGlobal("EventSource", EventSourceMock as unknown as typeof EventSource);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const pinia = getActivePinia();
  if (!pinia) throw new Error("The test did not activate its Pinia instance.");
  const invalidateQueries = vi.spyOn(useQueryCache(pinia), "invalidateQueries");
  stopRefreshEvents = startAppRefreshEvents();
  return invalidateQueries;
}

describe("App refresh SSE events", () => {
  it("invalidates only Agent read queries for the audit event and all active queries for changed", () => {
    const invalidateQueries = startRefreshEventsHarness();

    EventSourceMock.instance?.emit("agent-reads-changed");
    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { key: queryKeys.agentReads.all });

    EventSourceMock.instance?.emit("changed");
    expect(invalidateQueries).toHaveBeenNthCalledWith(2);
  });

  it("invalidates active queries after the API reconnects", async () => {
    const invalidateQueries = startRefreshEventsHarness();

    EventSourceMock.instance?.emit("error");
    await nextTick();
    EventSourceMock.instance?.emit("open");
    await nextTick();

    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith();
  });
});
