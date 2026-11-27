import type { DatabaseSync } from "node:sqlite";

/** @internal test-only */
export const BACKLOG_SCORE_WEIGHTS = {
  decision: 2,
  decisionCap: 3,
  verificationRecovered: 3,
  inboundLink: 1.5,
  inboundLinkCap: 3,
  reread: 0.5,
  rereadCap: 5,
  citedByKnowledge: -1,
} as const;

/** Context and recall also log every Session they return, which would make recent Sessions look re-read. */
const DELIBERATE_READ_TOOL = "work_get_session";

export const HIGH_VALUE_MIN_SCORE = 1;
export const CONTEXT_BACKLOG_MIN_HIGH_VALUE = 5;
export const CONTEXT_BACKLOG_MIN_DAYS_SINCE_REQUEST = 7;

export interface BacklogSignals {
  confirmedDecisions: number;
  verificationRecovered: boolean;
  inboundLinks: number;
  rereads: number;
  citedByKnowledge: boolean;
}

export interface BacklogSession {
  id: string;
  projectId: string;
  completedAt: string;
  score: number;
}

export interface BacklogCounts {
  uncoveredSessions: number;
  highValueSessions: number;
}

type BacklogRow = {
  id: string;
  project_id: string;
  completed_at: string;
  confirmed_decisions: number;
  verification_recovered: number;
  inbound_links: number;
  rereads: number;
  cited_by_knowledge: number;
};

const WEIGHTS = BACKLOG_SCORE_WEIGHTS;

// Decisions that predate session_decisions were never subject to review, so they count as confirmed.
const LEGACY_DECISION_COUNT = `CASE WHEN json_valid(s.work_summary_json) AND json_type(s.work_summary_json, '$.decisions') = 'array'
  THEN json_array_length(s.work_summary_json, '$.decisions') ELSE 0 END`;

function compareBacklogSessions(left: BacklogSession, right: BacklogSession): number {
  return (
    right.score - left.score ||
    right.completedAt.localeCompare(left.completedAt) ||
    (right.id < left.id ? -1 : right.id > left.id ? 1 : 0)
  );
}

/** @internal test-only */
export function scoreBacklogSession(signals: BacklogSignals): number {
  return (
    Math.min(signals.confirmedDecisions, WEIGHTS.decisionCap) * WEIGHTS.decision +
    (signals.verificationRecovered ? WEIGHTS.verificationRecovered : 0) +
    Math.min(signals.inboundLinks, WEIGHTS.inboundLinkCap) * WEIGHTS.inboundLink +
    Math.min(signals.rereads, WEIGHTS.rereadCap) * WEIGHTS.reread +
    (signals.citedByKnowledge ? WEIGHTS.citedByKnowledge : 0)
  );
}

export function loadUncoveredBacklogSessions(db: DatabaseSync, projectId?: string): BacklogSession[] {
  const sessionScope = projectId
    ? "s.project_id = ?"
    : "s.project_id IN (SELECT id FROM projects WHERE status = 'tracked')";
  const requestScope = projectId ? "r.project_id = ? AND" : "";
  const parameters = projectId ? [projectId, projectId] : [];
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.completed_at,
         COALESCE(
           (SELECT SUM(d.review_status = 'confirmed') FROM session_decisions d WHERE d.session_id = s.id),
           ${LEGACY_DECISION_COUNT}
         ) AS confirmed_decisions,
         (
           EXISTS (
             SELECT 1 FROM session_verification_updates u
             WHERE u.session_id = s.id
               AND json_extract(u.previous_json, '$.status') = 'failed'
               AND json_extract(u.resulting_json, '$.status') = 'passed'
           )
           OR (
             json_extract(s.verification_json, '$.status') = 'passed'
             AND EXISTS (
               SELECT 1 FROM session_links l JOIN sessions earlier ON earlier.id = l.related_session_id
               WHERE l.session_id = s.id AND l.relation = 'continues'
                 AND json_extract(earlier.verification_json, '$.status') = 'failed'
             )
           )
         ) AS verification_recovered,
         (
           SELECT COUNT(*) FROM session_links l
           JOIN sessions later ON later.id = l.session_id AND later.voided_at IS NULL
           WHERE l.related_session_id = s.id
         ) AS inbound_links,
         (
           SELECT COUNT(*) FROM (
             SELECT 1 FROM agent_read_audit_records a
             JOIN agent_read_audit au ON au.id = a.audit_id AND au.tool = '${DELIBERATE_READ_TOOL}'
             WHERE a.record_type = 'session' AND a.record_id = s.id LIMIT ${WEIGHTS.rereadCap}
           )
         ) AS rereads,
         EXISTS (SELECT 1 FROM knowledge k WHERE k.session_id = s.id) AS cited_by_knowledge
       FROM sessions s
       WHERE ${sessionScope} AND s.voided_at IS NULL
         AND s.id NOT IN (
           SELECT j.value FROM knowledge_candidate_requests r, json_each(r.source_session_ids_json) j
           WHERE ${requestScope} r.status <> 'cancelled' AND j.value IS NOT NULL
         )`,
    )
    .all(...parameters) as BacklogRow[];
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    completedAt: row.completed_at,
    score: scoreBacklogSession({
      confirmedDecisions: row.confirmed_decisions,
      verificationRecovered: row.verification_recovered === 1,
      inboundLinks: row.inbound_links,
      rereads: row.rereads,
      citedByKnowledge: row.cited_by_knowledge === 1,
    }),
  }));
}

/** @internal test-only */
export function selectTopBacklogSessions(sessions: readonly BacklogSession[], limit: number): BacklogSession[] {
  const top: BacklogSession[] = [];
  for (const session of sessions) {
    if (top.length === limit && compareBacklogSessions(session, top[limit - 1]!) >= 0) {
      continue;
    }
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareBacklogSessions(top[middle]!, session) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    top.splice(low, 0, session);
    if (top.length > limit) {
      top.pop();
    }
  }
  return top;
}

export function selectRequestSessions(
  sessions: readonly BacklogSession[],
  limit: number,
  highValueOnly: boolean,
): BacklogSession[] {
  const highValue = sessions.filter((session) => session.score >= HIGH_VALUE_MIN_SCORE);
  if (highValue.length > 0) return selectTopBacklogSessions(highValue, limit);
  return highValueOnly ? [] : selectTopBacklogSessions(sessions, limit);
}

export function summarizeBacklog(
  sessions: readonly BacklogSession[],
  excluded: ReadonlySet<string> = new Set(),
): BacklogCounts {
  let uncoveredSessions = 0;
  let highValueSessions = 0;
  for (const session of sessions) {
    if (excluded.has(session.id)) continue;
    uncoveredSessions += 1;
    if (session.score >= HIGH_VALUE_MIN_SCORE) highValueSessions += 1;
  }
  return { uncoveredSessions, highValueSessions };
}

export function summarizeBacklogByProject(
  sessions: readonly BacklogSession[],
): Array<BacklogCounts & { projectId: string }> {
  const byProject = new Map<string, BacklogSession[]>();
  for (const session of sessions) {
    const group = byProject.get(session.projectId);
    if (group) group.push(session);
    else byProject.set(session.projectId, [session]);
  }
  return [...byProject].map(([projectId, group]) => ({ projectId, ...summarizeBacklog(group) }));
}
