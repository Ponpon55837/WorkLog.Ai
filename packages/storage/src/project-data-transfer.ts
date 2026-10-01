import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  isSafeRepositoryUrl,
  PROJECT_DATA_TABLES,
  type ProjectDataCounts,
  type ProjectDataExport,
  type ProjectDataImportConflict,
  type ProjectDataImportInput,
  type ProjectDataImportPreview,
  type ProjectDataImportResult,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
  type ProjectPathRemap,
  type ProjectDataExportScope,
} from "@work-intelligence/core";
import {
  projectDataExportSchema,
  projectDataImportInputSchema,
  projectDataColumnValue,
  projectDataExportTableColumns,
} from "@work-intelligence/schema";
import { nowIso } from "@work-intelligence/shared";
import { remapPathPrefix } from "./project-path-remap.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
import { combineRedactionSummaries, redactText } from "./secret-redaction.js";

const TABLE_ORDER: readonly ProjectDataTable[] = [
  "projects",
  "sessions",
  "work_events",
  "raw_snapshots",
  "evidence",
  "void_audit",
  "session_verification_updates",
  "session_links",
  "knowledge",
  "session_decisions",
  "knowledge_audit",
  "knowledge_feedback",
  "knowledge_candidate_requests",
  "knowledge_candidates",
  "report_synthesis_requests",
  "report_summaries",
  "metadata_backfill_requests",
  "session_summary_updates",
  "session_work_summary_updates",
  "outstanding_items",
  "outstanding_cleanup_requests",
  "outstanding_cleanup_submissions",
  "outstanding_cleanup_request_items",
  "outstanding_cleanup_proposals",
  "outstanding_cleanup_proposal_evidence",
  "outstanding_item_events",
  "knowledge_pages",
  "knowledge_page_versions",
  "session_diagrams",
];

const UNIQUE_FIELDS: Partial<Record<ProjectDataTable, readonly (readonly string[])[]>> = {
  sessions: [["idempotency_key"]],
  evidence: [["session_id", "kind", "reference"]],
  knowledge: [["project_id", "idempotency_key"]],
  report_synthesis_requests: [["idempotency_key"]],
  metadata_backfill_requests: [["idempotency_key"]],
  session_summary_updates: [["idempotency_key"]],
  session_work_summary_updates: [["idempotency_key"]],
  outstanding_items: [["source_session_id", "position", "id"]],
  outstanding_cleanup_requests: [["idempotency_key"]],
  outstanding_cleanup_submissions: [["request_id", "idempotency_key"]],
  outstanding_cleanup_request_items: [
    ["request_id", "item_id"],
    ["request_id", "position"],
  ],
  outstanding_cleanup_proposals: [["request_item_id"]],
  outstanding_cleanup_proposal_evidence: [["proposal_id", "session_id"]],
  outstanding_item_events: [["id"]],
  session_links: [["session_id", "related_session_id"]],
  session_decisions: [["session_id", "position"]],
  knowledge_pages: [["project_id", "slug"]],
  knowledge_page_versions: [["page_id", "version"]],
  session_diagrams: [["session_id", "idempotency_key"]],
};

const CONFLICT_DETAIL_LIMIT = 100;
const MAX_CONFLICT_ID_LENGTH = 200;

const REDACTABLE_FIELDS: Partial<Record<ProjectDataTable, readonly string[]>> = {
  sessions: ["title", "summary", "work_summary_json", "verification_json", "void_reason"],
  session_decisions: ["text"],
  knowledge_pages: ["title", "question", "sections_json"],
  knowledge_page_versions: ["title", "question", "sections_json"],
  session_diagrams: ["title", "source", "void_reason"],
  work_events: ["summary", "details_json"],
  raw_snapshots: ["content"],
  evidence: ["kind", "reference", "summary", "void_reason"],
  void_audit: ["reason"],
  session_verification_updates: ["previous_json", "resulting_json"],
  session_summary_updates: ["summary", "previous_summary", "resulting_summary"],
  session_work_summary_updates: ["work_summary_json", "previous_work_summary_json", "resulting_work_summary_json"],
  outstanding_items: ["text"],
  outstanding_cleanup_request_items: ["text"],
  outstanding_cleanup_proposals: ["reason"],
  knowledge: ["title", "body", "tags_json", "references_json", "applies_to_json", "review_json"],
  knowledge_audit: ["before_json", "after_json", "changed_fields_json"],
  knowledge_candidate_requests: ["failure_reason"],
  knowledge_candidates: ["title", "body", "tags_json", "references_json", "applies_to_json", "rationale"],
  report_synthesis_requests: ["failure_reason"],
  report_summaries: [
    "title",
    "executive_summary",
    "themes_json",
    "highlights_json",
    "verification_json",
    "comparison_json",
    "risks_json",
    "decisions_json",
    "next_steps_json",
    "generated_by_agent",
    "generated_by_model",
  ],
  metadata_backfill_requests: ["failure_reason"],
};

function redactProjectDataRows(rows: Record<ProjectDataTable, ProjectDataRow[]>): {
  rows: Record<ProjectDataTable, ProjectDataRow[]>;
  redactions: ReturnType<typeof combineRedactionSummaries>;
} {
  const allRedactions = combineRedactionSummaries();
  const sessionCounts = new Map<string, number>();
  const cleanupItemSourceSessionIds = new Map(
    rows.outstanding_cleanup_request_items.map((item) => [String(item.id), String(item.source_session_id)]),
  );
  const cleanupProposalSourceSessionIds = new Map(
    rows.outstanding_cleanup_proposals.flatMap((proposal) => {
      const sourceSessionId = cleanupItemSourceSessionIds.get(String(proposal.request_item_id));
      return sourceSessionId ? [[String(proposal.id), sourceSessionId] as const] : [];
    }),
  );
  const sanitized = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => {
      const result = rows[table].map((row) => {
        const output = { ...row } as Record<string, ProjectDataValue>;
        let rowCount = 0;
        for (const field of REDACTABLE_FIELDS[table] ?? []) {
          const value = output[field];
          if (typeof value !== "string") {
            continue;
          }
          const result = redactText(value);
          output[field] = result.value;
          rowCount += result.redactions.total;
          allRedactions.total += result.redactions.total;
          for (const [kind, count] of Object.entries(result.redactions.byKind)) {
            const key = kind as keyof typeof allRedactions.byKind;
            allRedactions.byKind[key] = (allRedactions.byKind[key] ?? 0) + (count ?? 0);
          }
        }
        if (rowCount > 0) {
          const sessionId =
            table === "sessions"
              ? String(output.id)
              : String(
                  output.session_id ??
                    output.source_session_id ??
                    (table === "outstanding_cleanup_proposals"
                      ? cleanupProposalSourceSessionIds.get(String(output.id))
                      : "") ??
                    "",
                );
          if (sessionId) {
            sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + rowCount);
          }
        }
        return output as unknown as ProjectDataRow;
      });
      return [table, result];
    }),
  ) as unknown as Record<ProjectDataTable, ProjectDataRow[]>;

  for (const session of sanitized.sessions as Array<ProjectDataRow & { id: string; redaction_count: number }>) {
    session.redaction_count = Number(session.redaction_count ?? 0) + (sessionCounts.get(session.id) ?? 0);
  }
  return { rows: sanitized, redactions: allRedactions };
}

export type ProjectDataTransferErrorCode =
  "invalid_input" | "invalid_bundle" | "unsupported_schema" | "project_not_found";

export class ProjectDataTransferError extends Error {
  public constructor(
    public readonly code: ProjectDataTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDataTransferError";
  }
}

function sanitizeImportInput(input: ProjectDataImportInput): {
  input: ProjectDataImportInput;
  redactions: ReturnType<typeof combineRedactionSummaries>;
} {
  const inputResult = projectDataImportInputSchema.safeParse(input);
  if (!inputResult.success) {
    throw new ProjectDataTransferError(
      "invalid_input",
      `匯入資料不符合格式：${inputResult.error.issues[0]?.message ?? "欄位驗證失敗。"}`,
    );
  }
  const sanitized = redactProjectDataRows(inputResult.data.bundle.tables);
  return {
    input: {
      ...inputResult.data,
      bundle: { ...inputResult.data.bundle, tables: sanitized.rows },
    },
    redactions: sanitized.redactions,
  };
}

interface PlannedRow {
  row: ProjectDataRow;
  disposition: "add" | "skip" | "conflict";
  reason?: string;
}

type InsertStatement = ReturnType<DatabaseSync["prepare"]>;

interface TransferPlan {
  rows: Record<ProjectDataTable, PlannedRow[]>;
  projectIds: Map<string, string>;
  selectedProjects: ProjectDataImportPreview["selectedProjects"];
  remappedPaths: ProjectDataImportPreview["remappedPaths"];
  conflicts: ProjectDataImportConflict[];
  conflictDetailsTruncated: boolean;
}

function emptyCounts(): Record<ProjectDataTable, number> {
  return Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, 0])) as Record<ProjectDataTable, number>;
}

function emptyRows(): Record<ProjectDataTable, PlannedRow[]> {
  return Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, []])) as unknown as Record<
    ProjectDataTable,
    PlannedRow[]
  >;
}

function sqlRows(
  db: DatabaseSync,
  table: ProjectDataTable,
  where = "",
  values: ProjectDataValue[] = [],
): ProjectDataRow[] {
  const columns = projectDataExportTableColumns[table].join(", ");
  const orderBy = table === "outstanding_item_events" ? "created_at, id" : "id";
  const sql = `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY ${orderBy}`;
  return db.prepare(sql).all(...values) as unknown as ProjectDataRow[];
}

function rowsByIds(
  db: DatabaseSync,
  table: ProjectDataTable,
  column: string,
  ids: readonly string[],
): ProjectDataRow[] {
  if (ids.length === 0) {
    return [];
  }
  const results: ProjectDataRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const placeholders = batch.map(() => "?").join(", ");
    results.push(...sqlRows(db, table, `${column} IN (${placeholders})`, [...batch]));
  }
  return results.sort((left, right) => {
    if (table === "outstanding_item_events") {
      const byCreatedAt = String(left.created_at).localeCompare(String(right.created_at));
      if (byCreatedAt !== 0) return byCreatedAt;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

function getRows(db: DatabaseSync, table: ProjectDataTable): Set<string> {
  const ids = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
  return new Set(ids.map((row) => row.id));
}

function selectExportRows(db: DatabaseSync, scope: ProjectDataExportScope): Record<ProjectDataTable, ProjectDataRow[]> {
  const projects =
    scope.type === "all" ? sqlRows(db, "projects") : sqlRows(db, "projects", "id = ?", [scope.projectId]);
  const projectIds = projects.map((project) => String(project.id));
  const sessions = rowsByIds(db, "sessions", "project_id", projectIds);
  const sessionIds = sessions.map((session) => String(session.id));
  const sessionIdSet = new Set(sessionIds);
  const reportRequests =
    scope.type === "all"
      ? sqlRows(db, "report_synthesis_requests")
      : sqlRows(db, "report_synthesis_requests", "scope_type = 'project' AND project_id = ?", [scope.projectId]);
  const reportRequestIds = reportRequests.map((request) => String(request.id));
  const candidateRequests = rowsByIds(db, "knowledge_candidate_requests", "project_id", projectIds);
  const candidateRequestIds = candidateRequests.map((request) => String(request.id));
  const rows: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects,
    sessions,
    work_events: rowsByIds(db, "work_events", "session_id", sessionIds),
    raw_snapshots: rowsByIds(db, "raw_snapshots", "project_id", projectIds),
    evidence: rowsByIds(db, "evidence", "project_id", projectIds),
    void_audit: rowsByIds(db, "void_audit", "project_id", projectIds),
    session_verification_updates: rowsByIds(db, "session_verification_updates", "session_id", sessionIds),
    session_links: sqlRows(db, "session_links").filter(
      (link) => sessionIdSet.has(String(link.session_id)) && sessionIdSet.has(String(link.related_session_id)),
    ),
    knowledge: rowsByIds(db, "knowledge", "project_id", projectIds),
    session_decisions: rowsByIds(db, "session_decisions", "project_id", projectIds),
    knowledge_pages: rowsByIds(db, "knowledge_pages", "project_id", projectIds),
    knowledge_page_versions: rowsByIds(db, "knowledge_page_versions", "project_id", projectIds),
    knowledge_audit: rowsByIds(db, "knowledge_audit", "project_id", projectIds),
    knowledge_feedback: rowsByIds(db, "knowledge_feedback", "project_id", projectIds),
    session_diagrams: rowsByIds(db, "session_diagrams", "project_id", projectIds),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: rowsByIds(db, "knowledge_candidates", "project_id", projectIds),
    report_synthesis_requests: reportRequests,
    report_summaries:
      scope.type === "all"
        ? sqlRows(db, "report_summaries")
        : rowsByIds(db, "report_summaries", "request_id", reportRequestIds),
    metadata_backfill_requests:
      scope.type === "all"
        ? sqlRows(db, "metadata_backfill_requests")
        : sqlRows(db, "metadata_backfill_requests", "scope_type = 'project' AND project_id = ?", [scope.projectId]),
    session_summary_updates: rowsByIds(db, "session_summary_updates", "session_id", sessionIds),
    session_work_summary_updates: rowsByIds(db, "session_work_summary_updates", "session_id", sessionIds),
    outstanding_items: rowsByIds(db, "outstanding_items", "project_id", projectIds),
    outstanding_cleanup_requests: rowsByIds(db, "outstanding_cleanup_requests", "project_id", projectIds),
    outstanding_cleanup_submissions: rowsByIds(db, "outstanding_cleanup_submissions", "project_id", projectIds),
    outstanding_cleanup_request_items: rowsByIds(db, "outstanding_cleanup_request_items", "project_id", projectIds),
    outstanding_cleanup_proposals: rowsByIds(db, "outstanding_cleanup_proposals", "project_id", projectIds),
    outstanding_cleanup_proposal_evidence: rowsByIds(
      db,
      "outstanding_cleanup_proposal_evidence",
      "project_id",
      projectIds,
    ),
    outstanding_item_events: rowsByIds(db, "outstanding_item_events", "project_id", projectIds),
  };

  if (scope.type === "all") {
    rows.knowledge_candidates = sqlRows(db, "knowledge_candidates");
    rows.report_summaries = sqlRows(db, "report_summaries");
  }
  if (candidateRequestIds.length > 0) {
    const candidateIds = new Set(candidateRequestIds);
    rows.knowledge_candidates = rows.knowledge_candidates.filter((candidate) =>
      candidateIds.has(String(candidate.request_id)),
    );
  }
  return rows;
}

function bundleForScope(bundle: ProjectDataExport, projectId?: string): ProjectDataExport {
  const selectedIds = new Set(
    (projectId ? [projectId] : bundle.tables.projects.map((project) => String(project.id))).filter(
      (id) => id.length > 0,
    ),
  );
  if (selectedIds.size === 0) {
    throw new ProjectDataTransferError("invalid_bundle", "匯入檔中沒有可匯入的專案。");
  }
  if (bundle.scope.type === "project" && !selectedIds.has(bundle.scope.projectId)) {
    throw new ProjectDataTransferError("invalid_bundle", "所選專案不在這份單一專案匯出檔中。");
  }
  const selectedProjects = bundle.tables.projects.filter((project) => selectedIds.has(String(project.id)));
  if (selectedProjects.length !== selectedIds.size) {
    throw new ProjectDataTransferError("invalid_bundle", "所選專案不在匯入檔中。");
  }

  const sessions = bundle.tables.sessions.filter((session) => selectedIds.has(String(session.project_id)));
  const sessionIds = new Set(sessions.map((session) => String(session.id)));
  const knowledge = bundle.tables.knowledge.filter((item) => selectedIds.has(String(item.project_id)));
  const candidateRequests = bundle.tables.knowledge_candidate_requests.filter((item) =>
    selectedIds.has(String(item.project_id)),
  );
  const reportRequests = bundle.tables.report_synthesis_requests.filter(
    (item) => item.scope_type === "all" || (item.scope_type === "project" && selectedIds.has(String(item.project_id))),
  );
  const reportRequestIds = new Set(reportRequests.map((item) => String(item.id)));
  const metadataRequests = bundle.tables.metadata_backfill_requests.filter(
    (item) => item.scope_type === "all" || (item.scope_type === "project" && selectedIds.has(String(item.project_id))),
  );

  if (projectId) {
    for (const row of reportRequests) {
      if (row.scope_type === "all") {
        reportRequestIds.delete(String(row.id));
      }
    }
  }
  const filterSessionChildrenByScope = bundle.scope.type === "all" && projectId !== undefined;
  const tables: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects: selectedProjects,
    sessions,
    work_events: filterSessionChildrenByScope
      ? bundle.tables.work_events.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.work_events,
    raw_snapshots: bundle.tables.raw_snapshots.filter((row) => selectedIds.has(String(row.project_id))),
    evidence: bundle.tables.evidence.filter((row) => selectedIds.has(String(row.project_id))),
    void_audit: bundle.tables.void_audit.filter((row) => selectedIds.has(String(row.project_id))),
    session_verification_updates: filterSessionChildrenByScope
      ? bundle.tables.session_verification_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_verification_updates,
    session_links:
      bundle.scope.type === "all" && projectId !== undefined
        ? bundle.tables.session_links.filter(
            (row) => sessionIds.has(String(row.session_id)) && sessionIds.has(String(row.related_session_id)),
          )
        : bundle.tables.session_links.filter((row) => sessionIds.has(String(row.session_id))),
    knowledge,
    session_decisions: bundle.tables.session_decisions.filter((row) => selectedIds.has(String(row.project_id))),
    knowledge_pages: bundle.tables.knowledge_pages.filter((row) => selectedIds.has(String(row.project_id))),
    knowledge_page_versions: bundle.tables.knowledge_page_versions.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    knowledge_audit: bundle.tables.knowledge_audit.filter((row) => selectedIds.has(String(row.project_id))),
    knowledge_feedback: bundle.tables.knowledge_feedback.filter((row) => selectedIds.has(String(row.project_id))),
    session_diagrams: bundle.tables.session_diagrams.filter((row) => selectedIds.has(String(row.project_id))),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: bundle.tables.knowledge_candidates.filter((row) => selectedIds.has(String(row.project_id))),
    report_synthesis_requests: reportRequests.filter((row) => projectId === undefined || row.scope_type === "project"),
    report_summaries:
      projectId === undefined
        ? bundle.tables.report_summaries
        : bundle.tables.report_summaries.filter((row) => reportRequestIds.has(String(row.request_id))),
    metadata_backfill_requests: metadataRequests.filter(
      (row) => projectId === undefined || row.scope_type === "project",
    ),
    session_summary_updates: filterSessionChildrenByScope
      ? bundle.tables.session_summary_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_summary_updates,
    session_work_summary_updates: filterSessionChildrenByScope
      ? bundle.tables.session_work_summary_updates.filter((row) => sessionIds.has(String(row.session_id)))
      : bundle.tables.session_work_summary_updates,
    outstanding_items: bundle.tables.outstanding_items.filter((row) => selectedIds.has(String(row.project_id))),
    outstanding_cleanup_requests: bundle.tables.outstanding_cleanup_requests.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    outstanding_cleanup_submissions: bundle.tables.outstanding_cleanup_submissions.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    outstanding_cleanup_request_items: bundle.tables.outstanding_cleanup_request_items.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    outstanding_cleanup_proposals: bundle.tables.outstanding_cleanup_proposals.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    outstanding_cleanup_proposal_evidence: bundle.tables.outstanding_cleanup_proposal_evidence.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
    outstanding_item_events: bundle.tables.outstanding_item_events.filter((row) =>
      selectedIds.has(String(row.project_id)),
    ),
  };

  for (const table of PROJECT_DATA_TABLES) {
    tables[table] = tables[table].map((row) => ({ ...row }));
  }

  return { ...bundle, scope: { type: "all" }, tables };
}

function applyPathRemaps(
  tables: Record<ProjectDataTable, ProjectDataRow[]>,
  mappings: readonly ProjectPathRemap[],
): ProjectDataImportPreview["remappedPaths"] {
  return mappings.map((mapping) => {
    let projects = 0;
    let snapshots = 0;
    for (const row of tables.projects) {
      const path = String(row.root_path);
      const moved = remapPathPrefix(path, mapping);
      if (moved !== path) {
        row.root_path = moved;
        projects += 1;
      }
    }
    for (const row of tables.raw_snapshots) {
      if (typeof row.source_path !== "string") {
        continue;
      }
      const moved = remapPathPrefix(row.source_path, mapping);
      if (moved !== row.source_path) {
        row.source_path = moved;
        snapshots += 1;
      }
    }
    return { projects, snapshots };
  });
}

function equalProjectRoot(left: string, right: string): boolean {
  return projectRootKey(left) === projectRootKey(right);
}

function projectRootKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const windowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function uniqueIndexKey(fields: readonly string[], row: ProjectDataRow): string | undefined {
  const values: ProjectDataValue[] = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return JSON.stringify([fields, values]);
}

function plannedUniqueKeysForRow(table: ProjectDataTable, row: ProjectDataRow): string[] {
  const keys = (UNIQUE_FIELDS[table] ?? [])
    .map((fields) => uniqueIndexKey(fields, row))
    .filter((key): key is string => key !== undefined);
  if (table === "outstanding_cleanup_requests" && (row.status === "pending" || row.status === "awaiting_review")) {
    const activeProjectKey = uniqueIndexKey(["project_id"], row);
    if (activeProjectKey) keys.push(activeProjectKey);
  }
  return keys;
}

function runReadTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

function equalRows(table: ProjectDataTable, left: ProjectDataRow, right: ProjectDataRow): boolean {
  return projectDataExportTableColumns[table].every(
    (column) => projectDataColumnValue(table, left, column) === projectDataColumnValue(table, right, column),
  );
}

function existingRow(db: DatabaseSync, table: ProjectDataTable, id: string): ProjectDataRow | undefined {
  const columns = projectDataExportTableColumns[table].join(", ");
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id) as unknown as ProjectDataRow | undefined;
}

function existingUniqueRow(db: DatabaseSync, table: ProjectDataTable, row: ProjectDataRow): ProjectDataRow | undefined {
  for (const fields of UNIQUE_FIELDS[table] ?? []) {
    const values: ProjectDataValue[] = [];
    let missingValue = false;
    for (const field of fields) {
      const value = row[field];
      if (value === null || value === undefined) {
        missingValue = true;
        break;
      }
      values.push(value);
    }
    if (missingValue) {
      continue;
    }
    const where = fields.map((field) => `${field} = ?`).join(" AND ");
    const columns = projectDataExportTableColumns[table].join(", ");
    const found = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where}`).get(...values) as
      ProjectDataRow | undefined;
    if (found) {
      return found;
    }
  }
  if (
    table === "outstanding_cleanup_requests" &&
    (row.status === "pending" || row.status === "awaiting_review") &&
    typeof row.project_id === "string"
  ) {
    const columns = projectDataExportTableColumns[table].join(", ");
    const found = db
      .prepare(
        `SELECT ${columns} FROM outstanding_cleanup_requests
         WHERE project_id = ? AND status IN ('pending', 'awaiting_review')`,
      )
      .get(row.project_id) as ProjectDataRow | undefined;
    if (found) return found;
  }
  return undefined;
}

function countPlan(plan: TransferPlan, disposition: PlannedRow["disposition"]): ProjectDataCounts {
  const counts = emptyCounts();
  for (const table of TABLE_ORDER) {
    counts[table] = plan.rows[table].filter((row) => row.disposition === disposition).length;
  }
  return counts;
}

function isAvailable(
  table: ProjectDataTable,
  id: string,
  selectedIds: Set<string>,
  availableIds: Record<ProjectDataTable, Set<string>>,
  conflictIds: Record<ProjectDataTable, Set<string>>,
): boolean {
  if (selectedIds.has(id) && conflictIds[table].has(id)) {
    return false;
  }
  return availableIds[table].has(id);
}

type CleanupRequestReference = { projectId: string };
type CleanupSubmissionReference = { requestId: string; projectId: string };
type CleanupRequestItemReference = {
  requestId: string;
  projectId: string;
  itemId: string;
  sourceSessionId: string;
  examinedSubmissionId: string | null;
};
type CleanupProposalReference = {
  requestId: string;
  projectId: string;
  requestItemId: string;
  submissionId: string;
  targetStatus: string;
  reviewStatus: string;
};

function dependencyIssue(
  table: ProjectDataTable,
  row: ProjectDataRow,
  projectIds: Map<string, string>,
  selectedIds: Record<ProjectDataTable, Set<string>>,
  availableIds: Record<ProjectDataTable, Set<string>>,
  conflictIds: Record<ProjectDataTable, Set<string>>,
  sessionProjectIds: Map<string, string>,
  outstandingItemProjectIds: Map<string, string>,
  outstandingItemSourceSessionIds: Map<string, string>,
  cleanupRequestReferences: Map<string, CleanupRequestReference>,
  cleanupSubmissionReferences: Map<string, CleanupSubmissionReference>,
  cleanupRequestItemReferences: Map<string, CleanupRequestItemReference>,
  cleanupProposalReferences: Map<string, CleanupProposalReference>,
): string | undefined {
  if (table !== "projects" && typeof row.project_id === "string") {
    const mappedProjectId = projectIds.get(row.project_id);
    if (
      !mappedProjectId ||
      !isAvailable("projects", mappedProjectId, selectedIds.projects, availableIds, conflictIds)
    ) {
      return "所屬專案發生衝突或不存在。";
    }
    row.project_id = mappedProjectId;
  }

  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  if (sessionId && !isAvailable("sessions", sessionId, selectedIds.sessions, availableIds, conflictIds)) {
    return "關聯的 Session 發生衝突或不存在。";
  }
  if (table === "session_links") {
    const relatedSessionId = String(row.related_session_id);
    if (sessionId === relatedSessionId) {
      return "Session 不可與自己建立關聯。";
    }
    if (!selectedIds.sessions.has(sessionId ?? "") || !selectedIds.sessions.has(relatedSessionId)) {
      return "Session 關聯的兩端都必須包含在匯入範圍內。";
    }
    if (!isAvailable("sessions", relatedSessionId, selectedIds.sessions, availableIds, conflictIds)) {
      return "關聯的另一端 Session 發生衝突或不存在。";
    }
  }

  if (table === "knowledge") {
    const lastConfirmedSessionId =
      typeof row.last_confirmed_session_id === "string" ? row.last_confirmed_session_id : undefined;
    if (
      lastConfirmedSessionId &&
      !isAvailable("sessions", lastConfirmedSessionId, selectedIds.sessions, availableIds, conflictIds)
    ) {
      return "Knowledge 的最後確認 Session 發生衝突或不存在。";
    }
    const supersedesId = typeof row.supersedes_id === "string" ? row.supersedes_id : undefined;
    if (supersedesId && !selectedIds.knowledge.has(supersedesId)) {
      return "Knowledge 的 supersedes 關聯不在匯入範圍內。";
    }
    if (supersedesId && !isAvailable("knowledge", supersedesId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "Knowledge 的 supersedes 目標發生衝突或不存在。";
    }
  }

  if (table === "session_decisions") {
    const knowledgeId = typeof row.knowledge_id === "string" ? row.knowledge_id : undefined;
    if (knowledgeId && !isAvailable("knowledge", knowledgeId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "決策引用的 Knowledge 發生衝突或不存在。";
    }
  }

  if (table === "outstanding_items") {
    const sourceSessionId = String(row.source_session_id);
    if (
      !isAvailable("sessions", sourceSessionId, selectedIds.sessions, availableIds, conflictIds) ||
      sessionProjectIds.get(sourceSessionId) !== row.project_id
    ) {
      return "待結項必須關聯同一專案中可用的來源 Session。";
    }
  }

  if (table === "outstanding_item_events") {
    const itemId = String(row.item_id);
    if (!isAvailable("outstanding_items", itemId, selectedIds.outstanding_items, availableIds, conflictIds)) {
      return "待結項稽核事件對應的項目發生衝突或不存在。";
    }
    if (outstandingItemProjectIds.get(itemId) !== row.project_id) {
      return "待結項稽核事件必須屬於對應項目的專案。";
    }
    const actorSessionId = typeof row.actor_session_id === "string" ? row.actor_session_id : undefined;
    if (
      actorSessionId &&
      (!isAvailable("sessions", actorSessionId, selectedIds.sessions, availableIds, conflictIds) ||
        sessionProjectIds.get(actorSessionId) !== row.project_id)
    ) {
      return "待結項稽核事件的 actor Session 必須位於同一專案。";
    }

    const hasCleanupRequestId = typeof row.cleanup_request_id === "string";
    const hasCleanupProposalId = typeof row.cleanup_proposal_id === "string";
    const cleanupRequestId = hasCleanupRequestId ? String(row.cleanup_request_id) : undefined;
    const cleanupProposalId = hasCleanupProposalId ? String(row.cleanup_proposal_id) : undefined;
    if (hasCleanupRequestId !== hasCleanupProposalId) {
      return "清理稽核事件必須同時引用請求與提案。";
    }
    if (hasCleanupRequestId && hasCleanupProposalId) {
      const requestId = cleanupRequestId ?? "";
      const proposalId = cleanupProposalId ?? "";
      const request = cleanupRequestReferences.get(requestId);
      const proposal = cleanupProposalReferences.get(proposalId);
      const requestItem = proposal ? cleanupRequestItemReferences.get(proposal.requestItemId) : undefined;
      if (
        !isAvailable(
          "outstanding_cleanup_requests",
          requestId,
          selectedIds.outstanding_cleanup_requests,
          availableIds,
          conflictIds,
        ) ||
        !isAvailable(
          "outstanding_cleanup_proposals",
          proposalId,
          selectedIds.outstanding_cleanup_proposals,
          availableIds,
          conflictIds,
        ) ||
        !request ||
        !proposal ||
        !requestItem
      ) {
        return "清理稽核事件引用的請求或提案發生衝突或不存在。";
      }
      if (
        request.projectId !== row.project_id ||
        proposal.projectId !== row.project_id ||
        proposal.requestId !== requestId ||
        requestItem.projectId !== row.project_id ||
        requestItem.requestId !== requestId ||
        requestItem.itemId !== itemId
      ) {
        return "清理稽核事件的請求、提案、項目必須屬於同一專案與請求。";
      }
      if (row.source !== "web" || proposal.reviewStatus !== "accepted" || proposal.targetStatus !== row.to_status) {
        return "清理稽核事件必須對應已接受且狀態一致的提案。";
      }
    }
  }

  if (table === "outstanding_cleanup_submissions") {
    const requestId = String(row.request_id);
    const request = cleanupRequestReferences.get(requestId);
    if (
      !isAvailable(
        "outstanding_cleanup_requests",
        requestId,
        selectedIds.outstanding_cleanup_requests,
        availableIds,
        conflictIds,
      ) ||
      !request
    ) {
      return "清理提案提交對應的請求發生衝突或不存在。";
    }
    if (request.projectId !== row.project_id) {
      return "清理提案提交與請求必須屬於同一專案。";
    }
  }

  if (table === "outstanding_cleanup_request_items") {
    const requestId = String(row.request_id);
    const request = cleanupRequestReferences.get(requestId);
    const itemId = String(row.item_id);
    const sourceSessionId = String(row.source_session_id);
    if (
      !isAvailable(
        "outstanding_cleanup_requests",
        requestId,
        selectedIds.outstanding_cleanup_requests,
        availableIds,
        conflictIds,
      ) ||
      !request
    ) {
      return "清理快照項目對應的請求發生衝突或不存在。";
    }
    if (request.projectId !== row.project_id) {
      return "清理快照項目與請求必須屬於同一專案。";
    }
    if (
      !isAvailable("outstanding_items", itemId, selectedIds.outstanding_items, availableIds, conflictIds) ||
      outstandingItemProjectIds.get(itemId) !== row.project_id
    ) {
      return "清理快照項目必須引用同一專案中可用的待結項。";
    }
    if (outstandingItemSourceSessionIds.get(itemId) !== sourceSessionId) {
      return "清理快照項目的來源 Session 必須與待結項來源一致。";
    }
    if (
      !isAvailable("sessions", sourceSessionId, selectedIds.sessions, availableIds, conflictIds) ||
      sessionProjectIds.get(sourceSessionId) !== row.project_id
    ) {
      return "清理快照項目的來源 Session 必須位於同一專案。";
    }
    const examinedSubmissionId =
      typeof row.examined_submission_id === "string" ? row.examined_submission_id : undefined;
    if (examinedSubmissionId !== undefined) {
      const submission = cleanupSubmissionReferences.get(examinedSubmissionId);
      if (
        !isAvailable(
          "outstanding_cleanup_submissions",
          examinedSubmissionId,
          selectedIds.outstanding_cleanup_submissions,
          availableIds,
          conflictIds,
        ) ||
        !submission
      ) {
        return "清理快照項目的提交紀錄發生衝突或不存在。";
      }
      if (submission.projectId !== row.project_id || submission.requestId !== requestId) {
        return "清理快照項目的提交紀錄必須屬於同一專案與請求。";
      }
    }
  }

  if (table === "outstanding_cleanup_proposals") {
    const requestId = String(row.request_id);
    const requestItemId = String(row.request_item_id);
    const submissionId = String(row.submission_id);
    const request = cleanupRequestReferences.get(requestId);
    const requestItem = cleanupRequestItemReferences.get(requestItemId);
    const submission = cleanupSubmissionReferences.get(submissionId);
    if (
      !isAvailable(
        "outstanding_cleanup_requests",
        requestId,
        selectedIds.outstanding_cleanup_requests,
        availableIds,
        conflictIds,
      ) ||
      !isAvailable(
        "outstanding_cleanup_request_items",
        requestItemId,
        selectedIds.outstanding_cleanup_request_items,
        availableIds,
        conflictIds,
      ) ||
      !isAvailable(
        "outstanding_cleanup_submissions",
        submissionId,
        selectedIds.outstanding_cleanup_submissions,
        availableIds,
        conflictIds,
      ) ||
      !request ||
      !requestItem ||
      !submission
    ) {
      return "清理提案關聯的請求、快照項目或提交紀錄發生衝突或不存在。";
    }
    if (
      request.projectId !== row.project_id ||
      requestItem.projectId !== row.project_id ||
      submission.projectId !== row.project_id ||
      requestItem.requestId !== requestId ||
      submission.requestId !== requestId
    ) {
      return "清理提案及其關聯資料必須屬於同一專案與請求。";
    }
    if (requestItem.examinedSubmissionId !== submissionId) {
      return "清理提案提交紀錄必須與快照項目檢視的提交一致。";
    }
  }

  if (table === "outstanding_cleanup_proposal_evidence") {
    const proposalId = String(row.proposal_id);
    const sessionId = String(row.session_id);
    const proposal = cleanupProposalReferences.get(proposalId);
    if (
      !isAvailable(
        "outstanding_cleanup_proposals",
        proposalId,
        selectedIds.outstanding_cleanup_proposals,
        availableIds,
        conflictIds,
      ) ||
      !proposal
    ) {
      return "清理提案證據對應的提案發生衝突或不存在。";
    }
    if (
      proposal.projectId !== row.project_id ||
      !isAvailable("sessions", sessionId, selectedIds.sessions, availableIds, conflictIds) ||
      sessionProjectIds.get(sessionId) !== row.project_id
    ) {
      return "清理提案證據 Session 必須位於提案所屬專案。";
    }
  }

  if (table === "knowledge_page_versions") {
    const pageId = String(row.page_id);
    if (!selectedIds.knowledge_pages.has(pageId)) {
      return "知識頁版本對應的頁面不在匯入範圍內。";
    }
    if (!isAvailable("knowledge_pages", pageId, selectedIds.knowledge_pages, availableIds, conflictIds)) {
      return "知識頁版本對應的頁面發生衝突或不存在。";
    }
  }

  if (table === "knowledge_pages") {
    const checkedThroughSessionId =
      typeof row.checked_through_session_id === "string" ? row.checked_through_session_id : undefined;
    if (checkedThroughSessionId) {
      if (
        !isAvailable("sessions", checkedThroughSessionId, selectedIds.sessions, availableIds, conflictIds) ||
        sessionProjectIds.get(checkedThroughSessionId) !== row.project_id
      ) {
        return "知識頁的已檢查游標必須指向同一專案中可用的 Session。";
      }
    }
  }

  if (table === "knowledge_feedback") {
    const knowledgeId = String(row.knowledge_id);
    if (!selectedIds.knowledge.has(knowledgeId)) {
      return "Knowledge 回饋對應的 Knowledge 不在匯入範圍內。";
    }
    if (!isAvailable("knowledge", knowledgeId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "Knowledge 回饋對應的 Knowledge 發生衝突或不存在。";
    }
  }

  if (table === "knowledge_audit" || table === "knowledge_candidates") {
    const knowledgeId = typeof row.knowledge_id === "string" ? row.knowledge_id : undefined;
    if (knowledgeId && !isAvailable("knowledge", knowledgeId, selectedIds.knowledge, availableIds, conflictIds)) {
      return "關聯的 Knowledge 發生衝突或不存在。";
    }
  }

  const requestId = typeof row.request_id === "string" ? row.request_id : undefined;
  const requestTable = table === "report_summaries" ? "report_synthesis_requests" : "knowledge_candidate_requests";
  if (requestId && (table === "report_summaries" || table === "knowledge_candidates")) {
    if (!isAvailable(requestTable, requestId, selectedIds[requestTable], availableIds, conflictIds)) {
      return "關聯的請求發生衝突或不存在。";
    }
  }

  if (table === "void_audit") {
    const targetTable = row.target_type === "session" ? "sessions" : "evidence";
    if (!isAvailable(targetTable, String(row.target_id), selectedIds[targetTable], availableIds, conflictIds)) {
      return "作廢紀錄的目標發生衝突或不存在。";
    }
  }
  return undefined;
}

function orderKnowledgeRows(rows: ProjectDataRow[]): ProjectDataRow[] {
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  const depths = new Map<string, number>();
  const depth = (id: string, visiting = new Set<string>()): number => {
    const known = depths.get(id);
    if (known !== undefined) {
      return known;
    }
    const row = rowsById.get(id);
    if (!row || typeof row.supersedes_id !== "string" || !rowsById.has(row.supersedes_id)) {
      depths.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      return 0;
    }
    const next = new Set(visiting);
    next.add(id);
    const result = depth(row.supersedes_id, next) + 1;
    depths.set(id, result);
    return result;
  };
  return [...rows].sort((left, right) => depth(String(left.id)) - depth(String(right.id)));
}

function makePlan(db: DatabaseSync, input: ProjectDataImportInput): TransferPlan {
  const inputResult = projectDataImportInputSchema.safeParse(input);
  if (!inputResult.success) {
    throw new ProjectDataTransferError(
      "invalid_input",
      `匯入資料不符合格式：${inputResult.error.issues[0]?.message ?? "欄位驗證失敗。"}`,
    );
  }
  const bundleResult = projectDataExportSchema.safeParse(input.bundle);
  if (!bundleResult.success) {
    throw new ProjectDataTransferError(
      "invalid_bundle",
      `匯入檔格式錯誤：${bundleResult.error.issues[0]?.message ?? "欄位驗證失敗。"}`,
    );
  }
  if (input.bundle.schemaVersion !== LATEST_SCHEMA_VERSION) {
    throw new ProjectDataTransferError(
      "unsupported_schema",
      `匯入檔使用 schema 版本 ${input.bundle.schemaVersion}，目前支援版本為 ${LATEST_SCHEMA_VERSION}。`,
    );
  }

  const selectedBundle = bundleForScope(input.bundle, input.projectId);
  const sourceRootPaths = new Map(
    selectedBundle.tables.projects.map((project) => [String(project.id), String(project.root_path)]),
  );
  const remappedPaths = applyPathRemaps(selectedBundle.tables, input.remap ?? []);
  // A repository link from another machine is kept only if it is still a safe https URL.
  for (const row of selectedBundle.tables.projects) {
    if (typeof row.repository_url === "string" && !isSafeRepositoryUrl(row.repository_url)) {
      row.repository_url = null;
    }
  }
  const rows = emptyRows();
  const conflictIds = Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, new Set<string>()])) as Record<
    ProjectDataTable,
    Set<string>
  >;
  const plannedUniqueKeys = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [table, new Set<string>()]),
  ) as Record<ProjectDataTable, Set<string>>;
  const conflicts: ProjectDataImportConflict[] = [];
  let conflictDetailsTruncated = false;
  const addPlan = (
    table: ProjectDataTable,
    row: ProjectDataRow,
    disposition: PlannedRow["disposition"],
    reason?: string,
  ) => {
    rows[table].push({ row, disposition, reason });
    if (disposition === "conflict") {
      conflictIds[table].add(String(row.id));
      if (conflicts.length < CONFLICT_DETAIL_LIMIT) {
        conflicts.push({ table, id: String(row.id).slice(0, MAX_CONFLICT_ID_LENGTH), reason: reason ?? "資料衝突。" });
      } else {
        conflictDetailsTruncated = true;
      }
    } else {
      for (const key of plannedUniqueKeysForRow(table, row)) {
        plannedUniqueKeys[table].add(key);
      }
    }
  };

  const existingIds = Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, getRows(db, table)])) as Record<
    ProjectDataTable,
    Set<string>
  >;
  const existingRowsById = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [
      table,
      new Map(
        rowsByIds(
          db,
          table,
          "id",
          selectedBundle.tables[table].map((row) => String(row.id)),
        ).map((row) => [String(row.id), row]),
      ),
    ]),
  ) as Record<ProjectDataTable, Map<string, ProjectDataRow>>;
  const selectedIds = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [table, new Set(selectedBundle.tables[table].map((row) => String(row.id)))]),
  ) as Record<ProjectDataTable, Set<string>>;
  const projectIds = new Map<string, string>();
  const existingProjects = db.prepare("SELECT id, root_path FROM projects ORDER BY id").all() as Array<{
    id: string;
    root_path: string;
  }>;
  const existingProjectsById = new Map(existingProjects.map((project) => [project.id, project]));
  const existingProjectsByRoot = new Map<string, (typeof existingProjects)[number]>();
  for (const project of existingProjects) {
    const rootKey = projectRootKey(project.root_path);
    if (!existingProjectsByRoot.has(rootKey)) {
      existingProjectsByRoot.set(rootKey, project);
    }
  }
  const plannedProjectsByRoot = new Map<string, { rootPath: string; projectId: string }>();
  const plannedProjectIds = new Set<string>();
  const selectedProjects: ProjectDataImportPreview["selectedProjects"] = [];

  for (const original of selectedBundle.tables.projects) {
    const row = { ...original };
    const sourceId = String(row.id);
    const rootPath = String(row.root_path);
    const sourceRootPath = sourceRootPaths.get(sourceId) ?? rootPath;
    const rootKey = projectRootKey(rootPath);
    const byId = existingProjectsById.get(sourceId);
    const byRoot = existingProjectsByRoot.get(rootKey);
    const plannedByRoot = plannedProjectsByRoot.get(rootKey);

    if (byId && byRoot && byId.id !== byRoot.id) {
      addPlan("projects", row, "conflict", "專案 ID 與根路徑分別對應到不同的既有專案。");
      selectedProjects.push({ id: sourceId, name: String(row.name), sourceRootPath, rootPath, resolution: "conflict" });
      continue;
    }
    if (byId && !equalProjectRoot(byId.root_path, rootPath)) {
      addPlan("projects", row, "conflict", "相同專案 ID 已存在，但根路徑不同；請確認路徑前綴轉換。");
      selectedProjects.push({ id: sourceId, name: String(row.name), sourceRootPath, rootPath, resolution: "conflict" });
      continue;
    }
    const matchedProject = byId ?? byRoot ?? plannedByRoot;
    if (matchedProject) {
      const targetId = "projectId" in matchedProject ? matchedProject.projectId : matchedProject.id;
      projectIds.set(sourceId, targetId);
      existingIds.projects.add(targetId);
      addPlan("projects", row, "skip");
      selectedProjects.push({
        id: sourceId,
        name: String(row.name),
        sourceRootPath,
        rootPath,
        resolution: byId || byRoot ? "existing" : "new",
      });
      continue;
    }
    if (plannedProjectIds.has(sourceId)) {
      addPlan("projects", row, "conflict", "匯入檔中有重複的專案 ID。");
      selectedProjects.push({ id: sourceId, name: String(row.name), sourceRootPath, rootPath, resolution: "conflict" });
      continue;
    }
    projectIds.set(sourceId, sourceId);
    row.status = "paused";
    plannedProjectsByRoot.set(rootKey, { rootPath, projectId: sourceId });
    plannedProjectIds.add(sourceId);
    existingIds.projects.add(sourceId);
    addPlan("projects", row, "add");
    selectedProjects.push({ id: sourceId, name: String(row.name), sourceRootPath, rootPath, resolution: "new" });
  }

  const checkedCursorIds = selectedBundle.tables.knowledge_pages.flatMap((row) =>
    typeof row.checked_through_session_id === "string" ? [row.checked_through_session_id] : [],
  );
  const cleanupReferencedSessionIds = [
    ...selectedBundle.tables.outstanding_cleanup_request_items.map((row) => String(row.source_session_id)),
    ...selectedBundle.tables.outstanding_cleanup_proposal_evidence.map((row) => String(row.session_id)),
    ...selectedBundle.tables.outstanding_item_events.flatMap((row) =>
      typeof row.actor_session_id === "string" ? [row.actor_session_id] : [],
    ),
  ];
  const referencedSessionIds = [...new Set([...checkedCursorIds, ...cleanupReferencedSessionIds])];
  const sessionProjectIds = new Map<string, string>();
  if (referencedSessionIds.length > 0) {
    const existingSessionRows = db
      .prepare("SELECT id, project_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(referencedSessionIds)) as Array<{ id: string; project_id: string }>;
    for (const session of existingSessionRows) sessionProjectIds.set(session.id, session.project_id);
  }
  for (const session of selectedBundle.tables.sessions) {
    const projectId = String(session.project_id);
    sessionProjectIds.set(String(session.id), projectIds.get(projectId) ?? projectId);
  }
  const referencedOutstandingItemIds = [
    ...selectedBundle.tables.outstanding_cleanup_request_items.map((row) => String(row.item_id)),
    ...selectedBundle.tables.outstanding_item_events.map((row) => String(row.item_id)),
  ];
  const outstandingItemProjectIds = new Map<string, string>();
  const outstandingItemSourceSessionIds = new Map<string, string>();
  if (referencedOutstandingItemIds.length > 0) {
    const existingItemRows = db
      .prepare(
        "SELECT id, project_id, source_session_id FROM outstanding_items WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify([...new Set(referencedOutstandingItemIds)])) as Array<{
      id: string;
      project_id: string;
      source_session_id: string;
    }>;
    for (const item of existingItemRows) {
      outstandingItemProjectIds.set(item.id, item.project_id);
      outstandingItemSourceSessionIds.set(item.id, item.source_session_id);
    }
  }
  for (const item of selectedBundle.tables.outstanding_items) {
    const projectId = String(item.project_id);
    outstandingItemProjectIds.set(String(item.id), projectIds.get(projectId) ?? projectId);
    outstandingItemSourceSessionIds.set(String(item.id), String(item.source_session_id));
  }

  const cleanupRequestReferences = new Map<string, CleanupRequestReference>(
    (
      db.prepare("SELECT id, project_id FROM outstanding_cleanup_requests").all() as Array<{
        id: string;
        project_id: string;
      }>
    ).map((row) => [row.id, { projectId: row.project_id }]),
  );
  for (const row of selectedBundle.tables.outstanding_cleanup_requests) {
    const sourceProjectId = String(row.project_id);
    cleanupRequestReferences.set(String(row.id), {
      projectId: projectIds.get(sourceProjectId) ?? sourceProjectId,
    });
  }

  const cleanupSubmissionReferences = new Map<string, CleanupSubmissionReference>(
    (
      db.prepare("SELECT id, request_id, project_id FROM outstanding_cleanup_submissions").all() as Array<{
        id: string;
        request_id: string;
        project_id: string;
      }>
    ).map((row) => [row.id, { requestId: row.request_id, projectId: row.project_id }]),
  );
  for (const row of selectedBundle.tables.outstanding_cleanup_submissions) {
    const sourceProjectId = String(row.project_id);
    cleanupSubmissionReferences.set(String(row.id), {
      requestId: String(row.request_id),
      projectId: projectIds.get(sourceProjectId) ?? sourceProjectId,
    });
  }

  const cleanupRequestItemReferences = new Map<string, CleanupRequestItemReference>(
    (
      db
        .prepare(
          `SELECT id, request_id, project_id, item_id, source_session_id, examined_submission_id
         FROM outstanding_cleanup_request_items`,
        )
        .all() as Array<{
        id: string;
        request_id: string;
        project_id: string;
        item_id: string;
        source_session_id: string;
        examined_submission_id: string | null;
      }>
    ).map((row) => [
      row.id,
      {
        requestId: row.request_id,
        projectId: row.project_id,
        itemId: row.item_id,
        sourceSessionId: row.source_session_id,
        examinedSubmissionId: row.examined_submission_id,
      },
    ]),
  );
  for (const row of selectedBundle.tables.outstanding_cleanup_request_items) {
    const sourceProjectId = String(row.project_id);
    cleanupRequestItemReferences.set(String(row.id), {
      requestId: String(row.request_id),
      projectId: projectIds.get(sourceProjectId) ?? sourceProjectId,
      itemId: String(row.item_id),
      sourceSessionId: String(row.source_session_id),
      examinedSubmissionId: typeof row.examined_submission_id === "string" ? row.examined_submission_id : null,
    });
  }

  const cleanupProposalReferences = new Map<string, CleanupProposalReference>(
    (
      db
        .prepare(
          `SELECT id, request_id, project_id, request_item_id, submission_id, target_status, review_status
         FROM outstanding_cleanup_proposals`,
        )
        .all() as Array<{
        id: string;
        request_id: string;
        project_id: string;
        request_item_id: string;
        submission_id: string;
        target_status: string;
        review_status: string;
      }>
    ).map((row) => [
      row.id,
      {
        requestId: row.request_id,
        projectId: row.project_id,
        requestItemId: row.request_item_id,
        submissionId: row.submission_id,
        targetStatus: row.target_status,
        reviewStatus: row.review_status,
      },
    ]),
  );
  for (const row of selectedBundle.tables.outstanding_cleanup_proposals) {
    const sourceProjectId = String(row.project_id);
    cleanupProposalReferences.set(String(row.id), {
      requestId: String(row.request_id),
      projectId: projectIds.get(sourceProjectId) ?? sourceProjectId,
      requestItemId: String(row.request_item_id),
      submissionId: String(row.submission_id),
      targetStatus: String(row.target_status),
      reviewStatus: String(row.review_status),
    });
  }

  for (const table of TABLE_ORDER) {
    if (table === "projects") {
      continue;
    }
    const sourceRows =
      table === "knowledge" ? orderKnowledgeRows(selectedBundle.tables.knowledge) : selectedBundle.tables[table];
    for (const sourceRow of sourceRows) {
      const row = { ...sourceRow };
      const dependencyError = dependencyIssue(
        table,
        row,
        projectIds,
        selectedIds,
        existingIds,
        conflictIds,
        sessionProjectIds,
        outstandingItemProjectIds,
        outstandingItemSourceSessionIds,
        cleanupRequestReferences,
        cleanupSubmissionReferences,
        cleanupRequestItemReferences,
        cleanupProposalReferences,
      );
      if (dependencyError) {
        addPlan(table, row, "conflict", dependencyError);
        continue;
      }
      const id = String(row.id);
      const current = existingRowsById[table].get(id);
      if (current) {
        if (equalRows(table, current, row)) {
          addPlan(table, row, "skip");
        } else {
          addPlan(table, row, "conflict", "相同 ID 的既有資料內容不同。");
        }
        continue;
      }

      const unique = existingUniqueRow(db, table, row);
      if (unique) {
        addPlan(table, row, "conflict", "唯一識別值已被另一筆資料使用。");
        continue;
      }
      const hasPlannedUnique = plannedUniqueKeysForRow(table, row).some((key) => plannedUniqueKeys[table].has(key));
      if (hasPlannedUnique) {
        addPlan(table, row, "conflict", "匯入檔內有重複的唯一識別值。");
        continue;
      }
      existingIds[table].add(id);
      addPlan(table, row, "add");
    }
  }

  return {
    rows,
    projectIds,
    selectedProjects,
    remappedPaths,
    conflicts,
    conflictDetailsTruncated,
  };
}

function previewFromPlan(plan: TransferPlan): ProjectDataImportPreview {
  return {
    outcome: "project_data_import_preview",
    additions: countPlan(plan, "add"),
    skipped: countPlan(plan, "skip"),
    conflicts: countPlan(plan, "conflict"),
    selectedProjects: plan.selectedProjects,
    remappedPaths: plan.remappedPaths,
    conflictDetails: plan.conflicts,
    conflictDetailsTruncated: plan.conflictDetailsTruncated,
  };
}

function insertRow(db: DatabaseSync, table: ProjectDataTable, row: ProjectDataRow, statement: InsertStatement): void {
  const columns = projectDataExportTableColumns[table];
  const values = columns.map((column) => {
    const value = projectDataColumnValue(table, row, column);
    if (value === undefined) {
      throw new ProjectDataTransferError("invalid_bundle", `匯入的 ${table} 資料缺少 ${column} 欄位。`);
    }
    return value;
  });
  statement.run(...values);
}

/** Exports complete project-scoped data and merges validated portable data without closing SQLite. */
export class ProjectDataTransferService {
  public constructor(private readonly db: DatabaseSync) {}

  public export(scope: ProjectDataExportScope): ProjectDataExport {
    return runReadTransaction(this.db, () => {
      if (scope.type === "project" && !existingRow(this.db, "projects", scope.projectId)) {
        throw new ProjectDataTransferError("project_not_found", "找不到要匯出的專案。");
      }
      const sanitized = redactProjectDataRows(selectExportRows(this.db, scope));
      return {
        format: "work-intelligence-export",
        formatVersion: 1,
        schemaVersion: LATEST_SCHEMA_VERSION,
        exportedAt: nowIso(),
        scope,
        tables: sanitized.rows,
      };
    });
  }

  public preview(input: ProjectDataImportInput): ProjectDataImportPreview {
    const sanitized = sanitizeImportInput(input);
    return runReadTransaction(this.db, () => previewFromPlan(makePlan(this.db, sanitized.input)));
  }

  public import(input: ProjectDataImportInput): ProjectDataImportResult {
    const sanitized = sanitizeImportInput(input);
    return runImmediateTransaction(this.db, () => {
      const plan = makePlan(this.db, sanitized.input);
      const insertStatements = new Map<ProjectDataTable, InsertStatement>();
      for (const table of TABLE_ORDER) {
        for (const entry of plan.rows[table]) {
          if (entry.disposition === "add") {
            let statement = insertStatements.get(table);
            if (!statement) {
              const columns = projectDataExportTableColumns[table];
              const placeholders = columns.map(() => "?").join(", ");
              statement = this.db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
              insertStatements.set(table, statement);
            }
            insertRow(this.db, table, entry.row, statement);
          }
        }
      }
      const preview = previewFromPlan(plan);
      const importedAt = nowIso();
      const sourceDigest = createHash("sha256").update(JSON.stringify(sanitized.input)).digest("hex");
      const remapCounts = JSON.stringify(plan.remappedPaths);
      this.db
        .prepare(
          `INSERT INTO project_data_import_audits
           (id, source_digest, imported_at, additions_json, skipped_json, conflicts_json, remapped_paths_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          sourceDigest,
          importedAt,
          JSON.stringify(preview.additions),
          JSON.stringify(preview.skipped),
          JSON.stringify(preview.conflicts),
          remapCounts,
        );
      return { ...preview, outcome: "project_data_imported", importedAt, redactions: sanitized.redactions };
    });
  }
}
