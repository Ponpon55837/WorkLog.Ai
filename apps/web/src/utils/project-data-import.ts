import { PROJECT_DATA_TABLES } from "@work-intelligence/core";
import type { ProjectDataCounts, ProjectDataImportPreview, ProjectDataTable } from "@work-intelligence/core";

export type ImportCountKind = "additions" | "updates" | "keptLocal" | "skipped" | "conflicts";

export interface ImportBreakdownRow {
  table: ProjectDataTable;
  counts: Partial<Record<ImportCountKind, number>>;
}

export const importCountKinds: readonly ImportCountKind[] = [
  "additions",
  "updates",
  "keptLocal",
  "skipped",
  "conflicts",
];

export function totalCount(counts: ProjectDataCounts): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/** One row per record type that appears in any count, in the canonical table order. */
export function importBreakdown(preview: ProjectDataImportPreview): ImportBreakdownRow[] {
  const rows: ImportBreakdownRow[] = [];
  for (const table of PROJECT_DATA_TABLES) {
    const counts: ImportBreakdownRow["counts"] = {};
    for (const kind of importCountKinds) {
      const count = preview[kind][table] ?? 0;
      if (count > 0) counts[kind] = count;
    }
    if (Object.keys(counts).length > 0) rows.push({ table, counts });
  }
  return rows;
}
