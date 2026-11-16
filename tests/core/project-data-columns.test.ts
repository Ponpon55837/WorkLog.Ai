import { describe, expect, it } from "vitest";
import { PROJECT_DATA_EXPORT_COLUMNS, PROJECT_DATA_TABLES } from "../../packages/core/src/index.js";
import { projectDataExportTableColumns } from "../../packages/schema/src/index.js";

describe("project-data export columns", () => {
  it("lists every project-data table exactly once", () => {
    expect(Object.keys(PROJECT_DATA_EXPORT_COLUMNS).sort()).toEqual([...PROJECT_DATA_TABLES].sort());
  });

  it("has unique columns per table, each starting with id", () => {
    for (const table of PROJECT_DATA_TABLES) {
      const columns = PROJECT_DATA_EXPORT_COLUMNS[table];
      expect(new Set(columns).size, table).toBe(columns.length);
      expect(columns[0], table).toBe("id");
    }
  });

  it("is the list the schema package validates imports with", () => {
    // toEqual, not toBe: the schema package resolves core through its package entry, this test through the source.
    expect(projectDataExportTableColumns).toEqual(PROJECT_DATA_EXPORT_COLUMNS);
  });
});
