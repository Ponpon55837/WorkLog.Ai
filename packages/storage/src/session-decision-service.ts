import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ListSessionDecisionsInput,
  PolicyDecision,
  ReviewSessionDecisionInput,
  ReviewSessionDecisionResult,
  SessionDecisionListQueryResult,
  SessionDecisionRecord,
  SessionDecisionReviewStatus,
  WorkSummaryDecisionOrigin,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export interface SessionDecisionDraft {
  text: string;
  origin: WorkSummaryDecisionOrigin | "unspecified";
}

type SessionDecisionRow = {
  id: string;
  session_id: string;
  project_id: string;
  position: number;
  text: string;
  origin: SessionDecisionRecord["origin"];
  review_status: SessionDecisionReviewStatus;
  reviewed_at: string | null;
  knowledge_id: string | null;
  session_title?: string;
  session_completed_at?: string;
};

interface SessionDecisionDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
}

function toDecision(row: SessionDecisionRow): SessionDecisionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    position: row.position,
    text: row.text,
    origin: row.origin,
    reviewStatus: row.review_status,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.knowledge_id ? { knowledgeId: row.knowledge_id } : {}),
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    ...(row.session_completed_at ? { sessionCompletedAt: row.session_completed_at } : {}),
  };
}

/** Keeps the provenance index in sync with the compatibility string array stored on Sessions. */
export function replaceSessionDecisions(
  db: DatabaseSync,
  sessionId: string,
  projectId: string,
  decisions: SessionDecisionDraft[],
): void {
  const existing = db
    .prepare(
      `SELECT id, text, origin, review_status, reviewed_at, knowledge_id
       FROM session_decisions WHERE session_id = ? ORDER BY position ASC, id ASC`,
    )
    .all(sessionId) as Array<{
    id: string;
    text: string;
    origin: SessionDecisionRecord["origin"];
    review_status: SessionDecisionReviewStatus;
    reviewed_at: string | null;
    knowledge_id: string | null;
  }>;
  const existingByText = new Map<string, typeof existing>();
  for (const row of existing) {
    const matches = existingByText.get(row.text) ?? [];
    matches.push(row);
    existingByText.set(row.text, matches);
  }

  db.prepare("DELETE FROM session_decisions WHERE session_id = ?").run(sessionId);
  const insert = db.prepare(
    `INSERT INTO session_decisions (
       id, session_id, project_id, position, text, origin, review_status, reviewed_at, knowledge_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  decisions.forEach((decision, position) => {
    const previous = existingByText.get(decision.text)?.shift();
    insert.run(
      previous?.id ?? randomUUID(),
      sessionId,
      projectId,
      position,
      decision.text,
      decision.origin,
      previous?.review_status ?? (decision.origin === "agent_autonomous" ? "pending" : "confirmed"),
      previous?.reviewed_at ?? null,
      previous?.knowledge_id ?? null,
    );
  });
}

/** Policy-gated decision inbox and user-only review transitions. */
export class SessionDecisionService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: SessionDecisionDependencies,
  ) {}

  public list(input: ListSessionDecisionsInput = {}): SessionDecisionListQueryResult {
    let projectId: string | undefined;
    if (input.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return {
          outcome: "skipped",
          projectRoot: decision.canonicalRoot,
          projectStatus: decision.projectStatus,
          reason: decision.reason ?? "Project recording is not enabled.",
        };
      }
      projectId = decision.project.id;
    }
    const projectFilter = projectId ? "AND d.project_id = ?" : "";
    const scopeParams = projectId ? [projectId] : [];
    const pendingCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM session_decisions d
           JOIN projects p ON p.id = d.project_id
           JOIN sessions s ON s.id = d.session_id
           WHERE p.status = 'tracked' AND s.voided_at IS NULL
             AND d.origin = 'agent_autonomous' AND d.review_status = 'pending' ${projectFilter}`,
        )
        .get(...scopeParams) as { count: number }
    ).count;
    const pendingOnly = input.status !== "all";
    const rows = this.db
      .prepare(
        `SELECT d.*, s.title AS session_title, s.completed_at AS session_completed_at
         FROM session_decisions d
         JOIN projects p ON p.id = d.project_id
         JOIN sessions s ON s.id = d.session_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL
           ${pendingOnly ? "AND d.origin = 'agent_autonomous' AND d.review_status = 'pending'" : ""}
           ${projectFilter}
         ORDER BY s.completed_at DESC, d.session_id DESC, d.position ASC
         LIMIT ?`,
      )
      .all(...scopeParams, Math.min(Math.max(input.limit ?? 50, 1), 200)) as SessionDecisionRow[];
    return { outcome: "session_decisions", items: rows.map(toDecision), pendingCount };
  }

  public countPending(projectId?: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM session_decisions d
           JOIN projects p ON p.id = d.project_id
           JOIN sessions s ON s.id = d.session_id
           WHERE p.status = 'tracked' AND s.voided_at IS NULL
             AND d.origin = 'agent_autonomous' AND d.review_status = 'pending'
             ${projectId ? "AND d.project_id = ?" : ""}`,
        )
        .get(...(projectId ? [projectId] : [])) as { count: number }
    ).count;
  }

  public review(input: ReviewSessionDecisionInput): ReviewSessionDecisionResult {
    const policy = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!policy.allowed || !policy.project) {
      return {
        outcome: "skipped",
        decisionId: input.decisionId,
        projectStatus: policy.projectStatus,
        reason: policy.reason ?? "Project recording is not enabled.",
      };
    }
    const projectId = policy.project.id;
    return runImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM session_decisions WHERE id = ? AND project_id = ?")
        .get(input.decisionId, projectId) as SessionDecisionRow | undefined;
      if (!row || row.origin !== "agent_autonomous") {
        return { outcome: "not_found", decisionId: input.decisionId };
      }
      if (input.reviewStatus === "promoted") {
        const knowledge = this.db
          .prepare("SELECT id FROM knowledge WHERE id = ? AND project_id = ? AND session_id = ?")
          .get(input.knowledgeId, row.project_id, row.session_id);
        if (!knowledge) {
          return { outcome: "not_found", decisionId: input.decisionId };
        }
      }
      const nextKnowledgeId = input.reviewStatus === "promoted" ? input.knowledgeId : null;
      if (row.review_status === input.reviewStatus && row.knowledge_id === nextKnowledgeId) {
        return { outcome: "session_decision_reviewed", decision: toDecision(row), duplicate: true };
      }
      const reviewedAt = nowIso();
      this.db
        .prepare("UPDATE session_decisions SET review_status = ?, reviewed_at = ?, knowledge_id = ? WHERE id = ?")
        .run(input.reviewStatus, reviewedAt, nextKnowledgeId ?? null, input.decisionId);
      const updated = this.db.prepare("SELECT * FROM session_decisions WHERE id = ?").get(input.decisionId) as
        SessionDecisionRow | undefined;
      if (!updated) return { outcome: "not_found", decisionId: input.decisionId };
      return { outcome: "session_decision_reviewed", decision: toDecision(updated), duplicate: false };
    });
  }
}
