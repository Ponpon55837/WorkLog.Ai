import { describe, expect, it } from "vitest";
import { PROJECT_DATA_TABLES, type ProjectDataTable } from "../../packages/core/src/index.js";
import {
  projectDataExportRequestSchema,
  projectDataExportSchema,
  projectDataExportScopeSchema,
  projectDataExportTableColumns,
  projectDataImportInputSchema,
  projectPathRemapSchema,
} from "../../packages/schema/src/index.js";

type ProjectDataTables = Record<ProjectDataTable, Array<Record<string, string | number | null>>>;

const requiredColumns: Record<ProjectDataTable, readonly string[]> = {
  projects: ["name", "root_path", "status", "created_at", "updated_at"],
  sessions: [
    "project_id",
    "idempotency_key",
    "title",
    "summary",
    "work_summary_json",
    "status",
    "execution_status",
    "completed_at",
    "created_at",
    "changed_files_json",
    "changed_files_provenance_json",
    "changed_file_changes_json",
  ],
  work_events: ["session_id", "type", "summary", "occurred_at"],
  raw_snapshots: ["session_id", "project_id", "kind", "content", "captured_at"],
  evidence: ["session_id", "project_id", "kind", "reference", "captured_at"],
  void_audit: ["target_type", "target_id", "session_id", "project_id", "action", "occurred_at"],
  session_verification_updates: ["session_id", "source", "resulting_json", "created_at"],
  session_links: ["session_id", "related_session_id", "relation", "source", "created_at"],
  knowledge: [
    "project_id",
    "idempotency_key",
    "kind",
    "title",
    "body",
    "tags_json",
    "references_json",
    "status",
    "created_at",
    "updated_at",
    "applies_to_json",
  ],
  knowledge_audit: ["knowledge_id", "project_id", "action", "after_json", "changed_fields_json", "occurred_at"],
  knowledge_candidate_requests: ["project_id", "status", "requested_at", "source_session_ids_json", "candidate_count"],
  knowledge_candidates: [
    "request_id",
    "project_id",
    "kind",
    "title",
    "body",
    "tags_json",
    "references_json",
    "applies_to_json",
    "rationale",
    "status",
    "created_at",
  ],
  report_synthesis_requests: [
    "idempotency_key",
    "scope_type",
    "period",
    "range_from",
    "range_to",
    "status",
    "requested_at",
    "source_session_ids_json",
  ],
  report_summaries: [
    "request_id",
    "period",
    "range_from",
    "range_to",
    "title",
    "executive_summary",
    "themes_json",
    "highlights_json",
    "verification_json",
    "comparison_json",
    "risks_json",
    "decisions_json",
    "next_steps_json",
    "source_session_ids_json",
    "generated_by_agent",
    "prompt_version",
    "created_at",
    "is_current",
  ],
  metadata_backfill_requests: ["idempotency_key", "scope_type", "status", "requested_at", "source_session_ids_json"],
  session_summary_updates: [
    "session_id",
    "idempotency_key",
    "mode",
    "summary",
    "previous_summary",
    "resulting_summary",
    "created_at",
  ],
  session_work_summary_updates: [
    "session_id",
    "idempotency_key",
    "mode",
    "work_summary_json",
    "previous_work_summary_json",
    "resulting_work_summary_json",
    "created_at",
  ],
};

const enumDefaults: Partial<Record<ProjectDataTable, Record<string, string>>> = {
  projects: { status: "tracked" },
  sessions: { status: "finalized", execution_status: "completed" },
  work_events: { type: "execution" },
  raw_snapshots: { kind: "handoff" },
  void_audit: { target_type: "evidence", action: "restored" },
  session_verification_updates: { source: "web" },
  session_links: { relation: "continues", source: "agent" },
  knowledge: { kind: "pattern", status: "active" },
  knowledge_audit: { action: "updated" },
  knowledge_candidate_requests: { status: "completed" },
  knowledge_candidates: { kind: "gotcha", status: "proposed" },
  report_synthesis_requests: { scope_type: "project", period: "month", status: "completed" },
  report_summaries: { period: "month" },
  metadata_backfill_requests: { scope_type: "project", status: "completed" },
  session_summary_updates: { mode: "replace" },
  session_work_summary_updates: { mode: "replace" },
};

const emptyTables = (): ProjectDataTables =>
  Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, []])) as unknown as ProjectDataTables;

function validRow(table: ProjectDataTable, id: string): Record<string, string | number | null> {
  const row = Object.fromEntries(projectDataExportTableColumns[table].map((column) => [column, null])) as Record<
    string,
    string | number | null
  >;
  row.id = id;
  for (const column of requiredColumns[table]) {
    row[column] = "value";
  }
  for (const column of projectDataExportTableColumns[table]) {
    if (column.endsWith("_json")) {
      row[column] = "{}";
    }
  }
  Object.assign(row, enumDefaults[table]);
  if (table === "projects") {
    row.root_path = "/original/project";
  }
  if (table === "knowledge_candidate_requests") {
    row.candidate_count = 1;
  }
  if (table === "report_summaries") {
    row.is_current = 1;
  }
  return row;
}

function validBundle(scope: "all" | "project" = "project") {
  const tables = emptyTables();
  for (const table of PROJECT_DATA_TABLES) {
    tables[table].push(validRow(table, table === "projects" ? "project-1" : `${table}-1`));
  }
  return {
    format: "work-intelligence-export",
    formatVersion: 1,
    schemaVersion: 1,
    exportedAt: "2026-09-24T10:00:00.000Z",
    scope: scope === "all" ? { type: "all" as const } : { type: "project" as const, projectId: "project-1" },
    tables,
  };
}

function rowAt(bundle: ReturnType<typeof validBundle>, table: ProjectDataTable) {
  const row = bundle.tables[table][0];
  if (!row) {
    throw new Error(`Expected a fixture row for ${table}.`);
  }
  return row;
}

describe("project data transfer schemas", () => {
  it("validates the all-project and single-project scopes and requests", () => {
    expect(projectDataExportScopeSchema.safeParse({ type: "all" }).success).toBe(true);
    expect(projectDataExportScopeSchema.safeParse({ type: "project", projectId: " project-1 " }).success).toBe(true);
    expect(projectDataExportScopeSchema.safeParse({ type: "project", projectId: " " }).success).toBe(false);
    expect(projectDataExportScopeSchema.safeParse({ type: "all", projectId: "project-1" }).success).toBe(false);

    expect(projectDataExportRequestSchema.safeParse({ scope: "all" }).success).toBe(true);
    expect(projectDataExportRequestSchema.safeParse({ scope: "project", projectId: "project-1" }).success).toBe(true);
    expect(projectDataExportRequestSchema.safeParse({ scope: "project" }).success).toBe(false);
    expect(projectDataExportRequestSchema.safeParse({ scope: "all", projectId: "project-1" }).success).toBe(false);
  });

  it("accepts complete portable exports and rejects missing projects in project scope", () => {
    expect(projectDataExportSchema.safeParse(validBundle()).success).toBe(true);

    const allProjects = { ...validBundle("all"), scope: { type: "all" as const } };
    expect(projectDataExportSchema.safeParse(allProjects).success).toBe(true);

    const missingProject = validBundle();
    missingProject.tables.projects = [];
    expect(projectDataExportSchema.safeParse(missingProject).success).toBe(false);
  });

  it("rejects malformed row columns, values, JSON, paths, identifiers, and enum values", () => {
    const malformed = validBundle();
    const project = rowAt(malformed, "projects");
    project.id = "";
    project.name = null;
    project.root_path = "relative/path";
    project.status = "unknown";
    project.extra_column = "unsupported";
    delete project.updated_at;

    const session = rowAt(malformed, "sessions");
    session.work_summary_json = "not JSON";
    session.title = null;
    session.changed_files_json = 42;
    session.status = "unknown";

    rowAt(malformed, "work_events").type = "unknown";
    rowAt(malformed, "raw_snapshots").kind = "unknown";
    rowAt(malformed, "void_audit").target_type = "unknown";
    rowAt(malformed, "void_audit").action = "unknown";
    rowAt(malformed, "session_verification_updates").source = "unknown";
    rowAt(malformed, "session_links").relation = "unknown";
    rowAt(malformed, "session_links").source = "unknown";
    rowAt(malformed, "knowledge").kind = "unknown";
    rowAt(malformed, "knowledge").status = "unknown";
    rowAt(malformed, "knowledge_audit").action = "unknown";
    rowAt(malformed, "knowledge_candidate_requests").status = "unknown";
    rowAt(malformed, "knowledge_candidates").kind = "unknown";
    rowAt(malformed, "knowledge_candidates").status = "unknown";
    rowAt(malformed, "report_synthesis_requests").scope_type = "unknown";
    rowAt(malformed, "report_synthesis_requests").period = "unknown";
    rowAt(malformed, "report_synthesis_requests").status = "unknown";
    rowAt(malformed, "report_summaries").period = "unknown";
    rowAt(malformed, "metadata_backfill_requests").scope_type = "unknown";
    rowAt(malformed, "metadata_backfill_requests").status = "unknown";
    rowAt(malformed, "session_summary_updates").mode = "unknown";
    rowAt(malformed, "session_work_summary_updates").mode = "unknown";
    rowAt(malformed, "knowledge_candidate_requests").candidate_count = -1;
    rowAt(malformed, "report_summaries").is_current = 2;

    expect(projectDataExportSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects non-string optional values and duplicate or non-string identifiers", () => {
    const invalidValues = validBundle();
    rowAt(invalidValues, "evidence").summary = 42;
    rowAt(invalidValues, "projects").id = 42;
    expect(projectDataExportSchema.safeParse(invalidValues).success).toBe(false);

    const duplicateIds = validBundle();
    duplicateIds.tables.projects.push({ ...rowAt(duplicateIds, "projects") });
    expect(projectDataExportSchema.safeParse(duplicateIds).success).toBe(false);
  });

  it("validates absolute path remaps and rejects equal, relative, or duplicate prefixes", () => {
    expect(projectPathRemapSchema.safeParse({ from: "C:\\old", to: "D:\\new" }).success).toBe(true);
    expect(projectPathRemapSchema.safeParse({ from: "C:\\same", to: "C:\\same" }).success).toBe(false);
    expect(projectPathRemapSchema.safeParse({ from: "relative", to: "/absolute" }).success).toBe(false);

    const bundle = validBundle("all");
    const baseInput = { bundle };
    expect(projectDataImportInputSchema.safeParse(baseInput).success).toBe(true);
    expect(
      projectDataImportInputSchema.safeParse({
        bundle,
        remap: [
          { from: "C:\\Users\\work", to: "D:\\Work" },
          { from: "c:/users/work/", to: "E:/Other" },
        ],
      }).success,
    ).toBe(false);
  });
});
