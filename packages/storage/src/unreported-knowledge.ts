import type { DatabaseSync } from "node:sqlite";
import type { UnreportedKnowledge } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";

interface UnreportedKnowledgeFocus {
  projectId: string;
  sessionId: string;
  agentClient: string;
  connectionId?: string;
  previousSaveAt?: string;
  startedAt: string;
  completedAt: string;
  excludedIds: readonly string[];
}

type UnreportedKnowledgeRow = { id: string; title: string; total: number };

const UNREPORTED_KNOWLEDGE_ITEMS = 3;
const UNREPORTED_KNOWLEDGE_TITLE_CHARS = 80;
/** Compact Knowledge search items carry no body, so the audit never records them as Knowledge. */
const RECALL_TOOLS = JSON.stringify(["work_get_context", "work_recall", "work_search", "work_search_knowledge"]);

/** Attributed only by project, client and time, so the list is a reminder, never evidence. */
export function findUnreportedKnowledge(
  db: DatabaseSync,
  focus: UnreportedKnowledgeFocus,
): UnreportedKnowledge | undefined {
  // A retry of this very save reports the caller's latest save, which is this one; it bounds nothing.
  const previousSaveAt =
    focus.previousSaveAt && focus.previousSaveAt < focus.completedAt ? focus.previousSaveAt : undefined;
  const rows = db
    .prepare(
      `WITH bounds AS (
         SELECT MAX(@startedAt, COALESCE(
           CASE WHEN @connectionId IS NOT NULL THEN @previousSaveAt ELSE (
             SELECT MAX(s.completed_at) FROM sessions s
             WHERE s.project_id = @projectId AND s.completed_at > @startedAt AND s.completed_at < @completedAt
               AND s.id <> @sessionId AND s.agent_client = @agentClient
           ) END, '')) AS since
       ),
       reads AS (
         SELECT r.record_id AS knowledge_id, MAX(a.created_at) AS read_at
         FROM agent_read_audit a
         CROSS JOIN agent_read_audit_records r ON r.audit_id = a.id AND r.record_type = 'knowledge'
         WHERE a.project_id = @projectId
           AND a.created_at >= (SELECT since FROM bounds) AND a.created_at <= @completedAt
           AND CASE WHEN @connectionId IS NOT NULL THEN a.connection_id = @connectionId ELSE a.agent_client = @agentClient END
           AND a.tool IN (SELECT value FROM json_each(@tools))
         GROUP BY r.record_id
       )
       SELECT k.id, k.title, COUNT(*) OVER () AS total
       FROM reads CROSS JOIN knowledge k ON k.id = reads.knowledge_id
       WHERE k.project_id = @projectId AND k.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.session_id = @sessionId)
         AND k.id NOT IN (SELECT value FROM json_each(@excludedIds))
       ORDER BY reads.read_at DESC, k.id ASC
       LIMIT @limit`,
    )
    .all({
      projectId: focus.projectId,
      sessionId: focus.sessionId,
      agentClient: focus.agentClient,
      connectionId: focus.connectionId ?? null,
      previousSaveAt: previousSaveAt ?? null,
      startedAt: focus.startedAt,
      completedAt: focus.completedAt,
      tools: RECALL_TOOLS,
      excludedIds: JSON.stringify(focus.excludedIds),
      limit: UNREPORTED_KNOWLEDGE_ITEMS,
    }) as unknown as UnreportedKnowledgeRow[];
  if (rows.length === 0) return undefined;
  return {
    items: rows.map((row) => ({ id: row.id, title: truncateText(row.title, UNREPORTED_KNOWLEDGE_TITLE_CHARS) })),
    total: rows[0]!.total,
  };
}
