import { toLocalCalendarDate } from "@work-intelligence/shared";
import type {
  ReportMetricComparison,
  ReportPeriod,
  ReportRange,
  ReportTrendGranularity,
  ReportTrendPoint,
  VerificationSummary,
  WorkEventType,
  WorkReportPeriod,
  WorkSessionRecord,
} from "@work-intelligence/core";

export interface ReportEventRow {
  id: string;
  session_id: string;
  project_id: string;
  type: WorkEventType;
  summary: string;
  occurred_at: string;
}

function parseUtcCalendarDate(value: string): Date {
  const [year = "0", month = "0", day = "0"] = value.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!Number.isFinite(date.getTime()) || formatUtcCalendarDate(date) !== value) {
    throw new Error("Report date must use a valid YYYY-MM-DD value.");
  }
  return date;
}

function formatUtcCalendarDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getReportRange(period: ReportPeriod, anchorValue: string): { from: string; to: string } {
  const anchor = parseUtcCalendarDate(anchorValue);
  if (period === "day") {
    const day = formatUtcCalendarDate(anchor);
    return { from: day, to: day };
  }

  if (period === "year") {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  if (period === "quarter") {
    const quarterMonth = Math.floor(anchor.getUTCMonth() / 3) * 3;
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), quarterMonth, 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), quarterMonth + 3, 0));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  if (period === "month") {
    const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
    return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
  }

  const mondayOffset = (anchor.getUTCDay() + 6) % 7;
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - mondayOffset);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);
  return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
}

export function getPreviousReportRange(period: ReportPeriod, range: ReportRange): ReportRange {
  const from = parseUtcCalendarDate(range.from);
  if (period === "day") {
    from.setUTCDate(from.getUTCDate() - 1);
    const previousDay = formatUtcCalendarDate(from);
    return { from: previousDay, to: previousDay };
  }

  if (period === "year") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear() - 1, 0, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear() - 1, 11, 31));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  if (period === "quarter") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 3, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 0));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  if (period === "month") {
    const previousFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    const previousTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 0));
    return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
  }

  const previousFrom = new Date(from);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - 7);
  const previousTo = new Date(previousFrom);
  previousTo.setUTCDate(previousTo.getUTCDate() + 6);
  return { from: formatUtcCalendarDate(previousFrom), to: formatUtcCalendarDate(previousTo) };
}

function listCalendarDates(range: ReportRange): string[] {
  const current = parseUtcCalendarDate(range.from);
  const end = parseUtcCalendarDate(range.to);
  const dates: string[] = [];
  while (current <= end) {
    dates.push(formatUtcCalendarDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function listCalendarMonths(range: ReportRange): string[] {
  const current = parseUtcCalendarDate(range.from);
  current.setUTCDate(1);
  const end = parseUtcCalendarDate(range.to);
  end.setUTCDate(1);
  const dates: string[] = [];
  while (current <= end) {
    dates.push(formatUtcCalendarDate(current));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return dates;
}

function reportRangeDays(range: ReportRange): number {
  return (parseUtcCalendarDate(range.to).getTime() - parseUtcCalendarDate(range.from).getTime()) / 86_400_000 + 1;
}

/** Days for up to a quarter's worth of dates (a custom range longer than 92 days trends by month). */
export function getReportTrendGranularity(period: WorkReportPeriod, range: ReportRange): ReportTrendGranularity {
  if (period === "custom") {
    return reportRangeDays(range) > 92 ? "month" : "day";
  }
  return period === "quarter" || period === "year" ? "month" : "day";
}

/** The same number of days immediately before a custom range. */
export function getPreviousCustomRange(range: ReportRange): ReportRange {
  const days = reportRangeDays(range);
  const to = parseUtcCalendarDate(range.from);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: formatUtcCalendarDate(from), to: formatUtcCalendarDate(to) };
}

export function buildReportTrends(
  granularity: ReportTrendGranularity,
  range: ReportRange,
  sessions: WorkSessionRecord[],
  eventsBySession: Map<string, ReportEventRow[]>,
): ReportTrendPoint[] {
  const dates = granularity === "month" ? listCalendarMonths(range) : listCalendarDates(range);
  return dates.map((date) => {
    const keyLength = granularity === "month" ? 7 : 10;
    const bucketKey = date.slice(0, keyLength);
    const bucketSessions = sessions.filter(
      (session) => toLocalCalendarDate(session.completedAt).slice(0, keyLength) === bucketKey,
    );
    return {
      date,
      sessions: bucketSessions.length,
      events: bucketSessions.reduce((total, session) => total + (eventsBySession.get(session.id)?.length ?? 0), 0),
    };
  });
}

export function compareReportMetric(current: number, previous: number): ReportMetricComparison {
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    direction: delta === 0 ? "flat" : delta > 0 ? "up" : "down",
  };
}

export function verificationStatusLabel(status: VerificationSummary["status"]): string {
  return status === "passed" ? "Passed" : status === "failed" ? "Failed" : "未執行";
}
