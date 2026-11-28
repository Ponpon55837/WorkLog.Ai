import { describe, expect, it } from "vitest";
import type { ProjectDataImportPreview } from "@work-intelligence/core";
import { importBreakdown, importWritesData, totalCount } from "../../../apps/web/src/utils/project-data-import.js";

function preview(overrides: Partial<ProjectDataImportPreview>): ProjectDataImportPreview {
  return {
    outcome: "project_data_import_preview",
    strategy: "newer-wins",
    additions: {},
    skipped: {},
    conflicts: {},
    updates: {},
    keptLocal: {},
    renumbered: {},
    replacedLocal: {},
    selectedProjects: [],
    remappedPaths: [],
    autoRemaps: [],
    conflictDetails: [],
    conflictDetailsTruncated: false,
    conflictGroups: [],
    ...overrides,
  };
}

describe("project data import summary", () => {
  it("totals counts across every record type", () => {
    expect(totalCount({ sessions: 3, work_events: 4, outstanding_items: 2 })).toBe(9);
    expect(totalCount({})).toBe(0);
  });

  it("breaks counts down by record type in table order and skips empty types", () => {
    const rows = importBreakdown(
      preview({
        additions: { work_events: 28, sessions: 3 },
        skipped: { sessions: 5, knowledge_pages: 1 },
        keptLocal: { outstanding_items: 2 },
      }),
    );
    expect(rows).toEqual([
      { table: "sessions", counts: { additions: 3, skipped: 5 } },
      { table: "work_events", counts: { additions: 28 } },
      { table: "knowledge_pages", counts: { skipped: 1 } },
      { table: "outstanding_items", counts: { keptLocal: 2 } },
    ]);
    expect(rows.reduce((sum, row) => sum + (row.counts.additions ?? 0), 0)).toBe(31);
  });

  it("writes data only for additions, updates, renumbered versions or replaced decisions", () => {
    expect(importWritesData(preview({ skipped: { sessions: 6670 }, keptLocal: { sessions: 1 } }))).toBe(false);
    expect(importWritesData(preview({ conflicts: { sessions: 2 } }))).toBe(false);
    expect(importWritesData(preview({ additions: { sessions: 1 } }))).toBe(true);
    expect(importWritesData(preview({ updates: { knowledge: 1 } }))).toBe(true);
    expect(importWritesData(preview({ renumbered: { knowledge_page_versions: 1 } }))).toBe(true);
    expect(importWritesData(preview({ replacedLocal: { session_decisions: 1 } }))).toBe(true);
  });
});
