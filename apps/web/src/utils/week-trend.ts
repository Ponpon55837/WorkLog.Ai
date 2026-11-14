import type { ActivityDay } from "@work-intelligence/core";
import { toDateInputValue } from "./format";

/**
 * Sessions per Monday-based local week for the latest `weeks` weeks, oldest first; the last entry is the week that
 * contains `today`. Days missing from `days` count as zero.
 */
export function weeklySessionTotals(days: readonly ActivityDay[], today: Date, weeks: number): number[] {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const starts = Array.from({ length: weeks }, (_, index) =>
    toDateInputValue(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - (weeks - 1 - index) * 7)),
  );
  const totals = starts.map(() => 0);
  const todayKey = toDateInputValue(today);
  for (const day of days) {
    if (day.date > todayKey || day.date < starts[0]!) continue;
    // Week starts are ISO dates, so the last start not after the day is its week.
    let index = starts.length - 1;
    while (starts[index]! > day.date) index -= 1;
    totals[index] = (totals[index] ?? 0) + day.sessions;
  }
  return totals;
}
