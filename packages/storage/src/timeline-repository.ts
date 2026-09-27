import type { DatabaseSync } from "node:sqlite";
import type {
  ReportVerificationStatus,
  TimelineKnowledgeEvent,
  TimelineKnowledgeEventKind,
  TimelineLink,
  TimelineSession,
} from "@work-intelligence/core";
import { localDayStartIso } from "@work-intelligence/shared";
import { nextCalendarDate } from "./session-repository.js";

export interface TimelineOptions {
  /** Tracked projects in scope. */
  projectIds: readonly string[];
  /** Inclusive calendar dates in the server's time zone. */
  from: string;
  to: string;
}

export interface TimelineRows {
  sessions: TimelineSession[];
  knowledgeEvents: TimelineKnowledgeEvent[];
  links: TimelineLink[];
  truncated: boolean;
}

/** One response stays drawable: the newest Sessions and events are kept beyond these limits. */
const SESSION_LIMIT = 2_000;
const EVENT_LIMIT = 2_000;

export class TimelineRepository {
  public constructor(private readonly db: DatabaseSync) {}

  /**
   * Sessions that overlap the range (completed in it, or started before it ended), Knowledge events inside it,
   * and the links between the returned Sessions. Voided Sessions are left out.
   */
  public timeline(options: TimelineOptions): TimelineRows {
    const start = localDayStartIso(options.from) ?? options.from;
    const end = nextCalendarDate(options.to);
    const projects = JSON.stringify(options.projectIds);

    const sessionRows = this.db
      .prepare(
        `SELECT id, project_id, title, started_at, completed_at,
                COALESCE(json_extract(verification_json, '$.status'), 'not_supplied') AS status
         FROM sessions
         WHERE voided_at IS NULL AND project_id IN (SELECT value FROM json_each(?))
           AND completed_at >= ? AND COALESCE(started_at, completed_at) < ?
         ORDER BY completed_at DESC, id
         LIMIT ?`,
      )
      .all(projects, start, end, SESSION_LIMIT + 1) as Array<{
      id: string;
      project_id: string;
      title: string;
      started_at: string | null;
      completed_at: string;
      status: ReportVerificationStatus;
    }>;
    const truncated = sessionRows.length > SESSION_LIMIT;
    const sessions = sessionRows.slice(0, SESSION_LIMIT).map((row): TimelineSession => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      ...(row.started_at && row.started_at < row.completed_at ? { startedAt: row.started_at } : {}),
      completedAt: row.completed_at,
      verificationStatus: row.status,
    }));

    const sessionIds = JSON.stringify(sessions.map((session) => session.id));
    const links = (
      this.db
        .prepare(
          `SELECT session_id, related_session_id, relation FROM session_links
           WHERE session_id IN (SELECT value FROM json_each(?))
             AND related_session_id IN (SELECT value FROM json_each(?))`,
        )
        .all(sessionIds, sessionIds) as Array<{
        session_id: string;
        related_session_id: string;
        relation: TimelineLink["relation"];
      }>
    ).map((row) => ({ sessionId: row.session_id, relatedSessionId: row.related_session_id, relation: row.relation }));

    // One UNION query collects every kind of Knowledge event in the range, newest first.
    const eventRows = this.db
      .prepare(
        `SELECT k.id AS knowledge_id, k.project_id, k.title, 'created' AS kind, k.created_at AS at,
                k.session_id AS session_id, NULL AS superseded_by
         FROM knowledge k
         WHERE k.project_id IN (SELECT value FROM json_each(?)) AND k.created_at >= ? AND k.created_at < ?
         UNION ALL
         SELECT k.id, k.project_id, k.title,
                CASE WHEN f.kind = 'contradicted' THEN 'contradicted' ELSE 'confirmed' END,
                f.occurred_at, f.session_id, NULL
         FROM knowledge_feedback f JOIN knowledge k ON k.id = f.knowledge_id
         WHERE f.project_id IN (SELECT value FROM json_each(?)) AND f.occurred_at >= ? AND f.occurred_at < ?
         UNION ALL
         SELECT old.id, old.project_id, old.title, 'superseded', replacement.created_at, NULL, replacement.id
         FROM knowledge replacement JOIN knowledge old ON old.id = replacement.supersedes_id
         WHERE replacement.project_id IN (SELECT value FROM json_each(?))
           AND replacement.created_at >= ? AND replacement.created_at < ?
         ORDER BY at DESC
         LIMIT ?`,
      )
      .all(projects, start, end, projects, start, end, projects, start, end, EVENT_LIMIT) as Array<{
      knowledge_id: string;
      project_id: string;
      title: string;
      kind: TimelineKnowledgeEventKind;
      at: string;
      session_id: string | null;
      superseded_by: string | null;
    }>;
    const knowledgeEvents = eventRows.map((row): TimelineKnowledgeEvent => ({
      knowledgeId: row.knowledge_id,
      projectId: row.project_id,
      title: row.title,
      kind: row.kind,
      at: row.at,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.superseded_by ? { supersededById: row.superseded_by } : {}),
    }));

    return { sessions, knowledgeEvents, links, truncated };
  }
}
