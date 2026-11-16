import type { DatabaseSync } from "node:sqlite";
import {
  PROJECT_DATA_TABLES,
  type ProjectDataExport,
  type ProjectDataExportScope,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { PROJECT_DATA_EXPORT_COLUMNS } from "./project-data-export-columns.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
import { combineRedactionSummaries, redactJsonText, redactText } from "./secret-redaction.js";

/**
 * Reading and masking the portable project data. Nothing here imports `@work-intelligence/schema` (and so not zod):
 * the backup and export worker loads this module on its own, and the architecture-diagram masking, which does parse
 * with the schema, is handed in by the caller.
 */

/** Masks an architecture diagram's JSON source; supplied by the caller so only callers that need it load zod. */
export type ArchitectureDiagramRedactor = (source: string) => ReturnType<typeof redactText>;

export type ProjectDataTransferErrorCode =
  "invalid_input" | "invalid_bundle" | "unsupported_schema" | "project_not_found" | "project_backup_failed";

export class ProjectDataTransferError extends Error {
  public constructor(
    public readonly code: ProjectDataTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDataTransferError";
  }
}

export const REDACTABLE_FIELDS: Partial<Record<ProjectDataTable, readonly string[]>> = {
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
  report_presentations: ["state_json"],
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

/**
 * Same order as `String.prototype.localeCompare`, without re-resolving the locale on every comparison. The order
 * follows the host's default locale, as it always has; changing it would change the exported bytes.
 */
const EXPORT_ORDER_COLLATOR = new Intl.Collator();

/**
 * Applies the portable redaction rules to one row; also used to compare a local row with a sanitized import. A row
 * with nothing to mask is returned as it is: copying every row of a whole-database export cost more than masking it.
 */
export function redactRow(
  table: ProjectDataTable,
  row: ProjectDataRow,
  redactArchitectureDiagram: ArchitectureDiagramRedactor,
): { row: ProjectDataRow; redactions: ReturnType<typeof combineRedactionSummaries> } {
  let output: Record<string, ProjectDataValue> | undefined;
  const redactions = combineRedactionSummaries();
  for (const field of REDACTABLE_FIELDS[table] ?? []) {
    const value = row[field];
    if (typeof value !== "string") {
      continue;
    }
    const result =
      table === "session_diagrams" && field === "source"
        ? row.kind === "architecture"
          ? redactArchitectureDiagram(value)
          : redactText(value)
        : field.endsWith("_json")
          ? redactJsonText(value)
          : redactText(value);
    if (result.value !== value) {
      output ??= { ...row } as Record<string, ProjectDataValue>;
      output[field] = result.value;
    }
    if (result.redactions.total === 0) continue;
    redactions.total += result.redactions.total;
    for (const [kind, count] of Object.entries(result.redactions.byKind)) {
      const key = kind as keyof typeof redactions.byKind;
      redactions.byKind[key] = (redactions.byKind[key] ?? 0) + (count ?? 0);
    }
  }
  return { row: (output ?? row) as ProjectDataRow, redactions };
}

export function redactProjectDataRows(
  rows: Record<ProjectDataTable, ProjectDataRow[]>,
  redactArchitectureDiagram: ArchitectureDiagramRedactor,
): {
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
        const redacted = redactRow(table, row, redactArchitectureDiagram);
        const output = redacted.row as Record<string, ProjectDataValue>;
        const rowCount = redacted.redactions.total;
        if (rowCount > 0) allRedactions.total += rowCount;
        for (const [kind, count] of rowCount > 0 ? Object.entries(redacted.redactions.byKind) : []) {
          const key = kind as keyof typeof allRedactions.byKind;
          allRedactions.byKind[key] = (allRedactions.byKind[key] ?? 0) + (count ?? 0);
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

  // Unmasked rows are the caller's own objects, so a Session whose count changes gets it on a copy.
  sanitized.sessions = sanitized.sessions.map((session) => {
    const added = sessionCounts.get(String(session.id)) ?? 0;
    if (added === 0 && typeof session.redaction_count === "number") return session;
    return { ...session, redaction_count: Number(session.redaction_count ?? 0) + added };
  });
  return { rows: sanitized, redactions: allRedactions };
}

function sqlRows(
  db: DatabaseSync,
  table: ProjectDataTable,
  where = "",
  values: ProjectDataValue[] = [],
): ProjectDataRow[] {
  const columns = PROJECT_DATA_EXPORT_COLUMNS[table].join(", ");
  const orderBy = table === "outstanding_item_events" ? "created_at, id" : "id";
  const sql = `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY ${orderBy}`;
  return db.prepare(sql).all(...values) as unknown as ProjectDataRow[];
}

function sortExportRows(table: ProjectDataTable, rows: ProjectDataRow[]): ProjectDataRow[] {
  return rows.sort((left, right) => {
    if (table === "outstanding_item_events") {
      const byCreatedAt = EXPORT_ORDER_COLLATOR.compare(String(left.created_at), String(right.created_at));
      if (byCreatedAt !== 0) return byCreatedAt;
    }
    return EXPORT_ORDER_COLLATOR.compare(String(left.id), String(right.id));
  });
}

/**
 * Rows whose `column` is in `ids`, in batches that stay under SQLite's variable limit. With `viaSessions`, `ids` are
 * project ids and the rows are those of the projects' Sessions, selected by a subquery.
 */
export function rowsByIds(
  db: DatabaseSync,
  table: ProjectDataTable,
  column: string,
  ids: readonly string[],
  viaSessions = false,
): ProjectDataRow[] {
  if (ids.length === 0) {
    return [];
  }
  const results: ProjectDataRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const placeholders = batch.map(() => "?").join(", ");
    const where = viaSessions
      ? `${column} IN (SELECT id FROM sessions WHERE project_id IN (${placeholders}))`
      : `${column} IN (${placeholders})`;
    for (const row of sqlRows(db, table, where, [...batch])) results.push(row);
  }
  return sortExportRows(table, results);
}

/** Rows of a Session-owned table: a whole-database export reads the table directly, a project export goes through its Sessions. */
function sessionRows(
  db: DatabaseSync,
  scope: ProjectDataExportScope,
  table: ProjectDataTable,
  projectIds: readonly string[],
): ProjectDataRow[] {
  if (projectIds.length === 0) return [];
  return scope.type === "all"
    ? sortExportRows(table, sqlRows(db, table))
    : rowsByIds(db, table, "session_id", projectIds, true);
}

/** True when a row's source_session_ids_json cites any Session in the bound JSON array (same test as deletion). */
const CITES_SESSIONS_SQL = `EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(source_session_ids_json) THEN source_session_ids_json ELSE '[]' END) AS cited
  WHERE cited.value IN (SELECT value FROM json_each(?))
)`;

function selectExportRows(db: DatabaseSync, scope: ProjectDataExportScope): Record<ProjectDataTable, ProjectDataRow[]> {
  const projects =
    scope.type === "all" ? sqlRows(db, "projects") : sqlRows(db, "projects", "id = ?", [scope.projectId]);
  const projectIds = projects.map((project) => String(project.id));
  const sessions = rowsByIds(db, "sessions", "project_id", projectIds);
  const sessionIdSet = new Set(sessions.map((session) => String(session.id)));
  // Cross-project requests that cite this project's Sessions are removed with the project, so they travel with it.
  // Only a single-project export filters by them, so a whole-database export does not serialize every Session id.
  const sessionIdsJson = scope.type === "all" ? "[]" : JSON.stringify([...sessionIdSet]);
  const reportRequests =
    scope.type === "all"
      ? sqlRows(db, "report_synthesis_requests")
      : sqlRows(
          db,
          "report_synthesis_requests",
          `(scope_type = 'project' AND project_id = ?) OR (scope_type = 'all' AND ${CITES_SESSIONS_SQL})`,
          [scope.projectId, sessionIdsJson],
        );
  const reportRequestIds = reportRequests.map((request) => String(request.id));
  const candidateRequests = rowsByIds(db, "knowledge_candidate_requests", "project_id", projectIds);
  const candidateRequestIds = candidateRequests.map((request) => String(request.id));
  const rows: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects,
    sessions,
    work_events: sessionRows(db, scope, "work_events", projectIds),
    raw_snapshots: rowsByIds(db, "raw_snapshots", "project_id", projectIds),
    evidence: rowsByIds(db, "evidence", "project_id", projectIds),
    void_audit: rowsByIds(db, "void_audit", "project_id", projectIds),
    session_verification_updates: sessionRows(db, scope, "session_verification_updates", projectIds),
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
    knowledge_candidates:
      scope.type === "all"
        ? sqlRows(db, "knowledge_candidates")
        : rowsByIds(db, "knowledge_candidates", "project_id", projectIds),
    report_synthesis_requests: reportRequests,
    report_presentations: [],
    attention_preferences: rowsByIds(db, "attention_preferences", "project_id", projectIds),
    report_summaries:
      scope.type === "all"
        ? sqlRows(db, "report_summaries")
        : rowsByIds(db, "report_summaries", "request_id", reportRequestIds),
    metadata_backfill_requests:
      scope.type === "all"
        ? sqlRows(db, "metadata_backfill_requests")
        : sqlRows(
            db,
            "metadata_backfill_requests",
            `(scope_type = 'project' AND project_id = ?) OR (scope_type = 'all' AND ${CITES_SESSIONS_SQL})`,
            [scope.projectId, sessionIdsJson],
          ),
    session_summary_updates: sessionRows(db, scope, "session_summary_updates", projectIds),
    session_work_summary_updates: sessionRows(db, scope, "session_work_summary_updates", projectIds),
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

  if (candidateRequestIds.length > 0) {
    const candidateIds = new Set(candidateRequestIds);
    rows.knowledge_candidates = rows.knowledge_candidates.filter((candidate) =>
      candidateIds.has(String(candidate.request_id)),
    );
  }
  rows.report_presentations = rowsByIds(
    db,
    "report_presentations",
    "summary_id",
    rows.report_summaries.map((row) => String(row.id)),
  );
  return rows;
}

export function runReadTransaction<T>(db: DatabaseSync, operation: () => T): T {
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

function existingRow(db: DatabaseSync, table: ProjectDataTable, id: string): ProjectDataRow | undefined {
  const columns = PROJECT_DATA_EXPORT_COLUMNS[table].join(", ");
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id) as unknown as ProjectDataRow | undefined;
}

/** Reads every row of the scope inside one read snapshot; masking happens afterwards, off the database. */
export function readProjectDataRows(
  db: DatabaseSync,
  scope: ProjectDataExportScope,
): Record<ProjectDataTable, ProjectDataRow[]> {
  return runReadTransaction(db, () => {
    if (scope.type === "project" && !existingRow(db, "projects", scope.projectId)) {
      throw new ProjectDataTransferError("project_not_found", "找不到要匯出的專案。");
    }
    return selectExportRows(db, scope);
  });
}

/** Wraps the rows of `readProjectDataRows` in the portable export format, masked by the portable redaction rules. */
export function buildProjectDataExport(
  rows: Record<ProjectDataTable, ProjectDataRow[]>,
  scope: ProjectDataExportScope,
  redactArchitectureDiagram: ArchitectureDiagramRedactor,
): ProjectDataExport {
  return {
    format: "work-intelligence-export",
    formatVersion: 1,
    schemaVersion: LATEST_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scope,
    tables: redactProjectDataRows(rows, redactArchitectureDiagram).rows,
  };
}
