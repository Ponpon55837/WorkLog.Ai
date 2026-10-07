import type { ActivityDay } from "@work-intelligence/core";
import { toDateInputValue } from "./format";

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface ActivityCell {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  sessions: number;
  level: ActivityLevel;
}

export interface ActivityMonthLabel {
  /** Zero-based week column the label starts above. */
  week: number;
  /** First day of that month, for the locale-aware label. */
  date: Date;
}

export interface ActivityCalendar {
  from: string;
  to: string;
  /** Weeks start on Monday; each week holds seven rows, with null after today. */
  weeks: Array<Array<ActivityCell | null>>;
  months: ActivityMonthLabel[];
  total: number;
}

const WEEKS = 53;
/** A month label needs this many week columns before the next one, or it would overlap. */
const MIN_LABEL_GAP = 3;

function addDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

/** Monday on or before the date (local time). */
function mondayOf(value: Date): Date {
  return addDays(value, -((value.getDay() + 6) % 7));
}

/** The inclusive calendar-date range the heatmap draws: the last 53 Monday-based weeks ending today. */
export function activityRange(today: Date): { from: string; to: string } {
  return { from: toDateInputValue(addDays(mondayOf(today), -(WEEKS - 1) * 7)), to: toDateInputValue(today) };
}

/** Shade level 1–4 relative to the busiest day, so a quiet history still shows contrast. */
export function activityLevel(sessions: number, max: number): ActivityLevel {
  if (sessions <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((sessions / max) * 4))) as ActivityLevel;
}

export function buildActivityCalendar(today: Date, days: readonly ActivityDay[]): ActivityCalendar {
  const range = activityRange(today);
  const counts = new Map(days.map((day) => [day.date, day.sessions]));
  const first = addDays(mondayOf(today), -(WEEKS - 1) * 7);
  const todayKey = toDateInputValue(today);
  const inRange = days.filter((day) => day.date >= range.from && day.date <= range.to);
  const max = Math.max(0, ...inRange.map((day) => day.sessions));

  const weeks: ActivityCalendar["weeks"] = [];
  const months: ActivityMonthLabel[] = [];
  let lastLabelWeek = -MIN_LABEL_GAP;
  let lastMonth = -1;
  for (let week = 0; week < WEEKS; week += 1) {
    const column: Array<ActivityCell | null> = [];
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(first, week * 7 + row);
      const key = toDateInputValue(date);
      if (key > todayKey) {
        column.push(null);
        continue;
      }
      const sessions = counts.get(key) ?? 0;
      column.push({ date: key, sessions, level: activityLevel(sessions, max) });
    }
    const monday = addDays(first, week * 7);
    if (monday.getMonth() !== lastMonth) {
      lastMonth = monday.getMonth();
      if (week - lastLabelWeek >= MIN_LABEL_GAP) {
        months.push({ week, date: new Date(monday.getFullYear(), monday.getMonth(), 1) });
        lastLabelWeek = week;
      }
    }
    weeks.push(column);
  }

  return {
    from: range.from,
    to: range.to,
    weeks,
    months,
    total: inRange.reduce((sum, day) => sum + day.sessions, 0),
  };
}
