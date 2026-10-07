import { describe, expect, it } from "vitest";
import { activityLevel, activityRange, buildActivityCalendar } from "../../../apps/web/src/utils/activity-calendar.js";

// Wednesday, fictional date.
const today = new Date(2030, 9, 9, 15);

describe("activity calendar", () => {
  it("covers 53 Monday-based weeks ending today", () => {
    expect(activityRange(today)).toEqual({ from: "2029-10-08", to: "2030-10-09" });
    const calendar = buildActivityCalendar(today, []);
    expect(calendar.weeks).toHaveLength(53);
    expect(calendar.weeks[0]![0]!.date).toBe("2029-10-08");
    // The last week holds Monday–Wednesday only; later days are not drawn.
    expect(calendar.weeks[52]!.map((cell) => cell?.date ?? null)).toEqual([
      "2030-10-07",
      "2030-10-08",
      "2030-10-09",
      null,
      null,
      null,
      null,
    ]);
  });

  it("shades days relative to the busiest day and totals the range", () => {
    const calendar = buildActivityCalendar(today, [
      { date: "2030-10-08", sessions: 8 },
      { date: "2030-10-09", sessions: 1 },
      { date: "2029-10-08", sessions: 4 },
      { date: "2029-10-07", sessions: 50 },
    ]);
    expect(calendar.total).toBe(13);
    const last = calendar.weeks[52]!;
    expect(last[1]).toMatchObject({ sessions: 8, level: 4 });
    expect(last[2]).toMatchObject({ sessions: 1, level: 1 });
    expect(calendar.weeks[0]![0]).toMatchObject({ sessions: 4, level: 2 });
    expect(last[0]).toMatchObject({ sessions: 0, level: 0 });
  });

  it("maps counts to five levels and labels months without overlap", () => {
    expect([0, 1, 25, 50, 75, 100].map((n) => activityLevel(n, 100))).toEqual([0, 1, 1, 2, 3, 4]);
    expect(activityLevel(3, 0)).toBe(0);
    const { months } = buildActivityCalendar(today, []);
    expect(months.length).toBeGreaterThanOrEqual(12);
    for (let index = 1; index < months.length; index += 1) {
      expect(months[index]!.week - months[index - 1]!.week).toBeGreaterThanOrEqual(3);
    }
  });
});
