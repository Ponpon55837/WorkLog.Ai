import { describe, expect, it } from "vitest";
import { trustCells } from "../../../apps/web/src/utils/knowledge-trust.js";

const count = (cells: string[], kind: string) => cells.filter((cell) => cell === kind).length;

describe("knowledge trust cells", () => {
  it("draws nothing without feedback, and one cell per count when small", () => {
    expect(trustCells(0, 0)).toEqual([]);
    expect(trustCells(3, 1)).toEqual(["confirmed", "confirmed", "confirmed", "contradicted"]);
  });

  it("scales large counts to the cell limit and keeps a minority visible", () => {
    const cells = trustCells(100, 1);
    expect(cells).toHaveLength(12);
    expect(count(cells, "contradicted")).toBe(1);
    const mostlyContradicted = trustCells(1, 100);
    expect(mostlyContradicted).toHaveLength(12);
    expect(count(mostlyContradicted, "confirmed")).toBe(1);
    expect(trustCells(50, 0)).toHaveLength(12);
  });
});
