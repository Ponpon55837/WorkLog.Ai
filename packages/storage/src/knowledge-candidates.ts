import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidate,
  KnowledgeCandidateContextResult,
  KnowledgeCandidateBacklog,
  KnowledgeCandidateContext,
  KnowledgeCandidateInput,
  KnowledgeCandidateListResult,
  KnowledgeCandidateRequest,
  KnowledgeCandidateRequestStatus,
  KnowledgeCandidateSkippedResult,
  KnowledgeCandidateStatus,
  KnowledgeKind,
  PolicyDecision,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  RequestKnowledgeCandidatesResult,
  SubmitKnowledgeCandidatesResult,
  WorkSummarySections,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { DataRevisionCache } from "./data-revision-cache.js";
import {
  type BacklogCounts,
  CONTEXT_BACKLOG_MIN_DAYS_SINCE_REQUEST,
  CONTEXT_BACKLOG_MIN_HIGH_VALUE,
  loadUncoveredBacklogSessions,
  selectTopBacklogSessions,
  summarizeBacklog,
  summarizeBacklogByProject,
} from "./knowledge-candidate-backlog.js";
import {
  findKnowledgeCandidateOverlaps,
  parseStoredOverlaps,
  resolveStoredOverlaps,
  storedOverlapsJson,
} from "./knowledge-candidate-overlap.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { combineRedactionSummaries, redactValue } from "./secret-redaction.js";

const MAX_SOURCE_SESSIONS = 10;
/** existingKnowledge caps per status, newest first: titles only, so the whole list stays a few thousand characters. */
const EXISTING_KNOWLEDGE_LIMITS = { active: 150, archived: 30, rejected: 20 } as const;
const HANDOFF_BUDGET = 40_000;
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const OPEN_STATUSES: readonly KnowledgeCandidateRequestStatus[] = ["pending", "processing", "failed"];
const DAY_MS = 24 * 60 * 60 * 1000;

interface RequestInfo {
  hasOpenRequest: boolean;
  lastRequestedAt: string | undefined;
}

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

type TitleRow = { id: string; kind: KnowledgeKind; title: string; total: number };

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
  overlaps_json: string | null;
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

/** Advisories are listed only when there is one, so a candidate without matches looks as it always did. */
function withOverlapList(
  candidate: KnowledgeCandidate,
  overlaps: KnowledgeCandidate["overlaps"] | undefined,
): KnowledgeCandidate {
  return overlaps?.length ? { ...candidate, overlaps } : candidate;
}

/** The stored form of a submitted candidate, for recognising a resubmission of the same payload. */
function candidateFingerprint(candidate: {
  sourceSessionId?: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  references: string[];
  appliesTo: string[];
  rationale: string;
}): string {
  return JSON.stringify([
    candidate.sourceSessionId ?? null,
    candidate.kind,
    candidate.title,
    candidate.body,
    candidate.tags,
    candidate.references,
    candidate.appliesTo,
    candidate.rationale,
  ]);
}

function sanitizeCandidate(candidate: KnowledgeCandidateInput) {
  return redactValue({
    ...candidate,
    title: candidate.title.trim(),
    body: candidate.body.trim(),
    tags: cleanList(candidate.tags),
    references: cleanList(candidate.references),
    appliesTo: cleanList(candidate.appliesTo),
    rationale: candidate.rationale.trim(),
  });
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
  // Scoring scans every uncovered Session of the project, and getContext asks on every call.
  private readonly backlogSnapshots: DataRevisionCache<BacklogCounts>;
  private readonly requestInfos: DataRevisionCache<RequestInfo>;
  // The Web list asks on every refresh; keyed by project id, or "" for every tracked project.
  private readonly listedBacklogs: DataRevisionCache<KnowledgeCandidateBacklog[]>;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Dependencies,
  ) {
    this.backlogSnapshots = new DataRevisionCache(db);
    this.requestInfos = new DataRevisionCache(db);
    this.listedBacklogs = new DataRevisionCache(db);
  }

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
      const uncovered = loadUncoveredBacklogSessions(this.db, project.id);
      const sourceSessionIds = selectTopBacklogSessions(uncovered, MAX_SOURCE_SESSIONS).map((session) => session.id);
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
      const { uncoveredSessions, highValueSessions } = summarizeBacklog(uncovered, new Set(sourceSessionIds));
      return {
        outcome: "knowledge_candidate_request",
        duplicate: false,
        request: this.getRequest(id)!,
        remaining: { uncoveredSessions, highValueSessions },
      };
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
      let workSummary: KnowledgeCandidateContext["sessions"][number]["workSummary"];
      try {
        const parsed = JSON.parse(row.work_summary_json ?? "{}") as Partial<WorkSummarySections>;
        workSummary = Array.isArray(parsed.outcomes)
          ? { outcomes: parsed.outcomes, decisions: parsed.decisions ?? [], nextSteps: parsed.nextSteps ?? [] }
          : undefined;
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
    const { existingKnowledge, omitted } = this.existingKnowledge(request.projectId);
    return {
      outcome: "knowledge_candidate_context",
      request: this.getRequest(request.id)!,
      sessions,
      omittedWorkSummarySections: ["scope", "verification"],
      sessionReadWith: "work_get_session",
      existingKnowledge,
      ...(omitted > 0 ? { existingKnowledgeOmitted: omitted } : {}),
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
      return (
        this.replaySubmission(request, input.candidates) ?? {
          outcome: "request_not_open",
          request,
          reason: "This request is already completed or cancelled.",
        }
      );
    }
    const sources = new Set(request.sourceSessionIds);
    const outside = input.candidates.find((candidate) => !sources.has(candidate.sourceSessionId));
    if (outside) {
      return {
        outcome: "invalid_candidates",
        reason: `sourceSessionId ${outside.sourceSessionId} is not one of this request's source Sessions.`,
      };
    }
    const sanitizedCandidates = input.candidates.map(sanitizeCandidate);
    const redactions = combineRedactionSummaries(...sanitizedCandidates.map((candidate) => candidate.redactions));
    const createdAt = nowIso();
    // Advisories only read, so they are computed before the write lock. Records created after createdAt never
    // compare, so the stored advisory is what a later replay returns.
    const overlaps = findKnowledgeCandidateOverlaps(
      this.db,
      { projectId: request.projectId, requestId: request.id, createdAtOrBefore: createdAt },
      sanitizedCandidates.map((candidate) => candidate.value),
    );
    const ids = runImmediateTransaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO knowledge_candidates (
           id, request_id, project_id, session_id, kind, title, body, tags_json, references_json,
           applies_to_json, rationale, status, created_at, overlaps_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      );
      const storedIds = sanitizedCandidates.map(({ value: candidate }, index) => {
        const id = randomUUID();
        insert.run(
          id,
          request.id,
          request.projectId,
          candidate.sourceSessionId,
          candidate.kind,
          candidate.title,
          candidate.body,
          JSON.stringify(candidate.tags),
          JSON.stringify(candidate.references),
          JSON.stringify(candidate.appliesTo),
          candidate.rationale,
          createdAt,
          storedOverlapsJson(overlaps[index] ?? []),
        );
        return id;
      });
      this.db
        .prepare(
          `UPDATE knowledge_candidate_requests
           SET status = 'completed', completed_at = ?, candidate_count = ?, failure_reason = NULL WHERE id = ?`,
        )
        .run(createdAt, storedIds.length, request.id);
      return storedIds;
    });
    return {
      outcome: "knowledge_candidates_submitted",
      request: this.getRequest(request.id)!,
      candidates: ids.map((id, index) => withOverlapList(this.getCandidate(id)!, overlaps[index])),
      redactions,
    };
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
    const items = this.withStoredOverlaps(
      this.db
        .prepare(
          `${CANDIDATE_SELECT} WHERE p.status = 'tracked' AND c.status = ? ${scope}
           ORDER BY c.created_at DESC, c.id ASC LIMIT 200`,
        )
        .all(input.status ?? "proposed", ...parameters) as CandidateRow[],
    );
    const openRequests = (
      this.db
        .prepare(
          `${REQUEST_SELECT} WHERE p.status = 'tracked' AND r.status IN ('pending', 'processing', 'failed') ${scope}
           ORDER BY r.requested_at DESC`,
        )
        .all(...parameters) as RequestRow[]
    ).map(toRequest);
    const backlog = this.listedBacklogs.get(projectId ?? "", () =>
      summarizeBacklogByProject(loadUncoveredBacklogSessions(this.db, projectId)).filter(
        (counts) => counts.uncoveredSessions > 0,
      ),
    );
    return { outcome: "knowledge_candidates", items, openRequests, backlog };
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
          `${REQUEST_SELECT} WHERE p.status = 'tracked' AND r.status IN ('pending', 'processing', 'failed')
           ${projectId ? "AND p.id = ?" : ""} ORDER BY r.requested_at DESC LIMIT ?`,
        )
        .all(...(projectId ? [projectId] : []), limit) as RequestRow[]
    ).map(toRequest);
  }

  /**
   * The unreviewed-Session backlog worth telling an Agent about, for a project the caller has already admitted
   * through the policy gate. Undefined while a request is open, below the high-value threshold, or when the
   * project's last request is recent. Reuses a snapshot until the data revision moves, so a repeated getContext
   * costs only the revision read.
   */
  public contextBacklog(projectId: string, now = Date.now()): KnowledgeCandidateBacklog | undefined {
    // The cheap request row alone decides visibility, so a recent or open request never pays for scoring.
    const requests = this.requestInfo(projectId);
    if (requests.hasOpenRequest) {
      return undefined;
    }
    if (
      requests.lastRequestedAt !== undefined &&
      now - Date.parse(requests.lastRequestedAt) <= CONTEXT_BACKLOG_MIN_DAYS_SINCE_REQUEST * DAY_MS
    ) {
      return undefined;
    }
    // The hint is advisory and part of a read-only context: a failure of its signals (for example the passive
    // read audit table) must never fail the context.
    let counts: BacklogCounts;
    try {
      counts = this.backlogCounts(projectId);
    } catch {
      return undefined;
    }
    return counts.highValueSessions < CONTEXT_BACKLOG_MIN_HIGH_VALUE ? undefined : { projectId, ...counts };
  }

  /** Active Knowledge, archived Knowledge, and rejected candidates of one project, titles only. */
  private existingKnowledge(projectId: string): {
    existingKnowledge: KnowledgeCandidateContext["existingKnowledge"];
    omitted: number;
  } {
    const select = (sql: string, limit: number): TitleRow[] => this.db.prepare(sql).all(projectId, limit) as TitleRow[];
    const groups: Array<{ status?: "archived" | "rejected"; rows: TitleRow[]; limit: number }> = [
      {
        rows: select(
          `SELECT id, kind, title, COUNT(*) OVER () AS total FROM knowledge
           WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC, id ASC LIMIT ?`,
          EXISTING_KNOWLEDGE_LIMITS.active,
        ),
        limit: EXISTING_KNOWLEDGE_LIMITS.active,
      },
      {
        status: "archived",
        rows: select(
          `SELECT id, kind, title, COUNT(*) OVER () AS total FROM knowledge
           WHERE project_id = ? AND status = 'archived' ORDER BY updated_at DESC, id ASC LIMIT ?`,
          EXISTING_KNOWLEDGE_LIMITS.archived,
        ),
        limit: EXISTING_KNOWLEDGE_LIMITS.archived,
      },
      {
        status: "rejected",
        rows: select(
          `SELECT id, kind, title, COUNT(*) OVER () AS total FROM knowledge_candidates
           WHERE project_id = ? AND status = 'rejected' ORDER BY decided_at DESC, id ASC LIMIT ?`,
          EXISTING_KNOWLEDGE_LIMITS.rejected,
        ),
        limit: EXISTING_KNOWLEDGE_LIMITS.rejected,
      },
    ];
    return {
      existingKnowledge: groups.flatMap(({ status, rows }) =>
        rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, ...(status ? { status } : {}) })),
      ),
      omitted: groups.reduce((sum, { rows }) => sum + Math.max(0, (rows[0]?.total ?? 0) - rows.length), 0),
    };
  }

  /**
   * A completed request resubmitted with the same normalized payload returns what the first submission stored,
   * including its stored advisories, instead of request_not_open. Candidates submitted before schema 33 have none
   * stored; theirs are computed again against the records that existed at the submission, as before.
   */
  private replaySubmission(
    request: KnowledgeCandidateRequest,
    candidates: KnowledgeCandidateInput[],
  ): SubmitKnowledgeCandidatesResult | undefined {
    if (request.status !== "completed") return undefined;
    const rows = this.db
      .prepare(`${CANDIDATE_SELECT} WHERE c.request_id = ? ORDER BY c.rowid ASC`)
      .all(request.id) as CandidateRow[];
    const stored = rows.map(toCandidate);
    const sanitized = candidates.map(sanitizeCandidate);
    const submitted = sanitized.map((candidate) => candidateFingerprint(candidate.value));
    const same =
      stored.length === submitted.length &&
      stored.every(
        (candidate, index) =>
          candidateFingerprint({ ...candidate, sourceSessionId: candidate.sessionId }) === submitted[index],
      );
    if (!same) return undefined;
    const legacy = rows.filter((row) => parseStoredOverlaps(row.overlaps_json) === undefined).map(toCandidate);
    const recomputed = findKnowledgeCandidateOverlaps(
      this.db,
      {
        projectId: request.projectId,
        requestId: request.id,
        createdAtOrBefore: stored[0]?.createdAt ?? request.completedAt ?? nowIso(),
      },
      legacy,
    );
    const legacyOverlaps = new Map(legacy.map((candidate, index) => [candidate.id, recomputed[index]]));
    const storedOverlaps = new Map(this.withStoredOverlaps(rows).map((candidate) => [candidate.id, candidate]));
    return {
      outcome: "knowledge_candidates_submitted",
      duplicate: true,
      request,
      candidates: stored.map((candidate) =>
        legacyOverlaps.has(candidate.id)
          ? withOverlapList(candidate, legacyOverlaps.get(candidate.id))
          : storedOverlaps.get(candidate.id)!,
      ),
      redactions: combineRedactionSummaries(...sanitized.map((candidate) => candidate.redactions)),
    };
  }

  /** Candidates with their stored advisories, the matched titles read in one query per record type. */
  private withStoredOverlaps(rows: readonly CandidateRow[]): KnowledgeCandidate[] {
    const parsed = rows.map((row) => parseStoredOverlaps(row.overlaps_json) ?? []);
    const resolved = resolveStoredOverlaps(
      this.db,
      rows.map((row, index) => ({ projectId: row.project_id, overlaps: parsed[index]! })),
    );
    return rows.map((row, index) => withOverlapList(toCandidate(row), resolved[index]));
  }

  /** The last request time and whether one is open; one indexed aggregate, reused until the data revision moves. */
  private requestInfo(projectId: string): RequestInfo {
    return this.requestInfos.get(projectId, () => {
      const row = this.db
        .prepare(
          `SELECT MAX(requested_at) AS last_requested_at,
                  COALESCE(MAX(status IN ('pending', 'processing', 'failed')), 0) AS has_open
           FROM knowledge_candidate_requests WHERE project_id = ?`,
        )
        .get(projectId) as { last_requested_at: string | null; has_open: number };
      return { hasOpenRequest: row.has_open === 1, lastRequestedAt: row.last_requested_at ?? undefined };
    });
  }

  /** Scores the project's uncovered Sessions; reused until the data revision moves, so a passed window scores once. */
  private backlogCounts(projectId: string): BacklogCounts {
    return this.backlogSnapshots.get(projectId, () =>
      summarizeBacklog(loadUncoveredBacklogSessions(this.db, projectId)),
    );
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
