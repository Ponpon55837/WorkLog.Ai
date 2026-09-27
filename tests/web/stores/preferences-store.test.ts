import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createStoreHarness } from "../helpers/store-harness.js";
import { usePreferencesStore } from "../../../apps/web/src/stores/preferences.js";

let harness: ReturnType<typeof createStoreHarness>;
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  harness = createStoreHarness();
});

afterEach(async () => {
  await harness.cleanup();
  vi.unstubAllGlobals();
});

describe("preferences store", () => {
  it("keeps the editor choice in this browser and ignores unknown stored values", async () => {
    storage.set("work-intelligence:editor", "cursor");
    const store = usePreferencesStore();
    expect(store.editor).toBe("cursor");
    store.editor = "vscode";
    await nextTick();
    expect(storage.get("work-intelligence:editor")).toBe("vscode");
    store.$reset();
    expect(store.editor).toBe("none");
  });

  it("falls back to no editor when storage is blocked", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    const store = usePreferencesStore();
    expect(store.editor).toBe("none");
    expect(() => (store.editor = "vscode")).not.toThrow();
  });
});
