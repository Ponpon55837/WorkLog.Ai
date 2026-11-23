import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreHarness } from "../helpers/store-harness.js";
import { loadCatalog, locale } from "../../../apps/web/src/i18n/index.js";
import { useDesktopLanguageStore } from "../../../apps/web/src/stores/desktop-language.js";
import { usePreferencesStore } from "../../../apps/web/src/stores/preferences.js";

let harness: ReturnType<typeof createStoreHarness>;
const storage = new Map<string, string>();

beforeAll(() => loadCatalog("en-US"));

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

afterEach(async () => {
  locale.value = "zh-TW";
  await harness.cleanup();
  vi.unstubAllGlobals();
});

function languageCalls(): number {
  return harness.count("/api/desktop/language", "POST");
}

describe("desktop language store", () => {
  it("adopts the App's language without writing it back", async () => {
    harness = createStoreHarness(({ url }) =>
      url.pathname === "/api/system/status"
        ? { version: "1.0.0", desktop: { managed: true, language: { preference: "en", locale: "en" } } }
        : {},
    );
    const preferences = usePreferencesStore();
    preferences.locale = "zh-TW";
    useDesktopLanguageStore();
    await vi.waitFor(() => expect(preferences.locale).toBe("en-US"));
    expect(languageCalls()).toBe(0);
  });

  it("tells the App about a user pick only when it manages the backend", async () => {
    harness = createStoreHarness(({ url }) =>
      url.pathname === "/api/system/status"
        ? { version: "1.0.0", desktop: { managed: true, language: { preference: "zh-TW", locale: "zh-TW" } } }
        : { ok: true },
    );
    const preferences = usePreferencesStore();
    const store = useDesktopLanguageStore();
    await vi.waitFor(() => expect(harness.count("/api/system/status")).toBe(1));
    await vi.waitFor(() => expect(preferences.locale).toBe("zh-TW"));
    await store.changeLocale("en-US");
    expect(preferences.locale).toBe("en-US");
    expect(harness.calls.find(({ url }) => url.pathname === "/api/desktop/language")).toMatchObject({
      method: "POST",
      body: { locale: "en" },
    });
  });

  it("keeps the local change and stays quiet when the write fails or there is no App", async () => {
    harness = createStoreHarness(({ url }) =>
      url.pathname === "/api/system/status" ? { version: "1.0.0" } : { ok: true },
    );
    const preferences = usePreferencesStore();
    const store = useDesktopLanguageStore();
    await vi.waitFor(() => expect(harness.count("/api/system/status")).toBe(1));
    await store.changeLocale("en-US");
    expect(preferences.locale).toBe("en-US");
    expect(languageCalls()).toBe(0);
  });
});
