import { describe, expect, it } from "vitest";
import { APP_TABS } from "../../packages/desktop-core/src/index.js";
import { tabButtonId, tabIndexForKey, tabPanelId } from "../../apps/desktop/src/renderer/repair/tabs.js";

describe("the tab strip's keyboard model (WAI-ARIA tabs, automatic activation)", () => {
  it("moves right and wraps from the last tab to the first", () => {
    expect(tabIndexForKey("ArrowRight", 0, 5)).toBe(1);
    expect(tabIndexForKey("ArrowRight", 4, 5)).toBe(0);
  });

  it("moves left and wraps from the first tab to the last", () => {
    expect(tabIndexForKey("ArrowLeft", 3, 5)).toBe(2);
    expect(tabIndexForKey("ArrowLeft", 0, 5)).toBe(4);
  });

  it("Home and End go to the ends", () => {
    expect(tabIndexForKey("Home", 3, 5)).toBe(0);
    expect(tabIndexForKey("End", 1, 5)).toBe(4);
  });

  it("ignores every other key, and an empty strip", () => {
    for (const key of ["Enter", " ", "ArrowUp", "ArrowDown", "Tab", "a", "PageDown"]) {
      expect(tabIndexForKey(key, 1, 5)).toBeNull();
    }
    expect(tabIndexForKey("ArrowRight", 0, 0)).toBeNull();
  });

  it("a one-tab strip stays on its tab", () => {
    expect(tabIndexForKey("ArrowRight", 0, 1)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 1)).toBe(0);
  });

  it("gives each tab a button id and a panel id that the other side can point at", () => {
    const ids = APP_TABS.flatMap((tab) => [tabButtonId(tab), tabPanelId(tab)]);
    expect(new Set(ids).size).toBe(APP_TABS.length * 2);
    expect(tabButtonId("status")).toBe("tab-status");
    expect(tabPanelId("status")).toBe("panel-status");
  });
});
