import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidate,
  KnowledgeCandidateContextResult,
  KnowledgeCandidateInput,
  KnowledgeCandidateListResult,
  KnowledgeCandidateRequest,
  KnowledgeCandidateRequestStatus,
  KnowledgeCandidateSkippedResult,
  KnowledgeCandidateStatus,
  KnowledgeKind,
  PolicyDecision,
  ProjectRecord,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  RequestKnowledgeCandidatesResult,
  SubmitKnowledgeCandidatesResult,
  WorkSummarySections,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { runImmediateTransaction } from "./sqlite-transaction.js";

const MAX_SOURCE_SESSIONS = 10;
const HANDOFF_BUDGET = 40_000;
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const OPEN_STATUSES: readonly KnowledgeCandidateRequestStatus[] = ["pending", "processing", "failed"];

interface Dependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
  recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult;
}

type RequestRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  status: KnowledgeCandidateRequestStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  source_session_ids_json: string;
  candidate_count: number;
};

type CandidateRow = {
  id: string;
  request_id: string;
  project_id: string;
  project_name: string | null;
  session_id: string | null;
  session_title: string | null;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags_json: string;
  references_json: string;
  applies_to_json: string;
  rationale: string;
  status: KnowledgeCandidateStatus;
  knowledge_id: string | null;
  created_at: string;
  decided_at: string | null;
};

function parseList(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function cleanList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function toRequest(row: RequestRow): KnowledgeCandidateRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.project_name ? { projectName: row.project_name } : {}),
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    sourceSessionIds: parseList(row.source_session_ids_json),
    candidateCount: row.candidate_count,
  };
}

function toCandidate(row: CandidateRow): KnowledgeCandidate {
  return {
    id: row.id,
    requestId: row.request_id,
    projectId: row.project_id,
    ...(row.project_name ? { projectName: row.project_name } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseList(row.tags_json),
    references: parseList(row.references_json),
    appliesTo: parseList(row.applies_to_json),
    rationale: row.rationale,
    status: row.status,
    ...(row.knowledge_id ? { knowledgeId: row.knowledge_id } : {}),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  };
}

function skipped(decision: PolicyDecision): KnowledgeCandidateSkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

const REQUEST_SELECT = `SELECT r.*, p.name AS project_name
  FROM knowledge_candidate_requests r JOIN projects p ON p.id = r.project_id`;
const CANDIDATE_SELECT = `SELECT c.*, p.name AS project_name, s.title AS session_title
  FROM knowledge_candidates c
  JOIN projects p ON p.id = c.project_id
  LEFT JOIN sessions s ON s.id = c.session_id`;

/**
 * Agent-proposed Knowledge. An Agent reads a request's source Sessions and submits candidates;
 * candidates become Knowledge only when a person accepts them, so Knowledge stays explicitly committed.
 */
export class KnowledgeCandidateService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Dependencies,
  ) {}

  /** Opens (or returns the open) request for Sessions of the project that no earlier request covered. */
  public request(projectRoot: string): RequestKnowledgeCandidatesResult {
    const decision = this.dependencies.checkProjectRoot(projectRoot);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    const project = decision.project;
    this.recoverStale();
    return runImmediateTransaction(this.db, () => {
      const open = this.db
        .prepare(
          `${REQUEST_SELECT} WHERE r.project_id = ? AND r.status IN ('pending', 'processing', 'failed')
           ORDER BY r.requested_at DESC LIMIT 1`,
        )
        .get(project.id) as RequestRow | undefined;
      if (open) {
        return { outcome: "knowledge_candidate_request", duplicate: true, request: toRequest(open) };
      }
      const sourceSessionIds = this.uncoveredSessionIds(project);
      if (sourceSessionIds.length === 0) {
        return {
          outcome: "knowledge_candidates_not_needed",
          reason: "這個專案的 Session 都已整理過 Knowledge 候選。",
        };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO knowledge_candidate_requests (id, project_id, status, requested_at, source_session_ids_json)
           VALUES (?, ?, 'pending', ?, ?)`,
        )
        .run(id, project.id, nowIso(), JSON.stringify(sourceSessionIds));
      return { outcome: "knowledge_candidate_request", duplicate: false, request: this.getRequest(id)! };
    });
  }

  /**
   * Starts (or resumes) processing: returns the request's source Sessions with bounded handoff text
   * and the project's active Knowledge titles. Uses the newest open request when none is named.
   */
  public context(input: { requestId?: string; projectRoot?: string }): KnowledgeCandidateContextResult {
    this.recoverStale();
    const request = this.resolveRequest(input);
    if ("outcome" in request) {
      return request;
    }
    if (!OPEN_STATUSES.includes(request.status)) {
      return { outcome: "request_not_open", request, reason: "This request is already completed or cancelled." };
    }
    this.db
      .prepare(
        "UPDATE knowledge_candidate_requests SET status = 'processing', started_at = ?, failure_reason = NULL WHERE id = ?",
      )
      .run(nowIso(), request.id);
    const perSessionBudget = Math.floor(HANDOFF_BUDGET / Math.max(request.sourceSessionIds.length, 1));
    const sessions = request.sourceSessionIds.flatMap((sessionId) => {
      const row = this.db
        .prepare(
          `SELECT id, title, summary, completed_at, work_summary_json FROM sessions
           WHERE id = ? AND voided_at IS NULL`,
        )
        .get(sessionId) as
        | { id: string; title: string; summary: string; completed_at: string; work_summary_json: string | null }
        | undefined;
      if (!row) {
        return [];
      }
      const handoff = (
        this.db
          .prepare("SELECT content FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC")
          .all(sessionId) as Array<{ content: string }>
      )
        .map((snapshot) => snapshot.content)
        .join("\n\n");
      let workSummary: WorkSummarySections | undefined;
      try {
        const parsed = JSON.parse(row.work_summary_json ?? "{}") as Partial<WorkSummarySections>;
        workSummary = Array.isArray(parsed.outcomes) ? (parsed as WorkSummarySections) : undefined;
      } catch {
        workSummary = undefined;
      }
      return [
        {
          id: row.id,
          title: row.title,
          summary: row.summary,
          completedAt: row.completed_at,
          ...(workSummary ? { workSummary } : {}),
          ...(handoff ? { handoff: handoff.slice(0, perSessionBudget) } : {}),
          ...(handoff.length > perSessionBudget ? { handoffTruncated: true } : {}),
        },
      ];
    });
    const existingKnowledge = this.db
      .prepare(
        "SELECT id, kind, title FROM knowledge WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 200",
      )
      .all(request.projectId) as Array<{ id: string; kind: KnowledgeKind; title: string }>;
    return {
      outcome: "knowledge_candidate_context",
      request: this.getRequest(request.id)!,
      sessions,
      existingKnowledge: existingKnowledge.map((item) => ({ id: item.id, kind: item.kind, title: item.title })),
    };
  }

  /** Stores the Agent's proposals (possibly none) and completes the request. */
  public submit(input: { requestId: string; candidates: KnowledgeCandidateInput[] }): SubmitKnowledgeCandidatesResult {
    const request = this.getRequest(input.requestId);
    if (!request) {
      return {
        outcome: "not_found",
        requestId: input.requestId,
        reason: "Knowledge candidate request does not exist.",
      };
    }
    const decision = this.dependencies.checkProjectById(request.projectId);
    if (!decision.allowed) {
      return skipped(decision);
    }
    if (!OPEN_STATUSES.includes(request.status)) {
      return { outcome: "request_not_open", request, reason: "This request is already completed or cancelled." };
    }
    const sources = new Set(request.sourceSessionIds);
    const outside = input.candidates.find((candidate) => !sources.has(candidate.sourceSessionId));
    if (outside) {
      return {
        outcome: "invalid_candidates",
        reason: `sourceSessionId ${outside.sourceSessionId} is not one of this request's source Sessions.`,
      };
    }
    return runImmediateTransaction(this.db, () => {
      const createdAt = nowIso();
      const insert = this.db.prepare(
        `INSERT INTO knowledge_candidates (
           id, request_id, project_id, session_id, kind, title, body, tags_json, references_json,
           applies_to_json, rationale, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      );
      const ids = input.candidates.map((candidate) => {
        const id = randomUUID();
        insert.run(
          id,
          request.id,
          request.projectId,
          candidate.sourceSessionId,
          candidate.kind,
          candidate.title.trim(),
          candidate.body.trim(),
          JSON.stringify(cleanList(candidate.tags)),
          JSON.stringify(cleanList(candidate.references)),
          JSON.stringify(cleanList(candidate.appliesTo)),
          candidate.rationale.trim(),
          createdAt,
        );
        return id;
      });
      this.db
        .prepare(
          `UPDATE knowledge_candidate_requests
           SET status = 'completed', completed_at = ?, candidate_count = ?, failure_reason = NULL WHERE id = ?`,
        )
        .run(createdAt, ids.length, request.id);
      return {
        outcome: "knowledge_candidates_submitted",
        request: this.getRequest(request.id)!,
        candidates: ids.map((id) => this.getCandidate(id)!),
      };
    });
  }

  public list(input: { projectRoot?: string; status?: KnowledgeCandidateStatus }): KnowledgeCandidateListResult {
    let projectId: string | undefined;
    if (input.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return skipped(decision);
      }
      projectId = decision.project.id;
    }
    this.recoverStale();
    const scope = projectId ? "AND p.id = ?" : "";
    const parameters = projectId ? [projectId] : [];
    const items = (
      this.db
        .prepare(
          `${CANDIDATE_SELECT} WHERE p.status = 'tracked' AND c.status = ? ${scope}
           ORDER BY c.created_at DESC, c.id ASC LIMIT 200`,
        )
        .all(input.status ?? "proposed", ...parameters) as CandidateRow[]
    ).map(toCandidate);
    const openRequests = (
      this.db
        .prepare(
          `${REQUEST_SELECT} WHERE p.status = 'tracked' AND r.status IN ('pending', 'processing', 'failed') ${scope}
           ORDER BY r.requested_at DESC`,
        )
        .all(...parameters) as RequestRow[]
    ).map(toRequest);
    return { outcome: "knowledge_candidates", items, openRequests };
  }

  /** Accepting records the (optionally edited) candidate as Knowledge linked to its source Session. */
  public decide(input: DecideKnowledgeCandidateInput): DecideKnowledgeCandidateResult {
    const candidate = this.getCandidate(input.candidateId);
    if (!candidate) {
      return { outcome: "not_found", candidateId: input.candidateId };
    }
    const decision = this.dependencies.checkProjectById(candidate.projectId);
    if (!decision.allowed || !decision.project) {
      return skipped(decision);
    }
    if (candidate.status !== "proposed") {
      return { outcome: "already_decided", candidate };
    }
    const decidedAt = nowIso();
    if (input.decision === "reject") {
      this.db
        .prepare("UPDATE knowledge_candidates SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(decidedAt, candidate.id);
      return { outcome: "knowledge_candidate_decided", candidate: this.getCandidate(candidate.id)! };
    }
    const edits = input.edits ?? {};
    const recorded = this.dependencies.recordKnowledge({
      projectRoot: decision.project.rootPath,
      idempotencyKey: `knowledge-candidate-${candidate.id}`,
      kind: edits.kind ?? candidate.kind,
      title: edits.title?.trim() || candidate.title,
      body: edits.body?.trim() || candidate.body,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      tags: edits.tags ?? candidate.tags,
      references: edits.references ?? candidate.references,
      appliesTo: edits.appliesTo ?? candidate.appliesTo,
    });
    if (recorded.outcome !== "knowledge_recorded") {
      return recorded.outcome === "skipped"
        ? {
            outcome: "skipped",
            projectRoot: recorded.projectRoot,
            projectStatus: recorded.projectStatus,
            reason: recorded.reason,
          }
        : { outcome: "not_found", candidateId: candidate.id };
    }
    this.db
      .prepare("UPDATE knowledge_candidates SET status = 'accepted', decided_at = ?, knowledge_id = ? WHERE id = ?")
      .run(decidedAt, recorded.knowledge.id, candidate.id);
    return {
      outcome: "knowledge_candidate_decided",
      candidate: this.getCandidate(candidate.id)!,
      knowledge: recorded.knowledge,
    };
  }

  /** Open requests for context: pending, processing, or failed (retryable), newest first. */
  public openRequests(projectId?: string, limit = 5): KnowledgeCandidateRequest[] {
    this.recoverStale();
    return (
      this.db
        .prepare(
          `${REQUEST_SELECT} WHERE p.status = 'tracked' AND r.status IN ('pending', 'processing')
           ${projectId ? "AND p.id = ?" : ""} ORDER BY r.requested_at DESC LIMIT ?`,
        )
        .all(...(projectId ? [projectId] : []), limit) as RequestRow[]
    ).map(toRequest);
  }

  private uncoveredSessionIds(project: ProjectRecord): string[] {
    return (
      this.db
        .prepare(
          `SELECT s.id FROM sessions s
           WHERE s.project_id = ? AND s.voided_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM knowledge_candidate_requests r, json_each(r.source_session_ids_json) j
               WHERE r.project_id = s.project_id AND r.status <> 'cancelled' AND j.value = s.id
             )
           ORDER BY s.completed_at DESC, s.id DESC LIMIT ?`,
        )
        .all(project.id, MAX_SOURCE_SESSIONS) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  private resolveRequest(input: {
    requestId?: string;
    projectRoot?: string;
  }):
    | KnowledgeCandidateRequest
    | Exclude<KnowledgeCandidateContextResult, { outcome: "knowledge_candidate_context" | "request_not_open" }> {
    let request: KnowledgeCandidateRequest | undefined;
    if (input.requestId) {
      request = this.getRequest(input.requestId);
    } else if (input.projectRoot) {
      const decision = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!decision.allowed || !decision.project) {
        return skipped(decision);
      }
      const row = this.db
        .prepare(
          `${REQUEST_SELECT} WHERE r.project_id = ? AND r.status IN ('pending', 'processing', 'failed')
           ORDER BY r.requested_at DESC LIMIT 1`,
        )
        .get(decision.project.id) as RequestRow | undefined;
      request = row ? toRequest(row) : undefined;
    }
    if (!request) {
      return { outcome: "not_found", requestId: input.requestId, reason: "No open Knowledge candidate request." };
    }
    const decision = this.dependencies.checkProjectById(request.projectId);
    return decision.allowed ? request : skipped(decision);
  }

  private getRequest(id: string): KnowledgeCandidateRequest | undefined {
    const row = this.db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;
    return row ? toRequest(row) : undefined;
  }

  private getCandidate(id: string): KnowledgeCandidate | undefined {
    const row = this.db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : undefined;
  }

  /** Processing requests abandoned for 30 minutes become failed, which an Agent can pick up again. */
  private recoverStale(now = Date.now()): void {
    const cutoff = new Date(now - PROCESSING_TIMEOUT_MS).toISOString();
    this.db
      .prepare(
        `UPDATE knowledge_candidate_requests
         SET status = 'failed', failure_reason = 'Knowledge 候選整理超過 30 分鐘仍未完成，可重新處理。'
         WHERE status = 'processing' AND started_at IS NOT NULL AND started_at <= ?`,
      )
      .run(cutoff);
  }
}
