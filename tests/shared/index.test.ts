import { describe, expect, it } from "vitest";
import {
  API_PREFIX,
  APP_NAME,
  DEFAULT_WEB_PORT,
  isSupportedNodeVersion,
  localDayStartIso,
  localTimeZone,
  nowIso,
  serverClock,
  toLocalCalendarDate,
  truncateAtCodeUnitLimit,
  truncateText,
} from "../../packages/shared/src/index.js";
import { APP_VERSION } from "../../packages/shared/src/app-version.js";

describe("shared runtime helpers", () => {
  it("reports the server clock with its time zone and UTC offset", () => {
    const at = (iso: string, offsetMinutes: number) => {
      const date = new Date(iso);
      // getTimezoneOffset is minutes behind UTC, so UTC+8 is -480.
      date.getTimezoneOffset = () => offsetMinutes;
      return date;
    };
    expect(serverClock(at("2026-09-27T01:52:48.000Z", -480))).toEqual({
      serverTime: "2026-09-27T01:52:48.000Z",
      timeZone: localTimeZone(),
      utcOffset: "+08:00",
    });
    expect(serverClock(at("2026-09-27T01:52:48.000Z", 330)).utcOffset).toBe("-05:30");
    expect(serverClock(at("2026-09-27T01:52:48.000Z", 0)).utcOffset).toBe("+00:00");
    expect(serverClock().serverTime).toMatch(/Z$/);
  });

  it("exports application metadata", () => {
    expect(APP_NAME).toBe("Work Intelligence");
    expect(API_PREFIX).toBe("/api");
    expect(DEFAULT_WEB_PORT).toBe(5966);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("formats timestamps and local calendar dates", () => {
    expect(Number.isNaN(Date.parse(nowIso()))).toBe(false);
    expect(localTimeZone().length).toBeGreaterThan(0);
    expect(toLocalCalendarDate("2026-09-26T12:00:00.000Z")).toBe("2026-09-26");
    expect(toLocalCalendarDate(new Date("2026-09-26T12:00:00.000Z"))).toBe("2026-09-26");
    expect(localDayStartIso("2026-09-26")).toBe(new Date(2026, 8, 26).toISOString());
    expect(localDayStartIso("not-a-date")).toBeUndefined();
  });

  it("truncates long text and preserves shorter text", () => {
    expect(truncateText("short", 8)).toBe("short");
    expect(truncateText("abcdefgh", 5)).toBe("abcd…");
    expect(truncateText("x".repeat(241))).toHaveLength(240);
  });

  it("truncates at a code-unit limit without splitting a surrogate pair", () => {
    expect(truncateAtCodeUnitLimit("short", 8)).toEqual({ text: "short", truncated: false });
    expect(truncateAtCodeUnitLimit("abcdefgh", 5)).toEqual({ text: "abcd…", truncated: true });
    // The cut after "abc" would fall between the two code units of the emoji, so the whole emoji is dropped.
    expect(truncateAtCodeUnitLimit("abc🐝defg", 5)).toEqual({ text: "abc…", truncated: true });
    expect(truncateAtCodeUnitLimit("abcdefgh", 0)).toEqual({ text: "", truncated: true });
  });
});

describe("isSupportedNodeVersion", () => {
  it("accepts 22.16+ on the 22 line and 24+, rejecting releases whose SQLite lacks FTS5", () => {
    expect(["22.16.0", "v22.22.0", "24.0.0", "26.13.0"].map(isSupportedNodeVersion)).toEqual([true, true, true, true]);
    expect(["22.15.0", "22.13.1", "23.11.0", "21.9.0", "not-a-version"].map(isSupportedNodeVersion)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
