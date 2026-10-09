import { afterEach, describe, expect, it, vi } from "vitest";
import { useRelatedWorkStore } from "../../../apps/web/src/stores/related-work.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";

let harness: ReturnType<typeof createStoreHarness>;
afterEach(async () => harness?.cleanup());
describe("related work scoped query", () => {
  it("does not expose a delayed previous source after switching Sessions", async () => {
    let release: (value: unknown) => void = () => undefined;
    harness = createStoreHarness(({ url }) =>
      url.pathname.includes("first")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : {
            outcome: "related_work",
            sessionId: "second",
            state: "ready",
            items: [],
            coverage: { partial: true, examined: 1000, postingLimit: 1000 },
          },
    );
    const store = useRelatedWorkStore();
    store.setSource("first");
    await vi.waitFor(() => expect(harness.count("/api/sessions/first/related")).toBe(1));
    store.setSource("second");
    await vi.waitFor(() => expect(store.data?.sessionId).toBe("second"));
    release({ outcome: "related_work", sessionId: "first", state: "ready", items: [{ id: "private-old" }] });
    await Promise.resolve();
    expect(store.data?.sessionId).toBe("second");
    expect(store.data?.coverage.partial).toBe(true);
    store.setSource("");
    expect(store.data).toBeUndefined();
  });
  it("keeps a failed read unknown and retries explicitly", async () => {
    harness = createStoreHarness(() => jsonResponse({ code: "internal_error" }, 500));
    const store = useRelatedWorkStore();
    store.setSource("fixture");
    await vi.waitFor(() => expect(store.error).toBe(true));
    expect(store.data).toBeUndefined();
    harness.setResponder(() => ({
      outcome: "related_work",
      sessionId: "fixture",
      state: "unavailable",
      reason: "no_files",
      items: [],
    }));
    await store.reload();
    expect(store.error).toBe(false);
    expect(store.data?.reason).toBe("no_files");
  });
});
