import { describe, expect, it } from "vitest";
import { ApiError } from "../../../apps/web/src/api/client.js";
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatDayGroup,
  formatDuration,
  formatReadableSummary,
  formatRelative,
  formatReportTrendLabel,
  formatTimeOfDay,
  graphNodeLabel,
  graphNodeLabelTail,
  startOfMonth,
  toDateInputValue,
  wasUpdatedAfterFinalize,
} from "../../../apps/web/src/utils/format.js";
import { t } from "../../../apps/web/src/i18n/index.js";

describe("formatBytes", () => {
  it("keeps small sizes in bytes and scales larger sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute, minute, hour, and day spans", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const end = (minutes: number): string => new Date(start + minutes * 60_000).toISOString();

    expect(formatDuration(end(0), end(0))).toBe(t("format.under1Minute"));
    expect(formatDuration(end(0), end(1))).toBe(t("format.durationMinutes", { rest: 1 }));
    expect(formatDuration(end(0), end(45))).toBe(t("format.durationMinutes", { rest: 45 }));
    expect(formatDuration(end(0), end(63))).toBe(
      `${t("format.durationHours", { hours: 1 })} ${t("format.durationMinutes", { rest: 3 })}`,
    );
    expect(formatDuration(end(0), end(1_620))).toBe(
      `${t("format.durationDays", { days: 1 })} ${t("format.durationHours", { hours: 3 })}`,
    );
  });

  it("returns an empty label for invalid or reversed intervals", () => {
    expect(formatDuration("invalid", "2026-01-01T00:00:00.000Z")).toBe("");
    expect(formatDuration("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("");
  });
});

describe("errorMessage", () => {
  it("localizes API errors by machine-readable code", () => {
    expect(errorMessage(new ApiError("PROJECT_NAME_MISMATCH", 409, "English message"), "fallback")).toBe(
      t("format.theNameDoesNotMatch"),
    );
    expect(errorMessage(new ApiError("database_busy", 503, "English message"), "fallback")).toBe(
      t("format.theDatabaseIsBusyPlease"),
    );
  });

  it("uses the caller fallback for unknown API codes instead of exposing server text", () => {
    expect(errorMessage(new ApiError("new_server_code", 500, "private internal message"), "fallback")).toBe("fallback");
    expect(errorMessage(new ApiError("internal_error", 500, "Internal server error."), "刪除作業未完成。")).toBe(
      "刪除作業未完成。",
    );
  });

  it("uses an Error message for local errors and the fallback for non-errors", () => {
    expect(errorMessage(new Error("Local issue"), "fallback")).toBe("Local issue");
    expect(errorMessage("unexpected", "fallback")).toBe("fallback");
    expect(errorMessage({ code: 10, status: 500 }, "fallback")).toBe("fallback");
  });
});

describe("date and summary formatting", () => {
  it("formats dates and summary markers for readable display", () => {
    expect(formatDate("2026-09-27T12:00:00.000Z")).not.toBe("");
    expect(formatReadableSummary("  ")).toBe("");
    expect(formatReadableSummary("# Title | blockedWork\n\n\nStatus signals: ready")).toBe(
      "Title\nblocked\nWork\n\nStatus signals:\n ready",
    );
    expect(toDateInputValue(new Date(2026, 8, 7))).toBe("2026-09-07");
    const month = startOfMonth(new Date(2026, 8, 27, 16));
    expect([month.getFullYear(), month.getMonth(), month.getDate()]).toEqual([2026, 8, 1]);
  });

  it("formats trend labels and truncates graph labels using CJK display width", () => {
    expect(formatReportTrendLabel("2026-09-27", "day")).toBe("09/27");
    expect(formatReportTrendLabel("2026-09-01", "month")).toBe("2026/09");
    expect(graphNodeLabel("abc", 3)).toBe("abc");
    expect(graphNodeLabel("A中文B", 4)).toBe("A中…");
    expect(graphNodeLabelTail("/one/two", 20)).toBe("/one/two");
    expect(graphNodeLabelTail("/very/long/path/name", 8)).toMatch(/^…/);
  });

  it("uses relative time and day grouping across current, previous, and older dates", () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    expect(formatRelative("2026-09-27T11:59:45.000Z", now)).toBe(t("format.justNow"));
    expect(formatRelative("2026-09-27T11:40:00.000Z", now)).toBe(t("format.minutesAgo", { diffMinutes: 20 }));
    expect(formatRelative("2026-09-27T06:00:00.000Z", now)).toBe(t("format.hoursAgo", { value: 6 }));
    expect(formatRelative("2026-09-26T06:00:00.000Z", now)).toContain(t("common.yesterday"));
    expect(formatRelative("2025-09-27T06:00:00.000Z", now)).not.toBe("");
    expect(formatDayGroup("2026-09-27T06:00:00.000Z", now)).toBe(t("common.today"));
    expect(formatDayGroup("2026-09-26T06:00:00.000Z", now)).toBe(t("common.yesterday"));
    expect(formatDayGroup("2025-09-27T06:00:00.000Z", now)).not.toBe("");
  });

  it("treats only changes beyond one minute as an update after finalization", () => {
    const createdAt = "2026-09-27T00:00:00.000Z";
    expect(wasUpdatedAfterFinalize({ createdAt, updatedAt: "2026-09-27T00:01:00.000Z" })).toBe(false);
    expect(wasUpdatedAfterFinalize({ createdAt, updatedAt: "2026-09-27T00:01:01.000Z" })).toBe(true);
  });
});

describe("formatTimeOfDay", () => {
  it("shows only the local time of day", () => {
    const value = new Date(2031, 2, 5, 18, 7).toISOString();
    expect(formatTimeOfDay(value)).toMatch(/6:07/);
    expect(formatTimeOfDay(value)).not.toMatch(/2031/);
  });
});
