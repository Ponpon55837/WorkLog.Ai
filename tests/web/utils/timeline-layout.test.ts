import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  DETAIL_MIN_DAY_WIDTH,
  axisTicks,
  dayBuckets,
  packRows,
  smallestFitting,
  startOfLocalDay,
  visibleSpans,
} from "../../../apps/web/src/utils/timeline-layout.js";
import { t } from "../../../apps/web/src/i18n/index.js";
import { weekdayLabel } from "../../../apps/web/src/utils/format.js";

describe("timeline layout", () => {
  it("stacks overlapping bars into the fewest rows and reuses a row once it frees up", () => {
    const { items, rows } = packRows([
      { id: "a", start: 0, end: 10 },
      { id: "b", start: 5, end: 15 },
      { id: "c", start: 11, end: 20 },
      { id: "d", start: 12, end: 13 },
      { id: "e", start: 16, end: 18 },
    ]);
    // b, c, and d all overlap at 12, so three rows are needed; e reuses the row d frees at 13.
    expect(rows).toBe(3);
    expect(Object.fromEntries(items.map((item) => [item.id, item.row]))).toEqual({ a: 0, b: 1, c: 0, d: 2, e: 2 });
    // A gap keeps bars that touch apart.
    expect(
      packRows(
        [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
        ],
        1,
      ).rows,
    ).toBe(2);
  });

  it("returns only bars intersecting the window, using the longest bar to bound the search", () => {
    const sorted = packRows([
      { id: "long", start: 0, end: 100 },
      { id: "early", start: 5, end: 6 },
      { id: "inside", start: 50, end: 55 },
      { id: "late", start: 200, end: 210 },
    ]).items;
    expect(visibleSpans(sorted, 40, 60, 100).map((item) => item.id)).toEqual(["long", "inside"]);
    expect(visibleSpans(sorted, 205, 300, 100).map((item) => item.id)).toEqual(["late"]);
    expect(visibleSpans(sorted, 120, 150, 100)).toEqual([]);
  });

  it("handles empty input and a single bar", () => {
    expect(packRows([])).toEqual({ items: [], rows: 0 });
    expect(visibleSpans([], 0, 10, 0)).toEqual([]);
    expect(packRows([{ start: 3, end: 4 }]).items).toEqual([{ start: 3, end: 4, row: 0 }]);
  });

  it("keeps ordering stable for many bars that end at different times", () => {
    const bars = Array.from({ length: 50 }, (_, index) => ({ start: index, end: index + (index % 7) + 1 }));
    const { items, rows } = packRows(bars);
    // No two bars in one row overlap.
    const byRow = new Map<number, Array<{ start: number; end: number }>>();
    for (const item of items) byRow.set(item.row, [...(byRow.get(item.row) ?? []), item]);
    for (const row of byRow.values()) {
      for (let index = 1; index < row.length; index += 1) {
        expect(row[index]!.start).toBeGreaterThanOrEqual(row[index - 1]!.end);
      }
    }
    expect(rows).toBeLessThanOrEqual(7);
  });
});

describe("timeline overview helpers", () => {
  const day = (month: number, date: number, hour = 12) => new Date(2031, month - 1, date, hour).getTime();

  it("counts Sessions per local day and verification result", () => {
    const at = (month: number, date: number, hour: number) => new Date(2031, month - 1, date, hour).toISOString();
    const buckets = dayBuckets([
      { completedAt: at(3, 2, 9), verificationStatus: "passed" },
      { completedAt: at(3, 2, 23), verificationStatus: "failed" },
      { completedAt: at(3, 1, 8), verificationStatus: "not_run" },
      { completedAt: at(3, 2, 10), verificationStatus: "not_supplied" },
      { completedAt: at(3, 2, 11), verificationStatus: "in_progress" },
    ]);
    expect(buckets).toEqual([
      { day: startOfLocalDay(day(3, 1)), passed: 0, failed: 0, inProgress: 0, other: 1, total: 1 },
      { day: startOfLocalDay(day(3, 2)), passed: 1, failed: 1, inProgress: 1, other: 1, total: 4 },
    ]);
    expect(dayBuckets([])).toEqual([]);
  });

  it("labels months when zoomed far out, Mondays at week level, and days and hours when zoomed in", () => {
    const start = startOfLocalDay(day(1, 15));
    const yearEnd = startOfLocalDay(day(12, 31)) + DAY_MS;
    const months = axisTicks(start, yearEnd, 3);
    expect(months[0]!.label).toBe(t("graph.axisMonth", { month: 2 }));
    expect(months).toHaveLength(11);

    const march = startOfLocalDay(day(3, 1));
    const weeks = axisTicks(march, march + 31 * DAY_MS, 10);
    expect(weeks.every((tick) => new Date(tick.time).getDay() === 1)).toBe(true);
    expect(weeks[0]!.label).toBe("3/3");

    expect(axisTicks(march, march + 4 * DAY_MS, 20).map((tick) => tick.label)).toEqual(["3/1", "3/3"]);
    const withWeekday = (monthDay: string, date: Date) =>
      t("graph.axisDayWithWeekday", { monthDay, weekday: weekdayLabel(date, false, "narrow") });
    expect(axisTicks(march, march + 2 * DAY_MS, 80).map((tick) => tick.label)).toEqual([
      withWeekday("3/1", new Date(day(3, 1))),
      withWeekday("3/2", new Date(day(3, 2))),
    ]);
    const hours = axisTicks(march, march + DAY_MS, 300);
    expect(hours.map((tick) => [tick.label, tick.major])).toEqual([
      [withWeekday("3/1", new Date(day(3, 1))), true],
      ["06:00", false],
      ["12:00", false],
      ["18:00", false],
    ]);
    expect(DETAIL_MIN_DAY_WIDTH).toBeGreaterThan(30);
  });

  it("finds the first candidate that fits by binary search", () => {
    const candidates = [48, 96, 192, 384, 768, 960];
    const probes: number[] = [];
    const fits = (width: number) => {
      probes.push(width);
      return width >= 300;
    };
    expect(smallestFitting(candidates, fits)).toBe(384);
    expect(probes.length).toBeLessThanOrEqual(3);
    expect(smallestFitting(candidates, () => true)).toBe(48);
    expect(smallestFitting(candidates, () => false)).toBe(960);
  });
});
