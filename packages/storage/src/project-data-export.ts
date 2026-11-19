import type { DatabaseSync } from "node:sqlite";
import {
  PROJECT_DATA_EXPORT_COLUMNS,
  PROJECT_DATA_TABLES,
  type ProjectDataExport,
  type ProjectDataExportScope,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
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
  | "invalid_input"
  | "invalid_bundle"
  | "unsupported_schema"
  | "project_not_found"
  | "project_backup_failed"
  | "export_too_large";

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

/**
 * The redactions each Session's rows carry, so its redaction_count can include them. A Session's rows come later in
 * the bundle than the Session (cleanup proposals reach theirs through their request item), so the counts are read
 * once every later table is masked.
 */
export class SessionRedactionTally {
  public readonly total = combineRedactionSummaries();
  private readonly counts = new Map<string, number>();
  private readonly itemSourceSessionIds = new Map<string, string>();

  /** Records the masking of one row of `table`; `input` is the row before masking, `output` after. */
  public add(
    table: ProjectDataTable,
    input: ProjectDataRow,
    output: ProjectDataRow,
    redactions: ReturnType<typeof combineRedactionSummaries>,
  ): void {
    if (table === "outstanding_cleanup_request_items") {
      this.itemSourceSessionIds.set(String(input.id), String(input.source_session_id));
    }
    const rowCount = redactions.total;
    if (rowCount === 0) return;
    this.total.total += rowCount;
    for (const [kind, count] of Object.entries(redactions.byKind)) {
      const key = kind as keyof typeof this.total.byKind;
      this.total.byKind[key] = (this.total.byKind[key] ?? 0) + (count ?? 0);
    }
    const sessionId =
      table === "sessions"
        ? String(output.id)
        : String(
            output.session_id ??
              output.source_session_id ??
              (table === "outstanding_cleanup_proposals"
                ? this.itemSourceSessionIds.get(String(output.request_item_id)) || undefined
                : "") ??
              "",
          );
    if (sessionId) this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + rowCount);
  }

  /** The Session with its rows' redactions added; unchanged rows stay the caller's own object. */
  public session(session: ProjectDataRow): ProjectDataRow {
    const added = this.counts.get(String(session.id)) ?? 0;
    if (added === 0 && typeof session.redaction_count === "number") return session;
    return { ...session, redaction_count: Number(session.redaction_count ?? 0) + added };
  }
}

export function redactProjectDataRows(
  rows: Record<ProjectDataTable, ProjectDataRow[]>,
  redactArchitectureDiagram: ArchitectureDiagramRedactor,
): {
  rows: Record<ProjectDataTable, ProjectDataRow[]>;
  redactions: ReturnType<typeof combineRedactionSummaries>;
} {
  const tally = new SessionRedactionTally();
  const sanitized = Object.fromEntries(
    PROJECT_DATA_TABLES.map((table) => [
      table,
      rows[table].map((row) => {
        const redacted = redactRow(table, row, redactArchitectureDiagram);
        tally.add(table, row, redacted.row, redacted.redactions);
        return redacted.row;
      }),
    ]),
  ) as unknown as Record<ProjectDataTable, ProjectDataRow[]>;
  sanitized.sessions = sanitized.sessions.map((session) => tally.session(session));
  return { rows: sanitized, redactions: tally.total };
}

function compareExportRows(table: ProjectDataTable, left: ProjectDataRow, right: ProjectDataRow): number {
  if (table === "outstanding_item_events") {
    const byCreatedAt = EXPORT_ORDER_COLLATOR.compare(String(left.created_at), String(right.created_at));
    if (byCreatedAt !== 0) return byCreatedAt;
  }
  return EXPORT_ORDER_COLLATOR.compare(String(left.id), String(right.id));
}

/**
 * Orders rows by the export comparator. SQL already returns them by id (binary order), which is usually the collator
 * order too, so one linear pass skips the sort when every neighbour pair is in order; a stable sort leaves such an
 * array unchanged, so the output is the same either way.
 * @internal test-only
 */
export function sortExportRows(table: ProjectDataTable, rows: ProjectDataRow[]): ProjectDataRow[] {
  let ordered = true;
  for (let index = 1; index < rows.length && ordered; index += 1) {
    ordered = compareExportRows(table, rows[index - 1]!, rows[index]!) <= 0;
  }
  return ordered ? rows : rows.sort((left, right) => compareExportRows(table, left, right));
}

/**
 * Where one table's exported rows come from: a WHERE clause over the table (none for every row), whether the rows are
 * put in collator order (rowsByIds and Session-owned tables) or kept in SQL id order, and a filter that needs values
 * already selected. The in-memory export and the streamed one read the same sources, so they select the same rows.
 */
export interface ExportRowSource {
  table: ProjectDataTable;
  where?: string;
  values?: ProjectDataValue[];
  collate: boolean;
  keep?: (row: ProjectDataRow) => boolean;
  /** The source selects nothing (an id list that is empty), so no query runs. */
  empty?: boolean;
}

const JSON_IDS = "(SELECT value FROM json_each(?))";

/** True when a row's source_session_ids_json cites any Session in the bound JSON array (same test as deletion). */
const CITES_SESSIONS_SQL = `EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(source_session_ids_json) THEN source_session_ids_json ELSE '[]' END) AS cited
  WHERE cited.value IN (SELECT value FROM json_each(?))
)`;

function orderBy(table: ProjectDataTable): string {
  return table === "outstanding_item_events" ? "created_at, id" : "id";
}

function sourceSql(source: ExportRowSource, columns: string): string {
  return `SELECT ${columns} FROM ${source.table}${source.where ? ` WHERE ${source.where}` : ""} ORDER BY ${orderBy(source.table)}`;
}

/** Rows whose `column` is in `ids`; `viaSessions` reads `ids` as project ids and selects their Sessions' rows. */
function byIds(table: ProjectDataTable, column: string, ids: readonly string[], viaSessions = false): ExportRowSource {
  return {
    table,
    where: viaSessions
      ? `${column} IN (SELECT id FROM sessions WHERE project_id IN ${JSON_IDS})`
      : `${column} IN ${JSON_IDS}`,
    values: [JSON.stringify(ids)],
    collate: true,
    empty: ids.length === 0,
  };
}

/** The ids a source selects, in SQL order, without reading the rest of each row. */
function sourceIds(db: DatabaseSync, source: ExportRowSource): string[] {
  if (source.empty) return [];
  return (db.prepare(sourceSql(source, "id")).all(...(source.values ?? [])) as Array<{ id: string }>).map((row) =>
    String(row.id),
  );
}

export function exportRowSources(
  db: DatabaseSync,
  scope: ProjectDataExportScope,
): Record<ProjectDataTable, ExportRowSource> {
  const all = scope.type === "all";
  const projects: ExportRowSource = all
    ? { table: "projects", collate: false }
    : { table: "projects", where: "id = ?", values: [scope.projectId], collate: false };
  const projectIds = sourceIds(db, projects);
  const sessions = byIds("sessions", "project_id", projectIds);
  const sessionIdSet = new Set(sourceIds(db, sessions));
  // Cross-project requests that cite this project's Sessions are removed with the project, so they travel with it.
  // Only a single-project export filters by them, so a whole-database export does not serialize every Session id.
  const sessionIdsJson = all ? "[]" : JSON.stringify([...sessionIdSet]);
  const scopedRequests = (table: ProjectDataTable): ExportRowSource =>
    all
      ? { table, collate: false }
      : {
          table,
          where: `(scope_type = 'project' AND project_id = ?) OR (scope_type = 'all' AND ${CITES_SESSIONS_SQL})`,
          values: [scope.projectId, sessionIdsJson],
          collate: false,
        };
  // Session-owned tables: a whole-database export reads the table directly, a project export goes through Sessions.
  const sessionOwned = (table: ProjectDataTable): ExportRowSource =>
    all ? { table, collate: true, empty: projectIds.length === 0 } : byIds(table, "session_id", projectIds, true);
  const reportRequests = scopedRequests("report_synthesis_requests");
  const candidateRequests = byIds("knowledge_candidate_requests", "project_id", projectIds);
  const candidateRequestIds = new Set(sourceIds(db, candidateRequests));
  const reportSummaries: ExportRowSource = all
    ? { table: "report_summaries", collate: false }
    : byIds("report_summaries", "request_id", sourceIds(db, reportRequests));
  const knowledgeCandidates: ExportRowSource = {
    ...(all
      ? { table: "knowledge_candidates", collate: false }
      : byIds("knowledge_candidates", "project_id", projectIds)),
    ...(candidateRequestIds.size > 0
      ? { keep: (row: ProjectDataRow) => candidateRequestIds.has(String(row.request_id)) }
      : {}),
  };
  const byProject = (table: ProjectDataTable) => byIds(table, "project_id", projectIds);
  return {
    projects,
    sessions,
    work_events: sessionOwned("work_events"),
    raw_snapshots: byProject("raw_snapshots"),
    evidence: byProject("evidence"),
    void_audit: byProject("void_audit"),
    session_verification_updates: sessionOwned("session_verification_updates"),
    session_links: {
      table: "session_links",
      collate: false,
      keep: (link) => sessionIdSet.has(String(link.session_id)) && sessionIdSet.has(String(link.related_session_id)),
    },
    knowledge: byProject("knowledge"),
    session_decisions: byProject("session_decisions"),
    knowledge_pages: byProject("knowledge_pages"),
    knowledge_page_versions: byProject("knowledge_page_versions"),
    session_diagrams: byProject("session_diagrams"),
    knowledge_audit: byProject("knowledge_audit"),
    knowledge_feedback: byProject("knowledge_feedback"),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: knowledgeCandidates,
    report_synthesis_requests: reportRequests,
    report_summaries: reportSummaries,
    report_presentations: byIds("report_presentations", "summary_id", sourceIds(db, reportSummaries)),
    attention_preferences: byProject("attention_preferences"),
    metadata_backfill_requests: scopedRequests("metadata_backfill_requests"),
    session_summary_updates: sessionOwned("session_summary_updates"),
    session_work_summary_updates: sessionOwned("session_work_summary_updates"),
    outstanding_items: byProject("outstanding_items"),
    outstanding_item_events: byProject("outstanding_item_events"),
    outstanding_cleanup_requests: byProject("outstanding_cleanup_requests"),
    outstanding_cleanup_submissions: byProject("outstanding_cleanup_submissions"),
    outstanding_cleanup_request_items: byProject("outstanding_cleanup_request_items"),
    outstanding_cleanup_proposals: byProject("outstanding_cleanup_proposals"),
    outstanding_cleanup_proposal_evidence: byProject("outstanding_cleanup_proposal_evidence"),
  };
}

/**
 * A source's rows in export order, one at a time. SQL returns them in binary id order, which is usually the collator
 * order too; a pass over the order columns alone checks that first, so the rows can be streamed. Only a table whose
 * ids the collator orders differently is read whole and sorted (stably, as sortExportRows always did).
 */
export function* exportRows(db: DatabaseSync, source: ExportRowSource): Generator<ProjectDataRow> {
  if (source.empty) return;
  const values = source.values ?? [];
  const sql = sourceSql(source, PROJECT_DATA_EXPORT_COLUMNS[source.table].join(", "));
  const keep = source.keep;
  if (source.collate && !inCollatorOrder(db, source)) {
    const rows = (db.prepare(sql).all(...values) as unknown as ProjectDataRow[]).filter((row) => !keep || keep(row));
    yield* sortExportRows(source.table, rows);
    return;
  }
  for (const row of db.prepare(sql).iterate(...values) as IterableIterator<ProjectDataRow>) {
    if (!keep || keep(row)) yield row;
  }
}

function inCollatorOrder(db: DatabaseSync, source: ExportRowSource): boolean {
  const columns = source.table === "outstanding_item_events" ? "id, created_at" : "id";
  let previous: ProjectDataRow | undefined;
  for (const row of db
    .prepare(sourceSql(source, columns))
    .iterate(...(source.values ?? [])) as IterableIterator<ProjectDataRow>) {
    if (previous && compareExportRows(source.table, previous, row) > 0) return false;
    previous = row;
  }
  return true;
}

/**
 * Rows whose `column` is in `ids`, in export order. With `viaSessions`, `ids` are project ids and the rows are those
 * of the projects' Sessions. The ids are bound as one JSON array, so there is no batching under SQLite's variable limit.
 */
export function rowsByIds(
  db: DatabaseSync,
  table: ProjectDataTable,
  column: string,
  ids: readonly string[],
  viaSessions = false,
): ProjectDataRow[] {
  return [...exportRows(db, byIds(table, column, ids, viaSessions))];
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

export function existingRow(db: DatabaseSync, table: ProjectDataTable, id: string): ProjectDataRow | undefined {
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
    const sources = exportRowSources(db, scope);
    return Object.fromEntries(
      PROJECT_DATA_TABLES.map((table) => [table, [...exportRows(db, sources[table])]]),
    ) as Record<ProjectDataTable, ProjectDataRow[]>;
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
