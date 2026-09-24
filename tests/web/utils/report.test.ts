import { describe, expect, it } from "vitest";
import type { WorkReport } from "../../../packages/core/src/index.js";
import { buildReportBuckets, buildReportProjectShares, reportBucketMode } from "../../../apps/web/src/utils/report.js";

type ReportBucketInput = Pick<WorkReport, "period" | "trends" | "trendGranularity">;

function report(
  period: WorkReport["period"],
  trends: WorkReport["trends"],
  trendGranularity: WorkReport["trendGranularity"] = "day",
): ReportBucketInput {
  return { period, trends, trendGranularity };
}

function trend(date: string, sessions: number, events = 0): WorkReport["trends"][number] {
  return { date, sessions, events };
}

describe("report buckets", () => {
  it("lists no buckets for a daily report and groups weekly reports by calendar day", () => {
    expect(buildReportBuckets(report("day", [trend("2026-01-01", 2, 3)]))).toEqual([]);
    expect(reportBucketMode(report("week", []))).toBe("day");
    expect(buildReportBuckets(report("week", [trend("2026-01-01", 2, 3), trend("2026-01-02", 1, 4)]))).toEqual([
      { key: "2026-01-01", label: "週四 01/01", sessions: 2, events: 3 },
      { key: "2026-01-02", label: "週五 01/02", sessions: 1, events: 4 },
    ]);
  });

  it("groups monthly trends into Monday-start weeks clipped to the returned dates", () => {
    const buckets = buildReportBuckets(
      report("month", [trend("2026-05-25", 1, 2), trend("2026-05-31", 2, 3), trend("2026-06-01", 4, 5)]),
    );

    expect(buckets).toEqual([
      { key: "2026-05-25", label: "05/25–05/31", sessions: 3, events: 5 },
      { key: "2026-06-01", label: "06/01", sessions: 4, events: 5 },
    ]);
  });

  it("keeps the year in month labels when a quarter crosses New Year", () => {
    const input = report("quarter", [trend("2025-12-01", 1), trend("2026-01-01", 2)], "month");

    expect(reportBucketMode(input)).toBe("month");
    expect(buildReportBuckets(input).map(({ label }) => label)).toEqual(["2025/12", "2026/01"]);
  });

  it("groups yearly reports into quarters and sums each quarter", () => {
    const buckets = buildReportBuckets(
      report("year", [trend("2026-01-01", 1, 2), trend("2026-03-01", 2, 3), trend("2026-04-01", 4, 5)], "month"),
    );

    expect(buckets).toEqual([
      { key: "Q1", label: "Q1 · 1–3 月", sessions: 3, events: 5 },
      { key: "Q2", label: "Q2 · 4–4 月", sessions: 4, events: 5 },
    ]);
  });

  it("chooses day, week, or month buckets for custom ranges from the returned trend shape", () => {
    const shortRange = report("custom", [trend("2026-02-01", 1)], "day");
    const longRange = report(
      "custom",
      Array.from({ length: 15 }, (_, index) => trend(`2026-02-${String(index + 1).padStart(2, "0")}`, 1)),
      "day",
    );
    const monthlyRange = report("custom", [trend("2025-12-01", 1), trend("2026-01-01", 2)], "month");

    expect(reportBucketMode(shortRange)).toBe("day");
    expect(buildReportBuckets(shortRange)).toHaveLength(1);
    expect(reportBucketMode(longRange)).toBe("week");
    expect(buildReportBuckets(longRange)).toHaveLength(3);
    expect(reportBucketMode(monthlyRange)).toBe("month");
    expect(buildReportBuckets(monthlyRange).map(({ label }) => label)).toEqual(["2025/12", "2026/01"]);
  });
});

describe("report project shares", () => {
  it("preserves project order, rounds percentages, and avoids division by zero", () => {
    const totals = (sessions: number): WorkReport["totals"] => ({
      sessions,
      events: 0,
      changedFiles: 0,
      verification: { passed: 0, failed: 0, not_run: 0, not_supplied: 0 },
    });
    const project = (projectId: string, projectName: string, sessionCount: number): WorkReport["projects"][number] => ({
      projectId,
      projectName,
      sessionCount,
      eventCount: 0,
      sourceSessionIds: [],
    });

    expect(
      buildReportProjectShares({
        totals: totals(3),
        projects: [project("first", "第一個", 1), project("second", "第二個", 2)],
      }),
    ).toEqual([
      { key: "first", label: "第一個", sessions: 1, percent: 33 },
      { key: "second", label: "第二個", sessions: 2, percent: 67 },
    ]);
    expect(
      buildReportProjectShares({
        totals: totals(0),
        projects: [project("empty", "沒有工作", 0)],
      }),
    ).toEqual([{ key: "empty", label: "沒有工作", sessions: 0, percent: 0 }]);
  });
});
