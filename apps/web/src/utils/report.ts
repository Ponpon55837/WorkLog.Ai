import type { ReportPeriod, WorkReport } from "@work-intelligence/core";
import { weekdayLabel } from "./format";
import { t, type MessageKey } from "../i18n";

export interface ReportBucket {
  key: string;
  label: string;
  sessions: number;
  events: number;
}

export interface ReportShare {
  key: string;
  label: string;
  sessions: number;
  percent: number;
}

/** How a report's trend points are grouped for the overview. */
export type ReportBucketMode = "day" | "week" | "month" | "quarter";

function bucketUnit(
  unit: MessageKey,
  title: MessageKey,
  eyebrow: string,
): { unit: string; title: string; eyebrow: string } {
  return {
    get unit() {
      return t(unit);
    },
    get title() {
      return t(title);
    },
    eyebrow,
  };
}

export const reportBucketUnits: Record<ReportBucketMode, { unit: string; title: string; eyebrow: string }> = {
  day: bucketUnit("reports.unit.days", "reports.byDay", "By day"),
  week: bucketUnit("reports.unit.weeks", "reports.byWeek", "By week"),
  month: bucketUnit("reports.unit.months", "reports.byMonth", "By month"),
  quarter: bucketUnit("reports.unit.quarters", "reports.byQuarter", "By quarter"),
};

/**
 * The sub-period one level below the report period, or null for a daily report (it lists its Sessions
 * instead). A custom range uses days up to two weeks, weeks up to the 92 days the server trends daily,
 * and months beyond that.
 */
export function reportBucketMode(
  report: Pick<WorkReport, "period" | "trends" | "trendGranularity">,
): ReportBucketMode | null {
  const modes: Record<ReportPeriod, ReportBucketMode | null> = {
    day: null,
    week: "day",
    month: "week",
    quarter: "month",
    year: "quarter",
  };
  if (report.period !== "custom") {
    return modes[report.period];
  }
  if (report.trendGranularity === "month") {
    return "month";
  }
  return report.trends.length <= 14 ? "day" : "week";
}

// Report dates are server-local calendar dates; UTC arithmetic keeps them from shifting in the browser.
function calendarDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function monthDay(value: string): string {
  return `${value.slice(5, 7)}/${value.slice(8, 10)}`;
}

function mondayOf(value: string): string {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function bucketKey(mode: ReportBucketMode, date: string): string {
  if (mode === "week") {
    return mondayOf(date);
  }
  if (mode === "quarter") {
    return `Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  }
  return date;
}

/**
 * Groups the deterministic trend points into sub-periods: days, weeks (Monday start, clipped to the
 * report range), months, or quarters, as chosen by {@link reportBucketMode}.
 */
export function buildReportBuckets(report: Pick<WorkReport, "period" | "trends" | "trendGranularity">): ReportBucket[] {
  const mode = reportBucketMode(report);
  if (!mode) {
    return [];
  }
  const buckets = new Map<string, ReportBucket & { first: string; last: string }>();
  for (const point of report.trends) {
    const key = bucketKey(mode, point.date);
    const bucket = buckets.get(key) ?? { key, label: "", sessions: 0, events: 0, first: point.date, last: point.date };
    bucket.sessions += point.sessions;
    bucket.events += point.events;
    bucket.last = point.date;
    buckets.set(key, bucket);
  }
  // Months carry their year when the range crosses a year boundary.
  const spansYears = new Set(report.trends.map((point) => point.date.slice(0, 4))).size > 1;
  return [...buckets.values()].map(({ first, last, ...bucket }) => {
    const labels: Record<ReportBucketMode, string> = {
      day: `${weekdayLabel(calendarDate(first), true)} ${monthDay(first)}`,
      week: first === last ? monthDay(first) : `${monthDay(first)}–${monthDay(last)}`,
      month: spansYears
        ? `${first.slice(0, 4)}/${first.slice(5, 7)}`
        : t("reports.month", { value: Number(first.slice(5, 7)) }),
      quarter: t("reports.months", {
        key: bucket.key,
        value: Number(first.slice(5, 7)),
        value2: Number(last.slice(5, 7)),
      }),
    };
    return { ...bucket, label: labels[mode] };
  });
}

/** Each project's share of the report's completed Sessions, largest first. */
export function buildReportProjectShares(report: Pick<WorkReport, "projects" | "totals">): ReportShare[] {
  const total = report.totals.sessions;
  return report.projects.map((project) => ({
    key: project.projectId,
    label: project.projectName,
    sessions: project.sessionCount,
    percent: total ? Math.round((project.sessionCount / total) * 100) : 0,
  }));
}
