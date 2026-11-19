import { describe, expect, it } from "vitest";
import {
  checkText,
  lastRunText,
  maintenanceMessages,
  modeLabels,
} from "../../packages/desktop-core/src/shell/maintenance-i18n.js";

describe("maintenance texts", () => {
  const zh = maintenanceMessages("zh-TW");
  const en = maintenanceMessages("en");

  it("says there was no run, and names the time of each last status", () => {
    expect(lastRunText(en, "en", null)).toBe(en.lastNone);
    const at = "2026-11-19T06:00:00.000Z";
    for (const status of ["completed", "failed", "running"] as const) {
      expect(lastRunText(zh, "zh-TW", { status, at })).not.toContain("{time}");
    }
    expect(lastRunText(en, "en", { status: "completed", at })).toContain("2026");
  });

  it("keeps an unreadable time as it is", () => {
    expect(lastRunText(en, "en", { status: "failed", at: "not a time" })).toContain("not a time");
  });

  it("reports the read-only check either way", () => {
    const at = "2026-11-19T06:00:00.000Z";
    expect(checkText(en, "en", { ok: true, at })).not.toEqual(checkText(en, "en", { ok: false, at }));
  });

  it("labels each mode idle and working", () => {
    expect(modeLabels(en, "maintain", false)).toBe(en.maintain);
    expect(modeLabels(en, "maintain", true)).toBe(en.maintaining);
    expect(modeLabels(en, "check", false)).toBe(en.check);
    expect(modeLabels(en, "check", true)).toBe(en.checking);
  });
});
