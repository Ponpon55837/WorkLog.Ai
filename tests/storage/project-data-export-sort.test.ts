import { describe, expect, it } from "vitest";
import type { ProjectDataRow, ProjectDataTable } from "../../packages/core/src/index.js";
import { sortExportRows } from "../../packages/storage/src/project-data-export.js";

const COLLATOR = new Intl.Collator();

function row(id: string, mark: string, createdAt?: string): ProjectDataRow {
  return { id, mark, ...(createdAt === undefined ? {} : { created_at: createdAt }) } as unknown as ProjectDataRow;
}

/** The pre-change behavior: always sort, with the same comparator. */
function alwaysSorted(table: ProjectDataTable, rows: ProjectDataRow[]): ProjectDataRow[] {
  return [...rows].sort((left, right) => {
    if (table === "outstanding_item_events") {
      const byCreatedAt = COLLATOR.compare(String(left.created_at), String(right.created_at));
      if (byCreatedAt !== 0) return byCreatedAt;
    }
    return COLLATOR.compare(String(left.id), String(right.id));
  });
}

function expectSameAsAlwaysSort(table: ProjectDataTable, rows: ProjectDataRow[]): ProjectDataRow[] {
  const expected = alwaysSorted(table, rows);
  const actual = sortExportRows(table, [...rows]);
  expect(actual.map((entry) => entry.mark)).toEqual(expected.map((entry) => entry.mark));
  return actual;
}

describe("sortExportRows", () => {
  it("sorts rows that are not in collator order", () => {
    const rows = ["b", "A", "a", "B", "_x", "-y", "é", "z"].map((id, index) => row(id, String(index)));
    expect(sortExportRows("sessions", [...rows]).map((entry) => entry.id)).toEqual(
      alwaysSorted("sessions", rows).map((entry) => entry.id),
    );
    expectSameAsAlwaysSort("sessions", rows);
  });

  it("leaves rows that are already in order as they are, without copying", () => {
    const rows = ["_a", "-a", "a", "A", "b", "B"].map((id, index) => row(id, String(index)));
    expect(alwaysSorted("sessions", rows).map((entry) => entry.id)).toEqual(rows.map((entry) => entry.id));
    const result = sortExportRows("sessions", rows);
    expect(result).toBe(rows);
    expectSameAsAlwaysSort("sessions", rows);
  });

  it("sorts when only the last row is out of order after a sorted prefix", () => {
    const rows = ["a", "b", "c", "d", "e", "A"].map((id, index) => row(id, String(index)));
    expectSameAsAlwaysSort("sessions", rows);
    expect(sortExportRows("sessions", [...rows]).map((entry) => entry.id)).toEqual(["a", "A", "b", "c", "d", "e"]);
  });

  it("sorts when the out-of-order row is first or in the middle", () => {
    expectSameAsAlwaysSort(
      "sessions",
      ["Z", "a", "b", "c"].map((id, index) => row(id, String(index))),
    );
    expectSameAsAlwaysSort(
      "sessions",
      ["a", "b", "B", "A", "c"].map((id, index) => row(id, String(index))),
    );
  });

  it("handles empty and single-row input", () => {
    expect(sortExportRows("sessions", [])).toEqual([]);
    const single = [row("only", "0")];
    expect(sortExportRows("sessions", single)).toBe(single);
  });

  it("keeps the order of keys the collator treats as equal but that differ in bytes", () => {
    // Canonically equivalent (NFC and NFD) and ignorable-character variants compare equal under the default collator.
    const nfc = "éclair";
    const nfd = "éclair";
    const ignorable = "a​b";
    expect(COLLATOR.compare(nfc, nfd)).toBe(0);
    expect(COLLATOR.compare("ab", ignorable)).toBe(0);
    for (const ids of [
      [nfc, nfd],
      [nfd, nfc],
      ["ab", ignorable],
      [ignorable, "ab"],
      ["c", nfd, nfc, nfd, "f"],
      ["ab", ignorable, "ab", "ac"],
      ["ac", "ab", ignorable],
    ]) {
      const rows = ids.map((id, index) => row(id, String(index)));
      const actual = expectSameAsAlwaysSort("sessions", rows);
      expect(actual).toHaveLength(rows.length);
    }
    // Equal keys already in order stay in their original order, byte-different or not.
    const equalRows = [row(nfd, "first"), row(nfc, "second"), row(nfd, "third")];
    expect(sortExportRows("sessions", equalRows).map((entry) => entry.mark)).toEqual(["first", "second", "third"]);
  });

  it("orders outstanding_item_events by created_at, then id, keeping equal pairs stable", () => {
    const at = "2026-01-02T03:04:05.000Z";
    const later = "2026-01-02T03:04:06.000Z";
    const rows = [
      row("b", "0", at),
      row("B", "1", at),
      row("a", "2", later),
      row("a", "3", at),
      row("é", "4", at),
      row("é", "5", at),
    ];
    expectSameAsAlwaysSort("outstanding_item_events", rows);
    const ordered = alwaysSorted("outstanding_item_events", rows);
    expect(sortExportRows("outstanding_item_events", [...ordered]).map((entry) => entry.mark)).toEqual(
      ordered.map((entry) => entry.mark),
    );
    // Rows sorted by id alone are not in created_at order, so the table-specific comparator must still sort them.
    const byIdOnly = [row("a", "0", later), row("b", "1", at)];
    expect(sortExportRows("outstanding_item_events", byIdOnly).map((entry) => entry.mark)).toEqual(["1", "0"]);
  });
});
