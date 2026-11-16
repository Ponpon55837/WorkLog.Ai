import { describe, expect, it } from "vitest";
import { PROJECT_DATA_TABLES } from "../../packages/core/src/index.js";
import { projectDataExportTableColumns } from "../../packages/schema/src/index.js";
import { PROJECT_DATA_EXPORT_COLUMNS } from "../../packages/storage/src/project-data-export-columns.js";

describe("project-data export columns", () => {
  it("match the schema package's list table by table, in the same order", () => {
    // The backup worker reads rows with the zod-free copy; the import validator uses the schema package's list.
    expect(Object.keys(PROJECT_DATA_EXPORT_COLUMNS).sort()).toEqual([...PROJECT_DATA_TABLES].sort());
    for (const table of PROJECT_DATA_TABLES) {
      expect(PROJECT_DATA_EXPORT_COLUMNS[table], table).toEqual(projectDataExportTableColumns[table]);
    }
  });
});
