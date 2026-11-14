import type { TimelineResult } from "@work-intelligence/core";
import { toDateInputValue } from "./format";

/** The timeline API caps a range at 366 days; a page that spans more shows no day summaries. */
const MAX_RANGE_DAYS = 366;
/** One timeline response holds at most this many Sessions and this many Knowledge events (see the storage layer). */
export const TIMELINE_ROW_LIMIT = 2_000;
const DAY_MS = 86_400_000;

export type SessionDaySummary = { total: number; passed: number; failed: number };
export type SessionDayInsights = {
  /** Whole-day counts keyed by local calendar date (YYYY-MM-DD). */
  days: ReadonlyMap<string, SessionDaySummary>;
  /** Knowledge created from each Session, keyed by Session id. */
  createdBySession: ReadonlyMap<string, number>;
};

export type SessionDayRange = { from: string; to: string };

/** Local calendar date of an ISO timestamp, the same day boundary the grouped list uses. */
export function localDayOf(value: string): string {
  return toDateInputValue(new Date(value));
}

/**
 * The calendar range one timeline request needs: from the oldest day on the page to today, so Knowledge created
 * from a Session at any later time is counted. Null when the page is empty or the range exceeds the API limit.
 */
export function sessionDayRange(completedAts: readonly string[], now = new Date()): SessionDayRange | null {
  if (completedAts.length === 0) return null;
  const days = completedAts.map(localDayOf).sort();
  const from = days[0]!;
  const newest = days[days.length - 1]!;
  const today = toDateInputValue(now);
  const to = today < newest ? newest : today;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  return span <= MAX_RANGE_DAYS ? { from, to } : null;
}

/**
 * Counts Sessions per day and created Knowledge per Session. A timeline that reached a row limit may be missing
 * rows (only `truncated` reports Sessions, Knowledge events have no flag), so a count would not be exact: null.
 */
export function buildSessionDayInsights(result: TimelineResult | undefined): SessionDayInsights | null {
  if (!result || result.outcome !== "timeline" || result.truncated) return null;
  if (result.sessions.length >= TIMELINE_ROW_LIMIT || result.knowledgeEvents.length >= TIMELINE_ROW_LIMIT) return null;
  const days = new Map<string, SessionDaySummary>();
  for (const session of result.sessions) {
    const day = localDayOf(session.completedAt);
    const summary = days.get(day) ?? { total: 0, passed: 0, failed: 0 };
    summary.total += 1;
    if (session.verificationStatus === "passed") summary.passed += 1;
    if (session.verificationStatus === "failed") summary.failed += 1;
    days.set(day, summary);
  }
  const createdBySession = new Map<string, number>();
  for (const event of result.knowledgeEvents) {
    if (event.kind === "created" && event.sessionId) {
      createdBySession.set(event.sessionId, (createdBySession.get(event.sessionId) ?? 0) + 1);
    }
  }
  return { days, createdBySession };
}
