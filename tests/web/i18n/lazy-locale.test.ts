import { describe, expect, it } from "vitest";
import { catalogEntries, localeReady, locale, t } from "../../../apps/web/src/i18n/index.js";

// Module state is per test file, so nothing here has loaded the English catalog yet.
describe("on-demand catalogs", () => {
  it("keeps the current language until the new catalog has loaded, then switches", async () => {
    expect(catalogEntries("en-US")).toEqual({});
    locale.value = "en-US";
    expect(locale.value).toBe("zh-TW");
    expect(t("common.refresh")).toBe("重新整理");
    await localeReady();
    expect(locale.value).toBe("en-US");
    expect(t("common.refresh")).toBe("Refresh");
  });

  it("lets the latest write win when switches overlap", async () => {
    locale.value = "zh-TW";
    locale.value = "en-US";
    locale.value = "zh-TW";
    await localeReady();
    expect(locale.value).toBe("zh-TW");
  });
});
