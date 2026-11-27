import { describe, expect, it, vi } from "vitest";
import { useRowSelection } from "../../../apps/web/src/composables/useRowSelection.js";

describe("useRowSelection", () => {
  it("selects and clears every eligible row through allSelected", () => {
    const onClear = vi.fn();
    const rows = useRowSelection(() => ["a", "b"], { onClear });

    rows.allSelected.value = true;
    expect(rows.selectedIds.value).toEqual(["a", "b"]);
    expect(rows.allSelected.value).toBe(true);

    rows.allSelected.value = false;
    expect(rows.selectedIds.value).toEqual([]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("is never all-selected without eligible rows", () => {
    expect(useRowSelection(() => []).allSelected.value).toBe(false);
  });

  it("adds and removes single rows without duplicates", () => {
    const rows = useRowSelection(() => ["a", "b", "c"]);

    rows.selectItem("a", true);
    rows.selectItem("a", true);
    rows.selectItem("b", true);
    rows.selectItem("a", false);

    expect(rows.selectedIds.value).toEqual(["b"]);
  });

  it("drops finished rows, keeps the rest and clears once nothing is left", () => {
    const onClear = vi.fn();
    const rows = useRowSelection(() => ["a", "b"], { onClear });
    rows.allSelected.value = true;

    rows.dropFromSelection(["a"]);
    expect(rows.selectedIds.value).toEqual(["b"]);
    expect(onClear).not.toHaveBeenCalled();

    rows.dropFromSelection(["b"]);
    expect(rows.selectedIds.value).toEqual([]);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
