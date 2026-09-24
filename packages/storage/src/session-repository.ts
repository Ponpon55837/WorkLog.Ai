import { DatabaseSync } from "node:sqlite";
import type { PageInfo, SessionListResult, SessionVoidedFilter, WorkSessionRecord } from "@work-intelligence/core";
import { localDayStartIso } from "@work-intelligence/shared";
import { LIKE_ESCAPE, likeContainsPattern } from "./sql-like.js";

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
  changed_files_provenance_json: string;
  changed_file_changes_json: string | null;
  verification_json: string | null;
  voided_at: string | null;
  void_reason: string | null;
  started_at?: string | null;
  updated_at?: string | null;
};

export type SessionListOptions = {
  projectId?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
  trackedOnly?: boolean;
  /** Voided Sessions are excluded unless asked for; "only" lists just the voided ones. */
  voided?: SessionVoidedFilter;
};

/**
 * Returns the UTC instant where the local calendar day after `date` (YYYY-MM-DD) starts, used as an
 * exclusive upper bound on `completed_at`.
 */
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

/** Read-side Session persistence kept separate from finalize/update workflows. */
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
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         ${where}
         ORDER BY s.completed_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit) as SessionRow[];
    return rows.map(this.mapSession);
  }

  public listPage(options: SessionListOptions = {}): SessionListResult {
    const { clauses, parameters } = this.buildFilter(options);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
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

  private buildFilter(options: SessionListOptions): {
    clauses: string[];
    parameters: Array<string | number | null>;
  } {
    const clauses: string[] = [];
    const parameters: Array<string | number | null> = [];

    if (options.projectId) {
      clauses.push("s.project_id = ?");
      parameters.push(options.projectId);
    }

    if (options.trackedOnly) {
      clauses.push("p.status = 'tracked'");
    }

    const voided = options.voided ?? "exclude";
    if (voided === "exclude") {
      clauses.push("s.voided_at IS NULL");
    } else if (voided === "only") {
      clauses.push("s.voided_at IS NOT NULL");
    }

    if (options.query) {
      clauses.push(
        `(LOWER(s.title) LIKE ? ${LIKE_ESCAPE} OR LOWER(s.summary) LIKE ? ${LIKE_ESCAPE} OR EXISTS (
          SELECT 1 FROM work_events search_events
          WHERE search_events.session_id = s.id AND LOWER(search_events.summary) LIKE ? ${LIKE_ESCAPE}
        ))`,
      );
      const needle = likeContainsPattern(options.query.toLowerCase());
      parameters.push(needle, needle, needle);
    }

    // Compare the raw ISO timestamp so the completed_at indexes stay usable. Calendar dates become
    // the UTC instants of local midnight, so `from`/`to` follow the host time zone.
    if (options.from) {
      clauses.push("s.completed_at >= ?");
      parameters.push(localDayStartIso(options.from) ?? options.from);
    }

    if (options.to) {
      clauses.push("s.completed_at < ?");
      parameters.push(nextCalendarDate(options.to));
    }

    return { clauses, parameters };
  }
}
