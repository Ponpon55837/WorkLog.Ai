import { describe, expect, it } from "vitest";
import { weeklySessionTotals } from "../../../apps/web/src/utils/week-trend.js";

// Wednesday, fictional date.
const today = new Date(2030, 9, 9, 15);

describe("weekly session totals", () => {
  it("sums days into Monday-based weeks, oldest first, with missing days as zero", () => {
    const days = [
      { date: "2030-10-07", sessions: 2 },
      { date: "2030-10-09", sessions: 1 },
      { date: "2030-10-06", sessions: 4 },
      { date: "2030-09-23", sessions: 5 },
      { date: "2030-08-01", sessions: 9 },
    ];
    expect(weeklySessionTotals(days, today, 3)).toEqual([5, 4, 3]);
  });

  it("ignores days after today and returns zeros without data", () => {
    expect(weeklySessionTotals([{ date: "2030-10-10", sessions: 7 }], today, 2)).toEqual([0, 0]);
  });
});
