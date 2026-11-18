import { describe, expect, it } from "vitest";
import { buildTrayMenu, setupMessages, shellMessages } from "../../packages/desktop-core/src/shell/index.js";

const messages = shellMessages("en");
const base = { messages, owner: "NEEDS_REPAIR" as const, backendRunning: false };

describe("buildTrayMenu with a login start held back by the old service", () => {
  it("shows only the disabled status line (the two ways out are cards on the Status tab)", () => {
    const text = setupMessages("zh-TW");
    const items = buildTrayMenu({ ...base, legacyHeld: text });
    expect(items[0]).toEqual({
      id: "legacy-status",
      label: "偵測到舊的登入服務也使用這份資料庫，未自動啟動",
      enabled: false,
    });
    expect(
      items.filter((item) => item.id.startsWith("legacy-")).map((item) => [item.id, item.label, item.enabled]),
    ).toEqual([["legacy-status", "偵測到舊的登入服務也使用這份資料庫，未自動啟動", false]]);
    expect(items.map((item) => item.id).slice(-2)).toEqual(["separator", "quit"]);
  });

  it("adds nothing when nothing was held back", () => {
    expect(buildTrayMenu(base).some((item) => item.id.startsWith("legacy-"))).toBe(false);
  });

  it("keeps the same tray keys in both languages", () => {
    const keys = (locale: "zh-TW" | "en") =>
      Object.keys(setupMessages(locale)).filter((key) => key.startsWith("trayLegacy") || key === "legacyStartsAtLogin");
    expect(keys("en").sort()).toEqual(keys("zh-TW").sort());
    expect(keys("en")).toHaveLength(4);
  });
});
