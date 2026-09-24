import type { ReportPeriod, WorkReport } from "@work-intelligence/core";

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

/** The sub-period one level below each report period; a daily report has none and lists its Sessions instead. */
export const reportBucketUnits: Record<
  Exclude<ReportPeriod, "day">,
  { unit: string; title: string; eyebrow: string }
> = {
  week: { unit: "天", title: "每日分布", eyebrow: "By day" },
  month: { unit: "週", title: "每週分布", eyebrow: "By week" },
  quarter: { unit: "個月", title: "每月分布", eyebrow: "By month" },
  year: { unit: "季", title: "每季分布", eyebrow: "By quarter" },
};

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

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

function bucketKey(period: Exclude<ReportPeriod, "day">, date: string): string {
  if (period === "month") {
    return mondayOf(date);
  }
  if (period === "year") {
    return `Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  }
  return date;
}

/**
 * Groups the deterministic trend points into the sub-periods of the report: days of a week, weeks
 * (Monday start, clipped to the month) of a month, months of a quarter, and quarters of a year.
 */
export function buildReportBuckets(report: Pick<WorkReport, "period" | "trends">): ReportBucket[] {
  const period = report.period;
  if (period === "day") {
    return [];
  }
  const buckets = new Map<string, ReportBucket & { first: string; last: string }>();
  for (const point of report.trends) {
    const key = bucketKey(period, point.date);
    const bucket = buckets.get(key) ?? { key, label: "", sessions: 0, events: 0, first: point.date, last: point.date };
    bucket.sessions += point.sessions;
    bucket.events += point.events;
    bucket.last = point.date;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(({ first, last, ...bucket }) => {
    const labels: Record<Exclude<ReportPeriod, "day">, string> = {
      week: `週${weekdayLabels[calendarDate(first).getUTCDay()]} ${monthDay(first)}`,
      month: first === last ? monthDay(first) : `${monthDay(first)}–${monthDay(last)}`,
      quarter: `${Number(first.slice(5, 7))} 月`,
      year: `${bucket.key} · ${Number(first.slice(5, 7))}–${Number(last.slice(5, 7))} 月`,
    };
    return { ...bucket, label: labels[period] };
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
