import { describe, expect, it } from "vitest";
import { packRows, visibleSpans } from "../../../apps/web/src/utils/timeline-layout.js";

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
