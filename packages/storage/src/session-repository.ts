import { DatabaseSync } from "node:sqlite";
import type { PageInfo, SessionListResult, SessionVoidedFilter, WorkSessionRecord } from "@work-intelligence/core";
import { parseListSearchTerms } from "@work-intelligence/core";
import { localDayStartIso } from "@work-intelligence/shared";
import {
  listSearchMoreGuard,
  listSearchOverBoundWarning,
  listSearchRowCap,
  listSearchRowGuard,
  SESSION_SEARCH_ROW_BYTES,
  runListSearchScan,
} from "./list-search-scan.js";

export type SessionRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  external_session_id: string | null;
  idempotency_key: string;
  title: string;
  summary: string;
  work_summary_json: string | null;
  status: "finalized";
  execution_status: "completed";
  completed_at: string;
  created_at: string;
  commit_sha: string | null;
  git_branch: string | null;
  changed_files_json: string;
  changed_files_confirmed?: number;
  redaction_count?: number;
  changed_files_provenance_json: string;
  changed_file_changes_json: string | null;
  verification_json: string | null;
  voided_at: string | null;
  void_reason: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  agent_client?: string | null;
  agent_model?: string | null;
};

export type SessionListOptions = {
  projectId?: string;
  agentClient?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
  trackedOnly?: boolean;
  voided?: SessionVoidedFilter;
  commitSha?: string;
  startedFrom?: string;
  startedTo?: string;
  completedAfter?: string;
  completedBefore?: string;
  updatedFrom?: string;
  updatedTo?: string;
};

export function nextCalendarDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed)) {
    // Not a calendar date: keep the prefix semantics of `substr(completed_at, 1, 10) <= date`.
    return `${date}￿`;
  }
  const nextDate = new Date(parsed + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return localDayStartIso(nextDate) ?? nextDate;
}

type SessionMapper = (row: SessionRow) => WorkSessionRecord;
type PageInfoBuilder = (
  pageValue: number | undefined,
  pageSizeValue: number | undefined,
  total: number,
  maxPageSize?: number,
) => PageInfo;

/** The event bytes are summed only when a word was not found in the columns, at most once per row. */
const SEARCHED_COLUMN_BYTES = `COALESCE(octet_length(s.title), 0) + COALESCE(octet_length(s.summary), 0)
  + COALESCE(octet_length(s.work_summary_json), 0) + COALESCE(octet_length(s.changed_files_json), 0)`;
const SEARCHED_EVENT_BYTES = `(SELECT COALESCE(SUM(octet_length(charged_events.summary)), 0) FROM work_events charged_events
     WHERE charged_events.session_id = s.id)`;

export class SessionRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly mapSession: SessionMapper,
    private readonly buildPageInfo: PageInfoBuilder,
  ) {}

  public list(options: SessionListOptions = {}): WorkSessionRecord[] {
    const { clauses, parameters } = this.buildFilter(options);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    // CROSS JOIN keeps sessions as the outer loop so a newest-first list stops at the limit (a plain JOIN sorted all
    // Sessions). ORDER BY ends with the unique id, so the order is the same under any plan.
    const { value: rows } = runListSearchScan(
      this.db,
      1,
      () =>
        this.db
          .prepare(
            `SELECT s.*, p.name AS project_name
             FROM sessions s
             CROSS JOIN projects p ON p.id = s.project_id
             ${where}
             ORDER BY s.completed_at DESC, s.id DESC
             LIMIT ?`,
          )
          .all(...parameters, limit) as SessionRow[],
      SESSION_SEARCH_ROW_BYTES,
    );
    return rows.map(this.mapSession);
  }

  public listPage(options: SessionListOptions = {}): SessionListResult {
    const { clauses, parameters, terms, warnings } = this.buildFilter(options);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    if (terms.length > 0) {
      const { value, scan } = runListSearchScan(
        this.db,
        1,
        () => this.listTextQueryPage(where, parameters, options),
        SESSION_SEARCH_ROW_BYTES,
      );
      const truncated = listSearchOverBoundWarning(scan);
      const allWarnings = [...warnings, ...(truncated ? [truncated] : [])];
      return {
        ...value,
        ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        ...(scan.overBound > 0 ? { searchSkippedRecords: scan.overBound } : {}),
      };
    }
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         ${where}`,
      )
      .get(...parameters) as { count: number };
    const pageInfo = this.buildPageInfo(options.page, options.pageSize, totalRow.count, 100);
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         ${where}
         ORDER BY s.completed_at DESC, s.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as SessionRow[];
    return {
      outcome: "sessions",
      items: rows.map(this.mapSession),
      pageInfo,
    };
  }

  public listReportIds(options: Pick<SessionListOptions, "from" | "to" | "projectId">): string[] {
    const { clauses, parameters } = this.buildFilter({ ...options, trackedOnly: true });
    const rows = this.db
      .prepare(
        `SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE ${clauses.join(" AND ")} ORDER BY s.completed_at DESC, s.id DESC`,
      )
      .all(...parameters) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  public listReportSources(
    ids: readonly string[],
    options: { page?: number; pageSize?: number; projectId?: string },
  ): SessionListResult {
    const sourceJson = JSON.stringify([...new Set(ids)]);
    const scope = options.projectId ?? null;
    const from = `FROM json_each(?) source
      CROSS JOIN sessions s ON s.id = source.value
      CROSS JOIN projects p ON p.id = s.project_id
      WHERE p.status = 'tracked' AND s.voided_at IS NULL AND (? IS NULL OR s.project_id = ?)`;
    const total = this.db.prepare(`SELECT COUNT(*) AS count ${from}`).get(sourceJson, scope, scope) as {
      count: number;
    };
    const pageInfo = this.buildPageInfo(options.page, options.pageSize, total.count, 100);
    const rows = this.db
      .prepare(`SELECT s.*, p.name AS project_name ${from} ORDER BY CAST(source.key AS INTEGER) LIMIT ? OFFSET ?`)
      .all(sourceJson, scope, scope, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as SessionRow[];
    return { outcome: "sessions", items: rows.map(this.mapSession), pageInfo };
  }

  public distinctCommitShas(options: SessionListOptions, limit: number): string[] {
    const { clauses, parameters } = this.buildFilter(options);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { value: rows } = runListSearchScan(
      this.db,
      1,
      () =>
        this.db
          .prepare(
            `SELECT DISTINCT lower(s.commit_sha) AS commit_sha
             FROM sessions s
             JOIN projects p ON p.id = s.project_id
             ${where}
             LIMIT ?`,
          )
          .all(...parameters, limit) as Array<{ commit_sha: string }>,
      SESSION_SEARCH_ROW_BYTES,
    );
    return rows.map((row) => row.commit_sha);
  }

  public listAgentClients(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.agent_client AS agent_client
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.agent_client IS NOT NULL AND s.voided_at IS NULL AND p.status = 'tracked'
         ORDER BY s.agent_client`,
      )
      .all() as Array<{ agent_client: string }>;
    return rows.map((row) => row.agent_client);
  }

  public getByIdempotencyKey(idempotencyKey: string): WorkSessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.idempotency_key = ?`,
      )
      .get(idempotencyKey) as SessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  public getById(sessionId: string): WorkSessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  private listTextQueryPage(
    where: string,
    parameters: Array<string | number | null>,
    options: SessionListOptions,
  ): SessionListResult {
    const ids = (
      this.db
        .prepare(
          `SELECT s.id
           FROM sessions s
           JOIN projects p ON p.id = s.project_id
           ${where}
           ORDER BY s.completed_at DESC, s.id DESC`,
        )
        .all(...parameters) as Array<{ id: string }>
    ).map((row) => row.id);
    const pageInfo = this.buildPageInfo(options.page, options.pageSize, ids.length, 100);
    const pageIds = ids.slice((pageInfo.page - 1) * pageInfo.pageSize, pageInfo.page * pageInfo.pageSize);
    const rows =
      pageIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT s.*, p.name AS project_name
               FROM json_each(?) page
               CROSS JOIN sessions s ON s.id = page.value
               JOIN projects p ON p.id = s.project_id
               ORDER BY page.key`,
            )
            .all(JSON.stringify(pageIds)) as SessionRow[]);
    return { outcome: "sessions", items: rows.map(this.mapSession), pageInfo };
  }

  private buildFilter(options: SessionListOptions): {
    clauses: string[];
    parameters: Array<string | number | null>;
    terms: string[];
    warnings: string[];
  } {
    const clauses: string[] = [];
    const parameters: Array<string | number | null> = [];

    if (options.projectId) {
      clauses.push("s.project_id = ?");
      parameters.push(options.projectId);
    }

    if (options.agentClient) {
      clauses.push("s.agent_client = ?");
      parameters.push(options.agentClient);
    }

    if (options.trackedOnly) {
      clauses.push("p.status = 'tracked'");
    }

    // A prefix range rather than LIKE, so idx_sessions_commit_sha seeks it; upper-case shas stored by an older build or
    // an import get a second seek of their own range.
    if (options.commitSha) {
      const ranges = [...new Set([options.commitSha, options.commitSha.toUpperCase()])];
      const range = "SELECT rowid FROM sessions WHERE commit_sha >= ? AND commit_sha < ?";
      clauses.push(`s.rowid IN (${ranges.map(() => range).join(" UNION ALL ")})`);
      for (const prefix of ranges) {
        parameters.push(prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1));
      }
    }

    const voided = options.voided ?? "exclude";
    if (voided === "exclude") {
      clauses.push("s.voided_at IS NULL");
    } else if (voided === "only") {
      clauses.push("s.voided_at IS NOT NULL");
    }

    const { terms, warnings } = parseListSearchTerms(options.query ?? "");
    if (terms.length > 0) {
      // The check sits in a CASE WHEN condition, which SQLite evaluates left to right and short-circuits; in a THEN branch
      // every field was searched for every word.
      const cap = listSearchRowCap(SESSION_SEARCH_ROW_BYTES);
      const termClauses = terms.map(
        (_, index) =>
          `CASE WHEN ${listSearchRowGuard("s.rowid", SEARCHED_COLUMN_BYTES, index, cap)} AND (instr(LOWER(s.title), ?) > 0 OR instr(LOWER(s.summary), ?) > 0
          -- Match the values only, so section names like "decisions" do not match every Session.
          OR EXISTS (
            SELECT 1
            FROM json_each(CASE WHEN json_valid(s.work_summary_json) THEN s.work_summary_json ELSE '{}' END) section,
              json_each(CASE WHEN section.type = 'array' THEN section.value ELSE '[]' END) line
            WHERE instr(LOWER(line.value), ?) > 0
          )
          OR EXISTS (
            SELECT 1
            FROM json_each(CASE WHEN json_valid(s.changed_files_json) AND json_type(s.changed_files_json) = 'array' THEN s.changed_files_json ELSE '[]' END) file
            WHERE instr(LOWER(file.value), ?) > 0
          )
          OR ${listSearchMoreGuard("s.rowid", SEARCHED_EVENT_BYTES)} AND EXISTS (
            SELECT 1 FROM work_events search_events
            WHERE search_events.session_id = s.id AND instr(LOWER(search_events.summary), ?) > 0
          )) THEN 1 ELSE 0 END`,
      );
      clauses.push(`(${termClauses.join(" AND ")})`);
      for (const term of terms) parameters.push(term, term, term, term, term);
    }

    if (options.from) {
      clauses.push("s.completed_at >= ?");
      parameters.push(localDayStartIso(options.from) ?? options.from);
    }

    if (options.to) {
      clauses.push("s.completed_at < ?");
      parameters.push(nextCalendarDate(options.to));
    }

    if (options.startedFrom) {
      clauses.push("s.started_at >= ?");
      parameters.push(localDayStartIso(options.startedFrom) ?? options.startedFrom);
    }
    if (options.startedTo) {
      clauses.push("s.started_at < ?");
      parameters.push(nextCalendarDate(options.startedTo));
    }
    if (options.completedAfter) {
      clauses.push("s.completed_at >= ?");
      parameters.push(nextCalendarDate(options.completedAfter));
    }
    if (options.completedBefore) {
      clauses.push("s.completed_at < ?");
      parameters.push(localDayStartIso(options.completedBefore) ?? options.completedBefore);
    }
    if (options.updatedFrom || options.updatedTo) {
      // Matches the Web's "更新於" rule: a change more than a minute after finalize.
      clauses.push("(julianday(s.updated_at) - julianday(s.created_at)) * 86400 > 60");
    }
    if (options.updatedFrom) {
      clauses.push("s.updated_at >= ?");
      parameters.push(localDayStartIso(options.updatedFrom) ?? options.updatedFrom);
    }
    if (options.updatedTo) {
      clauses.push("s.updated_at < ?");
      parameters.push(nextCalendarDate(options.updatedTo));
    }

    return { clauses, parameters, terms, warnings };
  }
}
