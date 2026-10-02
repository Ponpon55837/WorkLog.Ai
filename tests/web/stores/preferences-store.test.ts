import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createStoreHarness } from "../helpers/store-harness.js";
import { catalogEntries, locale, t } from "../../../apps/web/src/i18n/index.js";
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
  locale.value = "zh-TW";
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

  it("keeps the theme choice and resolves the system theme from the OS setting", async () => {
    const store = usePreferencesStore();
    expect(store.theme).toBe("system");
    store.systemPrefersDark = false;
    expect(store.resolvedTheme).toBe("light");
    store.theme = "dark";
    await nextTick();
    expect(store.resolvedTheme).toBe("dark");
    expect(storage.get("work-intelligence:theme")).toBe("dark");
  });

  it("ignores an unknown stored theme", () => {
    storage.set("work-intelligence:theme", "sepia");
    expect(usePreferencesStore().theme).toBe("system");
  });

  it("restores the saved language and switches every translation with it", async () => {
    storage.set("work-intelligence:locale", "en-US");
    const store = usePreferencesStore();
    expect(store.locale).toBe("en-US");
    expect(t("common.refresh")).toBe(catalogEntries("en-US")["common.refresh"]);
    store.locale = "zh-TW";
    await nextTick();
    expect(storage.get("work-intelligence:locale")).toBe("zh-TW");
    expect(t("common.refresh")).toBe(catalogEntries("zh-TW")["common.refresh"]);
  });

  it("follows the browser language when nothing is saved", () => {
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    expect(usePreferencesStore().locale).toBe("en-US");
  });

  it("upgrades the locale saved as en before the JSON catalogs to en-US", () => {
    storage.set("work-intelligence:locale", "en");
    expect(usePreferencesStore().locale).toBe("en-US");
  });
});
