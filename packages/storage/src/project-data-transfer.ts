import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  isSafeRepositoryUrl,
  PROJECT_DATA_TABLES,
  type ProjectDataCounts,
  type ProjectDataExport,
  type ProjectDataAutoRemap,
  type ProjectDataImportConflict,
  type ProjectDataImportConflictCategory,
  type ProjectDataImportConflictGroup,
  type ProjectDataImportStrategy,
  type ProjectDataImportInput,
  type ProjectDataImportPreview,
  type ProjectDataImportResult,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
  type ProjectPathRemap,
  type ProjectDataExportScope,
  type RedactionSummary,
} from "@work-intelligence/core";
import {
  projectDataImportInputSchema,
  projectDataImportOptionsSchema,
  projectDataColumnValue,
  projectDataExportTableColumns,
  validationIssueMessage,
} from "@work-intelligence/schema";
import { nowIso } from "@work-intelligence/shared";
import { backupDatabaseBeforeImport, type BackupRetentionOptions } from "./backup.js";
import { redactDiagramSource } from "./diagram-source-redaction.js";
import { remapPathPrefix, storedProjectRoot } from "./project-path-remap.js";
import { databaseUnavailableReason } from "./sqlite-errors.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
import { combineRedactionSummaries, redactJsonText, redactText } from "./secret-redaction.js";

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
  "report_presentations",
  "attention_preferences",
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
  report_presentations: [["summary_id", "revision"]],
  attention_preferences: [["project_id", "kind", "source_id"]],
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
  // (page_id, version) is resolved by renumbering both machines' versions by time instead of conflicting.
  knowledge_page_versions: [["page_id", "idempotency_key"]],
  session_diagrams: [["session_id", "idempotency_key"]],
};

/**
 * The oldest export schema that imports. Every column a migration added after it has an import default in
 * projectDataColumnDefaults and every table it lacked defaults to empty; tests/storage/project-data-import-floor.test.ts
 * checks that against the schema rewound to this version, and real schema-31 and schema-32 exports are fixtures.
 */
export const OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION = 31;
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

/** Columns each machine derives on its own; they never make two copies of a row different and are never overwritten. */
const LOCAL_DERIVED_FIELDS: Partial<Record<ProjectDataTable, readonly string[]>> = {
  sessions: ["redaction_count"],
  // Import always resets hide/snooze, so the local choice is kept.
  attention_preferences: ["state", "snoozed_until"],
  // Recomputed after import from the newest summary of each report scope.
  report_summaries: ["is_current"],
  // An advisory computed at submission: a copy without one (submitted before schema 33) is the same candidate.
  knowledge_candidates: ["overlaps_json"],
};

/** JSON arrays whose element order and duplicate merging differ between machines without changing meaning. */
const UNORDERED_JSON_FIELDS: Partial<Record<ProjectDataTable, readonly string[]>> = {
  sessions: ["changed_files_provenance_json"],
};

/**
 * Time columns that advance when a mutable row changes; the latest of them dates one copy of the row.
 * Tables not listed are append-only history: a differing copy with the same ID stays a conflict.
 */
const VERSION_TIME_FIELDS: Partial<Record<ProjectDataTable, readonly string[]>> = {
  sessions: ["created_at", "completed_at", "updated_at", "voided_at"],
  evidence: ["captured_at", "voided_at"],
  knowledge: ["created_at", "updated_at", "last_confirmed_at"],
  session_decisions: ["reviewed_at"],
  knowledge_pages: ["created_at", "updated_at", "update_requested_at"],
  session_diagrams: ["created_at", "voided_at"],
  knowledge_candidate_requests: ["requested_at", "started_at", "completed_at"],
  knowledge_candidates: ["created_at", "decided_at"],
  report_synthesis_requests: ["requested_at", "started_at", "completed_at"],
  report_summaries: ["created_at"],
  attention_preferences: ["updated_at"],
  metadata_backfill_requests: ["requested_at", "started_at", "completed_at"],
  outstanding_items: ["created_at", "updated_at"],
  outstanding_cleanup_requests: ["requested_at", "completed_at"],
  outstanding_cleanup_proposals: ["created_at", "decided_at"],
};

/**
 * Parent columns of an updatable table that never change after the row is created, besides project_id (which every
 * table with that column is checked on). The row belongs to its project through them, so a same-ID copy that points at
 * another parent is a different row, not a newer version. Columns the product itself rewrites (knowledge.session_id
 * is cleared when a Session is deleted, knowledge_candidates.knowledge_id is set on accept, ...) are deliberately absent.
 */
const IMMUTABLE_PARENT_COLUMNS: Partial<Record<ProjectDataTable, readonly string[]>> = {
  evidence: ["session_id"],
  session_decisions: ["session_id"],
  session_diagrams: ["session_id"],
  knowledge_candidates: ["request_id"],
  report_summaries: ["request_id"],
  outstanding_items: ["source_session_id"],
  outstanding_cleanup_request_items: ["request_id", "item_id", "source_session_id"],
  outstanding_cleanup_proposals: ["request_id", "request_item_id"],
};
/** Temporary shift while renumbering local page versions, so the unique (page, version) index never collides mid-update. */
const PAGE_VERSION_OFFSET = 1_000_000;
const CONFLICT_GROUP_SAMPLE_LIMIT = 5;
const PARENT_OTHER_PROJECT_REASON = "上層資料屬於另一個專案。";
const MISSING_PROJECT_REASON = "所屬專案不在匯入檔中。";
const MISSING_SESSION_REASON = "所屬 Session 不在匯入檔中。";
const MISSING_REQUEST_REASON = "報告所屬的請求不在匯入檔中。";
const MISSING_SUMMARY_REASON = "報告呈現的原始版本不在匯入檔中。";

/** The first validation issue for the error text; unknown keys come from the file, so they are named in bounded form. */
function firstIssueMessage(issues: Parameters<typeof validationIssueMessage>[0][]): string {
  return validationIssueMessage(issues[0]) ?? "欄位驗證失敗。";
}

/**
 * Applies the portable redaction rules to one row; also used to compare a local row with a sanitized import. A row
 * with nothing to mask is returned as it is: copying every row of a whole-database export cost more than masking it.
 */
function redactRow(
  table: ProjectDataTable,
  row: ProjectDataRow,
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
        ? redactDiagramSource(value, String(row.kind))
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
        const redacted = redactRow(table, row);
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

function assertImportableSchemaVersion(schemaVersion: number): void {
  if (schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new ProjectDataTransferError(
      "unsupported_schema",
      `匯入檔使用較新的 schema 版本 ${schemaVersion}，此程式最高支援 ${LATEST_SCHEMA_VERSION}。請先更新 Work Intelligence 再匯入。`,
    );
  }
  if (schemaVersion < OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION) {
    throw new ProjectDataTransferError(
      "unsupported_schema",
      `匯入檔使用 schema 版本 ${schemaVersion}，此程式可匯入 ${OLDEST_IMPORTABLE_EXPORT_SCHEMA_VERSION} 至 ${LATEST_SCHEMA_VERSION} 的匯出檔。`,
    );
  }
}

/**
 * An import input that has passed every validation rule exactly once: the bundle schema with its per-row rules, the
 * import options, the supported schema range, and then the portable redaction. Only `validate` creates one, and the
 * planner accepts nothing else, so an unchecked bundle cannot reach it; the REST worker, the CLI and direct store
 * callers all pass through here. A 50 MiB file used to be parsed four times per preview or import.
 */
export class ValidatedProjectDataImport {
  private constructor(
    /** The redacted input the planner reads. Planning copies its rows, so the same input can be planned again. */
    public readonly input: ProjectDataImportInput,
    public readonly redactions: RedactionSummary,
  ) {}

  public static validate(value: unknown): ValidatedProjectDataImport {
    try {
      return ValidatedProjectDataImport.validateUnchecked(value);
    } catch (error) {
      if (error instanceof ProjectDataTransferError) throw error;
      // A hostile bundle can still trip an unforeseen limit (stack depth, memory); it is a bad input, not a server fault.
      throw new ProjectDataTransferError("invalid_input", "匯入檔無法處理：內容結構異常或過於複雜。");
    }
  }

  private static validateUnchecked(value: unknown): ValidatedProjectDataImport {
    const parsed = projectDataImportInputSchema.safeParse(value);
    if (!parsed.success) {
      throw new ProjectDataTransferError("invalid_input", `匯入檔格式錯誤：${firstIssueMessage(parsed.error.issues)}`);
    }
    assertImportableSchemaVersion(parsed.data.bundle.schemaVersion);
    const sanitized = redactProjectDataRows(parsed.data.bundle.tables);
    return new ValidatedProjectDataImport(
      { ...parsed.data, bundle: { ...parsed.data.bundle, tables: sanitized.rows } },
      sanitized.redactions,
    );
  }

  /** An already validated import as it is; anything else is validated first. */
  public static from(value: ProjectDataImportInput | ValidatedProjectDataImport): ValidatedProjectDataImport {
    return value instanceof ValidatedProjectDataImport ? value : ValidatedProjectDataImport.validate(value);
  }

  /** The same validated bundle with other import choices; only the small options object is validated again. */
  public withOptions(options: unknown): ValidatedProjectDataImport {
    const parsed = projectDataImportOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ProjectDataTransferError(
        "invalid_input",
        `匯入選項格式錯誤：${firstIssueMessage(parsed.error.issues)}`,
      );
    }
    return new ValidatedProjectDataImport({ bundle: this.input.bundle, ...parsed.data }, this.redactions);
  }
}

interface PlannedRow {
  row: ProjectDataRow;
  /** add: new row; update: replaces an older local copy; keep: local copy is newer; skip: identical. */
  disposition: "add" | "skip" | "conflict" | "update" | "keep";
  reason?: string;
  category?: ProjectDataImportConflictCategory;
}

type InsertStatement = ReturnType<DatabaseSync["prepare"]>;

/** A row the file cannot place because the project, Session, request or summary it belongs to is not in the file. */
interface MissingParentRow {
  table: ProjectDataTable;
  row: ProjectDataRow;
  reason: string;
}

interface TransferPlan {
  strategy: ProjectDataImportStrategy;
  rows: Record<ProjectDataTable, PlannedRow[]>;
  projectIds: Map<string, string>;
  selectedProjects: ProjectDataImportPreview["selectedProjects"];
  remappedPaths: ProjectDataImportPreview["remappedPaths"];
  autoRemaps: ProjectDataAutoRemap[];
  conflicts: ProjectDataImportConflict[];
  conflictDetailsTruncated: boolean;
  conflictGroups: ProjectDataImportConflictGroup[];
  /** Local knowledge page versions that move to a new number so imported versions fit in time order. */
  pageVersionRenumbers: Array<{ id: string; version: number }>;
  renumbered: ProjectDataCounts;
}

/** A plan with the data revision it was made at and the snapshot, if any, taken after it. */
interface PlannedImport {
  revision: number;
  plan: TransferPlan;
  /** True once a snapshot was taken, or found unnecessary (an in-memory database has no file to keep). */
  backedUp: boolean;
  backupFileName?: string;
}

/** Content conflicts leave the local row in place, so rows that depend on it can still be imported. */
const NON_BLOCKING_CONFLICTS: ReadonlySet<ProjectDataImportConflictCategory> = new Set(["content", "newer_content"]);
/** Columns that hold machine-specific paths; a row differing only here is a path conflict. */
const PATH_COLUMNS: Partial<Record<ProjectDataTable, readonly string[]>> = { raw_snapshots: ["source_path"] };

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

/** True when a row's source_session_ids_json cites any Session in the bound JSON array (same test as deletion). */
const CITES_SESSIONS_SQL = `EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(source_session_ids_json) THEN source_session_ids_json ELSE '[]' END) AS cited
  WHERE cited.value IN (SELECT value FROM json_each(?))
)`;

function citesAnySession(value: ProjectDataValue | undefined, sessionIds: ReadonlySet<string>): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.some((id) => typeof id === "string" && sessionIds.has(id));
  } catch {
    return false;
  }
}

function selectExportRows(db: DatabaseSync, scope: ProjectDataExportScope): Record<ProjectDataTable, ProjectDataRow[]> {
  const projects =
    scope.type === "all" ? sqlRows(db, "projects") : sqlRows(db, "projects", "id = ?", [scope.projectId]);
  const projectIds = projects.map((project) => String(project.id));
  const sessions = rowsByIds(db, "sessions", "project_id", projectIds);
  const sessionIds = sessions.map((session) => String(session.id));
  const sessionIdSet = new Set(sessionIds);
  // Cross-project requests that cite this project's Sessions are removed with the project, so they travel with it.
  const sessionIdsJson = JSON.stringify(sessionIds);
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
  rows.report_presentations = rowsByIds(
    db,
    "report_presentations",
    "summary_id",
    rows.report_summaries.map((row) => String(row.id)),
  );
  return rows;
}

/**
 * The rows of the selected projects. A row left out because it belongs to a project in the file that the user did not
 * select is out of scope. A row whose project, Session, request or summary is not in the file at all could never be
 * imported, so it is returned in `missingParents` and reported instead of disappearing from the counts.
 */
function bundleForScope(
  bundle: ProjectDataExport,
  projectId?: string,
): { bundle: ProjectDataExport; missingParents: MissingParentRow[] } {
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

  const missingParents: MissingParentRow[] = [];
  const missingRows = new Set<ProjectDataRow>();
  const reportMissing = (table: ProjectDataTable, row: ProjectDataRow, reason: string): void => {
    missingParents.push({ table, row, reason });
    missingRows.add(row);
  };
  const fileProjectIds = new Set(bundle.tables.projects.map((project) => String(project.id)));
  const unselectedProject = (id: ProjectDataValue | undefined) =>
    fileProjectIds.has(String(id)) && !selectedIds.has(String(id));
  const byProject = (table: ProjectDataTable): ProjectDataRow[] =>
    bundle.tables[table].filter((row) => {
      if (selectedIds.has(String(row.project_id))) return true;
      if (!unselectedProject(row.project_id)) reportMissing(table, row, MISSING_PROJECT_REASON);
      return false;
    });

  const sessions = byProject("sessions");
  const sessionIds = new Set(sessions.map((session) => String(session.id)));
  const fileSessionProjects = new Map(
    bundle.tables.sessions.map((session) => [String(session.id), session.project_id] as const),
  );
  /** A Session in the file whose project is in the file too but not selected; it and its rows are out of scope. */
  const unselectedSession = (id: ProjectDataValue | undefined) =>
    fileSessionProjects.has(String(id)) && unselectedProject(fileSessionProjects.get(String(id)));
  const bySession = (table: ProjectDataTable, rows: ProjectDataRow[]): ProjectDataRow[] =>
    rows.filter((row) => {
      if (sessionIds.has(String(row.session_id))) return true;
      if (!unselectedSession(row.session_id)) reportMissing(table, row, MISSING_SESSION_REASON);
      return false;
    });
  // With one project selected, a cross-project request comes along only if it cites that project's Sessions.
  const byRequestScope = (table: "report_synthesis_requests" | "metadata_backfill_requests"): ProjectDataRow[] =>
    bundle.tables[table].filter((item) => {
      if (item.scope_type === "all") {
        return projectId === undefined || citesAnySession(item.source_session_ids_json, sessionIds);
      }
      if (selectedIds.has(String(item.project_id))) return true;
      if (!unselectedProject(item.project_id)) {
        reportMissing(table, item, MISSING_PROJECT_REASON);
      }
      return false;
    });

  const knowledge = byProject("knowledge");
  const candidateRequests = byProject("knowledge_candidate_requests");
  const reportRequests = byRequestScope("report_synthesis_requests");
  const reportRequestIds = new Set(reportRequests.map((item) => String(item.id)));
  const fileReportRequestIds = new Set(
    bundle.tables.report_synthesis_requests.filter((item) => !missingRows.has(item)).map((item) => String(item.id)),
  );
  const metadataRequests = byRequestScope("metadata_backfill_requests");
  const filterSessionChildrenByScope = bundle.scope.type === "all" && projectId !== undefined;
  const sessionChildren = (table: ProjectDataTable): ProjectDataRow[] =>
    filterSessionChildrenByScope ? bySession(table, bundle.tables[table]) : bundle.tables[table];
  const reportSummaries =
    projectId === undefined
      ? bundle.tables.report_summaries
      : bundle.tables.report_summaries.filter((row) => {
          if (reportRequestIds.has(String(row.request_id))) return true;
          if (!fileReportRequestIds.has(String(row.request_id))) {
            reportMissing("report_summaries", row, MISSING_REQUEST_REASON);
          }
          return false;
        });
  const scopedSummaryIds = new Set(reportSummaries.map((summary) => String(summary.id)));
  const fileSummaryIds = new Set(
    bundle.tables.report_summaries.filter((summary) => !missingRows.has(summary)).map((summary) => String(summary.id)),
  );
  const sessionLinks = bundle.tables.session_links.filter((row) => {
    const linked =
      sessionIds.has(String(row.session_id)) &&
      (!filterSessionChildrenByScope || sessionIds.has(String(row.related_session_id)));
    if (linked) return true;
    const endpoints = filterSessionChildrenByScope ? [row.session_id, row.related_session_id] : [row.session_id];
    if (endpoints.some((id) => !sessionIds.has(String(id)) && !unselectedSession(id))) {
      reportMissing("session_links", row, MISSING_SESSION_REASON);
    }
    return false;
  });
  const tables: Record<ProjectDataTable, ProjectDataRow[]> = {
    projects: selectedProjects,
    sessions,
    work_events: sessionChildren("work_events"),
    raw_snapshots: byProject("raw_snapshots"),
    evidence: byProject("evidence"),
    void_audit: byProject("void_audit"),
    session_verification_updates: sessionChildren("session_verification_updates"),
    session_links: sessionLinks,
    knowledge,
    session_decisions: byProject("session_decisions"),
    knowledge_pages: byProject("knowledge_pages"),
    knowledge_page_versions: byProject("knowledge_page_versions"),
    knowledge_audit: byProject("knowledge_audit"),
    knowledge_feedback: byProject("knowledge_feedback"),
    session_diagrams: byProject("session_diagrams"),
    knowledge_candidate_requests: candidateRequests,
    knowledge_candidates: byProject("knowledge_candidates"),
    report_synthesis_requests: reportRequests,
    // Portable source identities/revisions cannot prove that a hidden issue is still the same problem.
    attention_preferences: byProject("attention_preferences").map((row) => ({
      ...row,
      state: "visible",
      snoozed_until: null,
    })),
    report_presentations: bundle.tables.report_presentations.filter((row) => {
      if (scopedSummaryIds.has(String(row.summary_id))) return true;
      if (!fileSummaryIds.has(String(row.summary_id))) {
        reportMissing("report_presentations", row, MISSING_SUMMARY_REASON);
      }
      return false;
    }),
    report_summaries: reportSummaries,
    metadata_backfill_requests: metadataRequests,
    session_summary_updates: sessionChildren("session_summary_updates"),
    session_work_summary_updates: sessionChildren("session_work_summary_updates"),
    outstanding_items: byProject("outstanding_items"),
    outstanding_cleanup_requests: byProject("outstanding_cleanup_requests"),
    outstanding_cleanup_submissions: byProject("outstanding_cleanup_submissions"),
    outstanding_cleanup_request_items: byProject("outstanding_cleanup_request_items"),
    outstanding_cleanup_proposals: byProject("outstanding_cleanup_proposals"),
    outstanding_cleanup_proposal_evidence: byProject("outstanding_cleanup_proposal_evidence"),
    outstanding_item_events: byProject("outstanding_item_events"),
  };

  for (const table of PROJECT_DATA_TABLES) {
    tables[table] = tables[table].map((row) => ({ ...row }));
  }

  return { bundle: { ...bundle, scope: { type: "all" }, tables }, missingParents };
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

/** Sorts and de-duplicates a JSON array (and string arrays inside its objects) so merge order does not matter. */
function normalizeUnorderedJson(value: ProjectDataValue | undefined): ProjectDataValue | undefined {
  if (typeof value !== "string") {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!Array.isArray(parsed)) {
    return value;
  }
  const entries = parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return JSON.stringify(entry);
    }
    const record = entry as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(record)
        .sort()
        .map((key) => {
          const field = record[key];
          return [key, Array.isArray(field) ? [...new Set(field.map((item) => JSON.stringify(item)))].sort() : field];
        }),
    );
  });
  return JSON.stringify([...new Set(entries)].sort());
}

function comparableValue(table: ProjectDataTable, row: ProjectDataRow, column: string): ProjectDataValue | undefined {
  const value = projectDataColumnValue(table, row, column);
  return UNORDERED_JSON_FIELDS[table]?.includes(column) ? normalizeUnorderedJson(value) : value;
}

function sameComparableColumns(table: ProjectDataTable, left: ProjectDataRow, right: ProjectDataRow): boolean {
  const derived = LOCAL_DERIVED_FIELDS[table];
  const unordered = UNORDERED_JSON_FIELDS[table];
  const paths = PATH_COLUMNS[table];
  for (const column of projectDataExportTableColumns[table]) {
    const leftValue = projectDataColumnValue(table, left, column);
    const rightValue = projectDataColumnValue(table, right, column);
    // Equal raw values are the common case; only differing JSON arrays are parsed and normalized.
    if (leftValue === rightValue || derived?.includes(column)) continue;
    if (unordered?.includes(column) && normalizeUnorderedJson(leftValue) === normalizeUnorderedJson(rightValue)) {
      continue;
    }
    // Windows paths are case-insensitive: a stored root is lowercase while a handoff path keeps its case.
    if (
      paths?.includes(column) &&
      typeof leftValue === "string" &&
      typeof rightValue === "string" &&
      projectRootKey(leftValue) === projectRootKey(rightValue)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Compares a local row with an already sanitized imported row, ignoring columns each machine derives itself.
 * The local row is redacted with the same rules first, so text masked only by the newer rules is not a difference.
 */
function equalRows(table: ProjectDataTable, local: ProjectDataRow, imported: ProjectDataRow): boolean {
  if (sameComparableColumns(table, local, imported)) {
    return true;
  }
  return REDACTABLE_FIELDS[table] !== undefined && sameComparableColumns(table, redactRow(table, local).row, imported);
}

/** When this copy of a mutable row last changed (epoch ms, -Infinity if never), or undefined for append-only history. */
function versionRank(table: ProjectDataTable, row: ProjectDataRow): number | undefined {
  if (table === "outstanding_cleanup_request_items") {
    // A snapshot item only moves forward by recording the submission that examined it.
    return typeof row.examined_submission_id === "string" ? 1 : 0;
  }
  const fields = VERSION_TIME_FIELDS[table];
  if (!fields) {
    return undefined;
  }
  let latest = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== "string") {
      continue;
    }
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > latest) {
      latest = time;
    }
  }
  // A mutable row with none of its time columns set has never changed: any dated copy is newer.
  return latest;
}

function existingRow(db: DatabaseSync, table: ProjectDataTable, id: string): ProjectDataRow | undefined {
  const columns = projectDataExportTableColumns[table].join(", ");
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id) as unknown as ProjectDataRow | undefined;
}

const statementCache = new WeakMap<DatabaseSync, Map<string, InsertStatement>>();

/** Unique-key lookups run once per imported row; preparing each SQL text once per connection avoids re-parsing it. */
function cachedStatement(db: DatabaseSync, sql: string): InsertStatement {
  let statements = statementCache.get(db);
  if (!statements) {
    statements = new Map();
    statementCache.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

function existingUniqueRow(
  db: DatabaseSync,
  table: ProjectDataTable,
  row: ProjectDataRow,
  exceptId?: string,
): ProjectDataRow | undefined {
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
    const found = cachedStatement(db, `SELECT ${columns} FROM ${table} WHERE ${where}`).get(...values) as
      ProjectDataRow | undefined;
    if (found && String(found.id) !== exceptId) {
      return found;
    }
  }
  if (
    table === "outstanding_cleanup_requests" &&
    (row.status === "pending" || row.status === "awaiting_review") &&
    typeof row.project_id === "string"
  ) {
    const columns = projectDataExportTableColumns[table].join(", ");
    const found = cachedStatement(
      db,
      `SELECT ${columns} FROM outstanding_cleanup_requests
         WHERE project_id = ? AND status IN ('pending', 'awaiting_review')`,
    ).get(row.project_id) as ProjectDataRow | undefined;
    if (found && String(found.id) !== exceptId) return found;
  }
  return undefined;
}

/** Counts every disposition per table in one pass over the plan. */
function countPlan(plan: TransferPlan): Record<PlannedRow["disposition"], ProjectDataCounts> {
  const counts = {
    add: emptyCounts(),
    skip: emptyCounts(),
    conflict: emptyCounts(),
    update: emptyCounts(),
    keep: emptyCounts(),
  };
  for (const table of TABLE_ORDER) {
    for (const entry of plan.rows[table]) {
      counts[entry.disposition][table] += 1;
    }
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

type OwnedParentTable =
  | "sessions"
  | "evidence"
  | "knowledge"
  | "knowledge_pages"
  | "knowledge_candidate_requests"
  | "report_synthesis_requests"
  | "report_summaries";

/** project_id of each parent row a child cites; null is a cross-project parent (report requests of scope "all"). */
type ParentOwnerMap = Record<OwnedParentTable, Map<string, string | null>>;
type ParentOwners = {
  /** The project that owns each cited parent once the import is applied: the stored row wins over the file's. */
  effective: ParentOwnerMap;
  /** The project each parent row in the file maps to, the project its children in the file are meant for. */
  inFile: ParentOwnerMap;
};

/**
 * Every column through which a row cites a parent that belongs to a project. A child must sit in the same project as
 * each parent it cites, otherwise importing it would attach one project's history to another project's row.
 *
 * `crossProject` marks the one column the product lets point into another project: session_links.related_session_id
 * (SessionRecordService.linkProblem only requires the related Session to exist and be tracked, and work_link_sessions
 * and finalize relatedSessionIds both go through it). Such a column keeps the existence and availability checks of
 * dependencyIssue but is not an ownership claim: the link belongs to the project of session_id, so a file the product
 * exported re-imports completely. Every other column is written by the product only with a same-project parent:
 * knowledge.session_id, session_decisions.knowledge_id, knowledge_feedback.knowledge_id and
 * knowledge.supersedes_id are looked up with the project's id (KnowledgeService.record / SessionDecisionService.review),
 * knowledge.last_confirmed_session_id and knowledge_feedback.session_id come from the Session being finalized for
 * knowledge found in its own project (KnowledgeService.applyKnowledgeFeedback), candidates cite their request's own
 * project Sessions (KnowledgeCandidateService.submit), and void_audit targets the voided Session or its evidence.
 */
const PARENT_REFERENCES: ReadonlyArray<{
  table: ProjectDataTable;
  column: string;
  parent: OwnedParentTable;
  crossProject?: true;
}> = [
  ...(
    [
      "work_events",
      "raw_snapshots",
      "evidence",
      "void_audit",
      "session_verification_updates",
      "session_links",
      "knowledge",
      "session_decisions",
      "session_diagrams",
      "knowledge_feedback",
      "knowledge_candidates",
      "session_summary_updates",
      "session_work_summary_updates",
    ] as const
  ).map((table) => ({ table, column: "session_id", parent: "sessions" as const })),
  { table: "session_links", column: "related_session_id", parent: "sessions", crossProject: true },
  { table: "knowledge", column: "last_confirmed_session_id", parent: "sessions" },
  { table: "knowledge", column: "supersedes_id", parent: "knowledge" },
  { table: "session_decisions", column: "knowledge_id", parent: "knowledge" },
  { table: "knowledge_audit", column: "knowledge_id", parent: "knowledge" },
  { table: "knowledge_feedback", column: "knowledge_id", parent: "knowledge" },
  { table: "knowledge_candidates", column: "knowledge_id", parent: "knowledge" },
  { table: "knowledge_page_versions", column: "page_id", parent: "knowledge_pages" },
  { table: "knowledge_candidates", column: "request_id", parent: "knowledge_candidate_requests" },
  { table: "report_summaries", column: "request_id", parent: "report_synthesis_requests" },
  { table: "report_presentations", column: "summary_id", parent: "report_summaries" },
];

/** Tables with no project_id of their own: their project is the one of the first parent they cite. */
const PROJECTLESS_TABLES: readonly ProjectDataTable[] = [
  "work_events",
  "session_verification_updates",
  "session_links",
  "session_summary_updates",
  "session_work_summary_updates",
  "report_presentations",
];

/**
 * Reads the owning project of every parent the bundle cites. A row stored here decides (an import never moves it);
 * a parent that exists only in the file is owned by the project its row maps to. One query per parent table.
 */
function collectParentOwners(
  db: DatabaseSync,
  tables: Record<ProjectDataTable, ProjectDataRow[]>,
  projectIds: ReadonlyMap<string, string>,
): ParentOwners {
  const emptyOwners = (): ParentOwnerMap => ({
    sessions: new Map(),
    evidence: new Map(),
    knowledge: new Map(),
    knowledge_pages: new Map(),
    knowledge_candidate_requests: new Map(),
    report_synthesis_requests: new Map(),
    report_summaries: new Map(),
  });
  const owners: ParentOwners = { effective: emptyOwners(), inFile: emptyOwners() };
  for (const parent of Object.keys(owners.effective) as OwnedParentTable[]) {
    const cited = new Set<string>();
    for (const reference of PARENT_REFERENCES) {
      if (reference.parent !== parent || reference.crossProject) continue;
      for (const row of tables[reference.table]) {
        const value = row[reference.column];
        if (typeof value === "string") cited.add(value);
      }
    }
    if (parent === "evidence") {
      for (const row of tables.void_audit) {
        if (row.target_type !== "session" && typeof row.target_id === "string") cited.add(row.target_id);
      }
    }
    if (parent === "sessions") {
      for (const row of tables.void_audit) {
        if (row.target_type === "session" && typeof row.target_id === "string") cited.add(row.target_id);
      }
    }
    for (const row of tables[parent]) {
      const projectId = typeof row.project_id === "string" ? row.project_id : null;
      owners.inFile[parent].set(String(row.id), projectId === null ? null : (projectIds.get(projectId) ?? projectId));
    }
    if (cited.size === 0) continue;
    for (const local of db
      .prepare(`SELECT id, project_id FROM ${parent} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...cited])) as Array<{ id: string; project_id: string | null }>) {
      owners.effective[parent].set(local.id, local.project_id);
    }
    for (const [id, projectId] of owners.inFile[parent]) {
      if (!owners.effective[parent].has(id)) owners.effective[parent].set(id, projectId);
    }
  }
  return owners;
}

/** Whether a row cites a parent owned by another project than its own. */
function parentOwnerIssue(table: ProjectDataTable, row: ProjectDataRow, owners: ParentOwners): string | undefined {
  // A table without project_id belongs to the project of the parent row it cites in the file; a parent that is only
  // stored here proves nothing about which project the file meant.
  const projectless = PROJECTLESS_TABLES.includes(table);
  let expected: string | null | undefined = projectless
    ? undefined
    : typeof row.project_id === "string"
      ? row.project_id
      : null;
  const check = (parent: OwnedParentTable, value: ProjectDataValue | undefined): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (expected === undefined) {
      const declared = owners.inFile[parent].get(value);
      if (declared === undefined) return PARENT_OTHER_PROJECT_REASON;
      expected = declared;
    }
    const actual = owners.effective[parent].get(value);
    if (actual === undefined) return undefined; // missing parents are reported by the availability checks
    return actual === expected ? undefined : PARENT_OTHER_PROJECT_REASON;
  };
  for (const reference of PARENT_REFERENCES) {
    if (reference.table !== table || reference.crossProject) continue;
    const issue = check(reference.parent, row[reference.column]);
    if (issue) return issue;
  }
  if (table === "void_audit") {
    return check(row.target_type === "session" ? "sessions" : "evidence", row.target_id);
  }
  return undefined;
}

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
  parentOwners: ParentOwners,
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

  const parentOwnerProblem = parentOwnerIssue(table, row, parentOwners);
  if (parentOwnerProblem) {
    return parentOwnerProblem;
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

  if (table === "report_presentations") {
    const summaryId = String(row.summary_id);
    if (
      !selectedIds.report_summaries.has(summaryId) ||
      !isAvailable("report_summaries", summaryId, selectedIds.report_summaries, availableIds, conflictIds)
    )
      return "報告呈現的原始版本發生衝突或不在匯入範圍。";
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

type AddPlan = (
  table: ProjectDataTable,
  row: ProjectDataRow,
  disposition: PlannedRow["disposition"],
  reason?: string,
  category?: ProjectDataImportConflictCategory,
) => void;

/**
 * Whether a same-ID imported row sits under a different project or parent than the local one. The imported project_id
 * was already mapped to the local project by dependencyIssue, so the comparison is between local IDs. An update must
 * never move a row, so such a row is a conflict whatever its timestamps say.
 */
function belongsToAnotherOwner(table: ProjectDataTable, current: ProjectDataRow, row: ProjectDataRow): boolean {
  const columns = ["project_id", ...(IMMUTABLE_PARENT_COLUMNS[table] ?? [])];
  return columns.some(
    (column) =>
      (projectDataExportTableColumns[table] as readonly string[]).includes(column) &&
      (projectDataColumnValue(table, current, column) ?? null) !== (projectDataColumnValue(table, row, column) ?? null),
  );
}

/** Decides how an imported row with an ID that already exists locally is handled. */
function planExistingRow(
  db: DatabaseSync,
  table: ProjectDataTable,
  current: ProjectDataRow,
  row: ProjectDataRow,
  strategy: ProjectDataImportStrategy,
  addPlan: AddPlan,
): void {
  if (equalRows(table, current, row)) {
    addPlan(table, row, "skip");
    return;
  }
  const pathColumns = PATH_COLUMNS[table] ?? [];
  if (
    pathColumns.length > 0 &&
    projectDataExportTableColumns[table].every(
      (column) =>
        (pathColumns as readonly string[]).includes(column) ||
        comparableValue(table, current, column) === comparableValue(table, row, column),
    )
  ) {
    addPlan(table, row, "conflict", "只有路徑不同；請確認路徑前綴轉換。", "path");
    return;
  }
  const localRank = versionRank(table, current);
  const importedRank = versionRank(table, row);
  if (localRank !== undefined && importedRank !== undefined && localRank !== importedRank) {
    if (importedRank < localRank) {
      addPlan(table, row, "keep");
      return;
    }
    if (strategy !== "newer-wins") {
      addPlan(table, row, "conflict", "匯入資料較新；選擇「較新者優先」即可更新本機資料。", "newer_content");
      return;
    }
    if (belongsToAnotherOwner(table, current, row)) {
      addPlan(table, row, "conflict", "相同 ID 的既有資料屬於另一個專案或上層資料，不會被覆寫。", "dependency");
      return;
    }
    if (existingUniqueRow(db, table, row, String(row.id))) {
      addPlan(table, row, "conflict", "唯一識別值已被另一筆資料使用。", "unique");
      return;
    }
    for (const field of LOCAL_DERIVED_FIELDS[table] ?? []) {
      row[field] = projectDataColumnValue(table, current, field) ?? null;
    }
    addPlan(table, row, "update");
    return;
  }
  addPlan(table, row, "conflict", "相同 ID 的既有資料內容不同。", "content");
}

function versionTime(value: ProjectDataValue | undefined): number {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Two machines can each save "version N" of the same page. When the numbers collide, every version of the page
 * (local and imported) is renumbered 1..n by creation time so both are kept. One query, then O(n log n) per page.
 */
function planPageVersionNumbers(
  db: DatabaseSync,
  plannedVersions: PlannedRow[],
): { localRenumbers: Array<{ id: string; version: number }>; count: number } {
  const addedByPage = new Map<string, ProjectDataRow[]>();
  for (const entry of plannedVersions) {
    if (entry.disposition !== "add") continue;
    const pageId = String(entry.row.page_id);
    const list = addedByPage.get(pageId);
    if (list) list.push(entry.row);
    else addedByPage.set(pageId, [entry.row]);
  }
  const localRenumbers: Array<{ id: string; version: number }> = [];
  if (addedByPage.size === 0) {
    return { localRenumbers, count: 0 };
  }
  const localByPage = new Map<string, Array<{ id: string; version: number; created_at: string }>>();
  const localRows = db
    .prepare(
      `SELECT id, page_id, version, created_at FROM knowledge_page_versions
       WHERE page_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...addedByPage.keys()])) as Array<{
    id: string;
    page_id: string;
    version: number;
    created_at: string;
  }>;
  for (const local of localRows) {
    const list = localByPage.get(local.page_id);
    if (list) list.push(local);
    else localByPage.set(local.page_id, [local]);
  }
  let count = 0;
  for (const [pageId, added] of addedByPage) {
    const locals = localByPage.get(pageId) ?? [];
    const versions: Array<{ id: string; version: number; createdAt: string; row?: ProjectDataRow }> = [
      ...locals.map((local) => ({ id: local.id, version: local.version, createdAt: local.created_at })),
      ...added.map((row) => ({
        id: String(row.id),
        version: Number(row.version),
        createdAt: String(row.created_at),
        row,
      })),
    ];
    const seen = new Set<number>();
    const collides = versions.some((version) => seen.size === seen.add(version.version).size);
    if (!collides) continue;
    versions.sort(
      (left, right) => versionTime(left.createdAt) - versionTime(right.createdAt) || left.id.localeCompare(right.id),
    );
    versions.forEach((version, index) => {
      const next = index + 1;
      if (version.version === next) return;
      count += 1;
      if (version.row) version.row.version = next;
      else localRenumbers.push({ id: version.id, version: next });
    });
  }
  return { localRenumbers, count };
}

function makePlan(db: DatabaseSync, validated: ValidatedProjectDataImport): TransferPlan {
  const { input } = validated;
  const strategy: ProjectDataImportStrategy = input.strategy ?? "merge";
  const { bundle: selectedBundle, missingParents } = bundleForScope(input.bundle, input.projectId);
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
  const conflictGroups = new Map<string, ProjectDataImportConflictGroup>();
  let conflictDetailsTruncated = false;
  const addPlan = (
    table: ProjectDataTable,
    row: ProjectDataRow,
    disposition: PlannedRow["disposition"],
    reason?: string,
    category: ProjectDataImportConflictCategory = "dependency",
  ) => {
    rows[table].push(disposition === "conflict" ? { row, disposition, reason, category } : { row, disposition });
    if (disposition === "conflict") {
      const id = String(row.id).slice(0, MAX_CONFLICT_ID_LENGTH);
      const message = reason ?? "資料衝突。";
      // A page whose content conflicts keeps blocking its versions, so history never runs ahead of the page.
      if (!NON_BLOCKING_CONFLICTS.has(category) || table === "knowledge_pages") {
        conflictIds[table].add(String(row.id));
      }
      if (conflicts.length < CONFLICT_DETAIL_LIMIT) {
        conflicts.push({ table, id, reason: message, category });
      } else {
        conflictDetailsTruncated = true;
      }
      const groupKey = JSON.stringify([table, category, message]);
      const group = conflictGroups.get(groupKey);
      if (group) {
        group.count += 1;
        if (group.sampleIds.length < CONFLICT_GROUP_SAMPLE_LIMIT) group.sampleIds.push(id);
      } else {
        conflictGroups.set(groupKey, { category, table, reason: message, count: 1, sampleIds: [id] });
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
  const autoRemaps: ProjectDataAutoRemap[] = [];

  for (const original of selectedBundle.tables.projects) {
    const row = { ...original };
    const sourceId = String(row.id);
    const rootPath = String(row.root_path);
    const sourceRootPath = sourceRootPaths.get(sourceId) ?? rootPath;
    const rootKey = projectRootKey(storedProjectRoot(rootPath));
    const byId = existingProjectsById.get(sourceId);
    const byRoot = existingProjectsByRoot.get(rootKey);
    const plannedByRoot = plannedProjectsByRoot.get(rootKey);

    if (byId) {
      // The same project ID is the same project: its data follows the root this machine already uses.
      let effectiveRoot = rootPath;
      if (!equalProjectRoot(byId.root_path, rootPath)) {
        const mapping = { from: rootPath, to: byId.root_path };
        let snapshots = 0;
        for (const snapshot of selectedBundle.tables.raw_snapshots) {
          if (snapshot.project_id !== sourceId || typeof snapshot.source_path !== "string") {
            continue;
          }
          const moved = remapPathPrefix(snapshot.source_path, mapping);
          if (moved !== snapshot.source_path) {
            snapshot.source_path = moved;
            snapshots += 1;
          }
        }
        effectiveRoot = byId.root_path;
        row.root_path = effectiveRoot;
        autoRemaps.push({ projectId: sourceId, from: rootPath, to: effectiveRoot, snapshots });
      }
      projectIds.set(sourceId, byId.id);
      existingIds.projects.add(byId.id);
      addPlan("projects", row, "skip");
      selectedProjects.push({
        id: sourceId,
        name: String(row.name),
        sourceRootPath,
        rootPath: effectiveRoot,
        resolution: "existing",
      });
      continue;
    }
    const matchedProject = byRoot ?? plannedByRoot;
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
        resolution: byRoot ? "existing" : "new",
      });
      continue;
    }
    if (plannedProjectIds.has(sourceId)) {
      addPlan("projects", row, "conflict", "匯入檔中有重複的專案 ID。", "unique");
      selectedProjects.push({ id: sourceId, name: String(row.name), sourceRootPath, rootPath, resolution: "conflict" });
      continue;
    }
    projectIds.set(sourceId, sourceId);
    row.status = "paused";
    row.root_path = storedProjectRoot(rootPath);
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

  const parentOwners = collectParentOwners(db, selectedBundle.tables, projectIds);
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
        parentOwners,
      );
      const id = String(row.id);
      const current = existingRowsById[table].get(id);
      if (dependencyError) {
        // A row already stored here unchanged needs nothing, whatever happened to its parent.
        if (current && equalRows(table, current, row)) {
          addPlan(table, row, "skip");
        } else {
          addPlan(table, row, "conflict", dependencyError, "dependency");
        }
        continue;
      }
      if (current) {
        planExistingRow(db, table, current, row, strategy, addPlan);
        continue;
      }

      const unique = existingUniqueRow(db, table, row);
      if (unique) {
        addPlan(table, row, "conflict", "唯一識別值已被另一筆資料使用。", "unique");
        continue;
      }
      const hasPlannedUnique = plannedUniqueKeysForRow(table, row).some((key) => plannedUniqueKeys[table].has(key));
      if (hasPlannedUnique) {
        addPlan(table, row, "conflict", "匯入檔內有重複的唯一識別值。", "unique");
        continue;
      }
      existingIds[table].add(id);
      addPlan(table, row, "add");
    }
  }

  // A row whose parent is not in the file is never imported; one already stored here unchanged needs nothing.
  const missingByTable = new Map<ProjectDataTable, MissingParentRow[]>();
  for (const missing of missingParents) {
    const list = missingByTable.get(missing.table);
    if (list) list.push(missing);
    else missingByTable.set(missing.table, [missing]);
  }
  for (const [table, entries] of missingByTable) {
    const localRows = new Map(
      rowsByIds(
        db,
        table,
        "id",
        entries.map((entry) => String(entry.row.id)),
      ).map((row) => [String(row.id), row]),
    );
    for (const { row, reason } of entries) {
      const current = localRows.get(String(row.id));
      if (current && equalRows(table, current, row)) addPlan(table, row, "skip");
      else addPlan(table, row, "conflict", reason, "missing_parent");
    }
  }

  const renumbering = planPageVersionNumbers(db, rows.knowledge_page_versions);
  return {
    strategy,
    rows,
    projectIds,
    selectedProjects,
    remappedPaths,
    autoRemaps,
    conflicts,
    conflictDetailsTruncated,
    conflictGroups: [...conflictGroups.values()].sort(
      (left, right) => right.count - left.count || left.table.localeCompare(right.table),
    ),
    pageVersionRenumbers: renumbering.localRenumbers,
    renumbered: renumbering.count > 0 ? { knowledge_page_versions: renumbering.count } : {},
  };
}

function previewFromPlan(plan: TransferPlan): ProjectDataImportPreview {
  const counts = countPlan(plan);
  return {
    outcome: "project_data_import_preview",
    strategy: plan.strategy,
    additions: counts.add,
    skipped: counts.skip,
    conflicts: counts.conflict,
    updates: counts.update,
    keptLocal: counts.keep,
    renumbered: plan.renumbered,
    selectedProjects: plan.selectedProjects,
    remappedPaths: plan.remappedPaths,
    autoRemaps: plan.autoRemaps,
    conflictDetails: plan.conflicts,
    conflictDetailsTruncated: plan.conflictDetailsTruncated,
    conflictGroups: plan.conflictGroups,
  };
}

function rowValues(table: ProjectDataTable, row: ProjectDataRow, columns: readonly string[]): ProjectDataValue[] {
  return columns.map((column) => {
    const value = projectDataColumnValue(table, row, column);
    if (value === undefined) {
      throw new ProjectDataTransferError("invalid_bundle", `匯入的 ${table} 資料缺少 ${column} 欄位。`);
    }
    return value;
  });
}

function insertRow(table: ProjectDataTable, row: ProjectDataRow, statement: InsertStatement): void {
  statement.run(...rowValues(table, row, projectDataExportTableColumns[table]));
}

function updatableColumns(table: ProjectDataTable): string[] {
  const derived = LOCAL_DERIVED_FIELDS[table] ?? [];
  // project_id is never rewritten: an update must not be able to move a row to another project.
  return projectDataExportTableColumns[table].filter(
    (column) => column !== "id" && column !== "project_id" && !derived.includes(column),
  );
}

function updateRow(table: ProjectDataTable, row: ProjectDataRow, statement: InsertStatement): void {
  statement.run(...rowValues(table, row, updatableColumns(table)), String(row.id));
}

/** Moves local page versions to their new numbers in two steps, so no step reuses a number still in use. */
function applyPageVersionRenumbers(db: DatabaseSync, renumbers: TransferPlan["pageVersionRenumbers"]): void {
  if (renumbers.length === 0) return;
  const ids = JSON.stringify(renumbers.map((entry) => entry.id));
  db.prepare(
    `UPDATE knowledge_page_versions SET version = version + ${PAGE_VERSION_OFFSET}
     WHERE id IN (SELECT value FROM json_each(?))`,
  ).run(ids);
  const statement = db.prepare("UPDATE knowledge_page_versions SET version = ? WHERE id = ?");
  for (const entry of renumbers) statement.run(entry.version, entry.id);
}

/** Keeps each page's version counter at its newest stored version so the next save gets a free number. */
function syncPageVersionCounters(db: DatabaseSync, pageIds: readonly string[]): void {
  if (pageIds.length === 0) return;
  db.prepare(
    `UPDATE knowledge_pages
     SET version = MAX(version, COALESCE((SELECT MAX(v.version) FROM knowledge_page_versions v
                                          WHERE v.page_id = knowledge_pages.id), 0))
     WHERE id IN (SELECT value FROM json_each(?))`,
  ).run(JSON.stringify(pageIds));
}

/** Only the newest summary of each report scope stays current after summaries from two machines are merged. */
function syncCurrentReportSummaries(db: DatabaseSync, summaries: readonly ProjectDataRow[]): void {
  const scopes = new Map<string, ProjectDataValue[]>();
  for (const summary of summaries) {
    const scope = [
      summary.period ?? null,
      summary.range_from ?? null,
      summary.range_to ?? null,
      summary.project_id ?? null,
    ];
    scopes.set(JSON.stringify(scope), scope);
  }
  const statement = db.prepare(
    `UPDATE report_summaries
     SET is_current = CASE WHEN id = (
       SELECT s.id FROM report_summaries s
       WHERE s.period = ?1 AND s.range_from = ?2 AND s.range_to = ?3 AND s.project_id IS ?4
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1
     ) THEN 1 ELSE 0 END
     WHERE period = ?1 AND range_from = ?2 AND range_to = ?3 AND project_id IS ?4`,
  );
  for (const scope of scopes.values()) statement.run(...scope);
}

/** The counter every project-data write raises (schema 31 triggers); planning reads only those tables. */
function dataRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT data_revision AS revision FROM change_revisions WHERE singleton = 1").get() as
    { revision?: number } | undefined;
  return Number(row?.revision ?? 0);
}

/** Whether applying the plan changes stored rows; only such an import needs a snapshot to undo it. */
function planWritesData(plan: TransferPlan): boolean {
  return (
    plan.pageVersionRenumbers.length > 0 ||
    TABLE_ORDER.some((table) =>
      plan.rows[table].some((entry) => entry.disposition === "add" || entry.disposition === "update"),
    )
  );
}

/** Exports complete project-scoped data and merges validated portable data without closing SQLite. */
export class ProjectDataTransferService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly databasePath: string,
    private readonly backupOptions: BackupRetentionOptions,
  ) {}

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

  public preview(validated: ValidatedProjectDataImport): ProjectDataImportPreview {
    return runReadTransaction(this.db, () => previewFromPlan(makePlan(this.db, validated)));
  }

  /**
   * Plans from a read snapshot, then writes a checked snapshot only when the plan changes rows, and refuses to write
   * without one; an import that changes nothing (or fails while planning) leaves the kept import snapshots alone.
   * The write lock is held only while rows are written: every project-data write raises data_revision, so an
   * unchanged revision inside the write transaction proves the plan still describes the database, and a changed one
   * makes the import plan again under the lock. When that new plan writes rows the first one did not back up for,
   * the import releases the lock without writing, backs up and tries once more; the retry always backs up first.
   */
  public import(validated: ValidatedProjectDataImport): ProjectDataImportResult {
    const sourceDigest = createHash("sha256").update(JSON.stringify(validated.input)).digest("hex");
    for (const alwaysBackUp of [false, true]) {
      const result = this.writePlanned(validated, this.planWithBackup(validated, alwaysBackUp), sourceDigest);
      if (result) return result;
    }
    // Unreachable: the second attempt always has a snapshot, so writePlanned never declines it.
    throw new ProjectDataTransferError("project_backup_failed", "匯入前無法建立並檢查安全備份，資料沒有變更。");
  }

  private planWithBackup(validated: ValidatedProjectDataImport, alwaysBackUp: boolean): PlannedImport {
    const planned = runReadTransaction(this.db, () => ({
      revision: dataRevision(this.db),
      plan: makePlan(this.db, validated),
    }));
    // Taken before the write lock and after the state the plan was made from, so restoring it undoes the import.
    if (!alwaysBackUp && !planWritesData(planned.plan)) {
      return { ...planned, backedUp: this.databasePath === ":memory:" };
    }
    const backupFileName = this.backupBeforeImport();
    return { ...planned, backedUp: true, ...(backupFileName ? { backupFileName } : {}) };
  }

  /** Returns undefined, having written nothing, when the plan made under the lock needs a snapshot it does not have. */
  private writePlanned(
    validated: ValidatedProjectDataImport,
    planned: PlannedImport,
    sourceDigest: string,
  ): ProjectDataImportResult | undefined {
    return runImmediateTransaction(this.db, () => {
      const plan = dataRevision(this.db) === planned.revision ? planned.plan : makePlan(this.db, validated);
      const changed = planWritesData(plan);
      if (changed && !planned.backedUp) return undefined;
      applyPageVersionRenumbers(this.db, plan.pageVersionRenumbers);
      const insertStatements = new Map<ProjectDataTable, InsertStatement>();
      const updateStatements = new Map<ProjectDataTable, InsertStatement>();
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
            insertRow(table, entry.row, statement);
          } else if (entry.disposition === "update") {
            let statement = updateStatements.get(table);
            if (!statement) {
              const assignments = updatableColumns(table).map((column) => `${column} = ?`);
              statement = this.db.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`);
              updateStatements.set(table, statement);
            }
            updateRow(table, entry.row, statement);
          }
        }
      }
      const written = (table: ProjectDataTable) =>
        plan.rows[table].filter((entry) => entry.disposition === "add" || entry.disposition === "update");
      syncPageVersionCounters(this.db, [
        ...new Set([
          ...written("knowledge_page_versions").map((entry) => String(entry.row.page_id)),
          ...written("knowledge_pages").map((entry) => String(entry.row.id)),
        ]),
      ]);
      syncCurrentReportSummaries(
        this.db,
        written("report_summaries").map((entry) => entry.row),
      );
      const preview = previewFromPlan(plan);
      const importedAt = nowIso();
      // Counts only: the audit never stores paths or row contents.
      const remapCounts = JSON.stringify({
        explicit: plan.remappedPaths,
        automatic: plan.autoRemaps.map((entry) => ({ projects: 1, snapshots: entry.snapshots })),
        strategy: plan.strategy,
        updates: preview.updates,
        keptLocal: preview.keptLocal,
        renumbered: preview.renumbered,
      });
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
      return {
        ...preview,
        outcome: "project_data_imported",
        importedAt,
        changed,
        redactions: validated.redactions,
        ...(planned.backupFileName ? { backupFileName: planned.backupFileName } : {}),
      };
    });
  }

  /** Fails closed like project deletion: no checked snapshot, no import. An in-memory database has no file to keep. */
  private backupBeforeImport(): string | undefined {
    if (this.databasePath === ":memory:") return undefined;
    try {
      return backupDatabaseBeforeImport(this.db, this.databasePath, this.backupOptions).created.fileName;
    } catch (error) {
      // A busy, read-only or full database keeps its own code; every other backup failure stops the import.
      if (databaseUnavailableReason(error)) throw error;
      throw new ProjectDataTransferError("project_backup_failed", "匯入前無法建立並檢查安全備份，資料沒有變更。");
    }
  }
}
