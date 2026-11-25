import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentReviewContextItem,
  AgentReviewContextQuery,
  AgentReviewContextResult,
  AgentReviewItemKind,
  AgentReviewItemOutcome,
  AgentReviewItemState,
  AgentReviewKnowledgePage,
  AgentReviewRequest,
  AgentReviewRequestListResult,
  AgentReviewRequestQuery,
  AgentReviewRequestStatus,
  AgentReviewSessionContext,
  AgentReviewSkippedResult,
  AgentReviewVerdict,
  AgentReviewVerdictResult,
  CancelAgentReviewRequestResult,
  CreateAgentReviewRequestInput,
  CreateAgentReviewRequestResult,
  KnowledgeStatus,
  OverturnAgentReviewInput,
  OverturnAgentReviewResult,
  PolicyDecision,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  RedactionSummary,
  RequestAgentReviewInput,
  RequestAgentReviewResult,
  SubmitAgentReviewVerdictsInput,
  SubmitAgentReviewVerdictsResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { CANDIDATE_SELECT, loadExistingKnowledge, toCandidate, type CandidateRow } from "./knowledge-candidates.js";
import {
  findKnowledgeCandidateOverlaps,
  parseStoredOverlaps,
  resolveStoredOverlaps,
} from "./knowledge-candidate-overlap.js";
import { createPageInfo } from "./pagination.js";
import { combineRedactionSummaries, redactText } from "./secret-redaction.js";
import { isDatabaseSchemaChangedError } from "./schema-write-gate.js";
import { toDecision, type SessionDecisionRow } from "./session-decision-service.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

interface Dependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
  recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult;
  updateKnowledge(input: UpdateKnowledgeInput): UpdateKnowledgeResult;
  pagesCitingSessions(projectId: string, sessionIds: ReadonlySet<string>): Array<{ slug: string; title: string }>;
  pendingPages(projectId: string): Array<{ slug: string; title: string }>;
}

type RequestRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  status: AgentReviewRequestStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  item_count: number;
  omitted_count: number;
};

type RequestCountRow = {
  request_id: string;
  decision_count: number;
  candidate_count: number;
  applied_count: number;
  skipped_count: number;
  open_count: number;
};

type ItemRow = {
  id: string;
  request_id: string;
  project_id: string;
  item_kind: AgentReviewItemKind;
  item_id: string;
  source_session_id: string | null;
  position: number;
  fingerprint: string;
  submission_id: string | null;
  verdict: string | null;
  outcome: AgentReviewItemOutcome | null;
  reason: string | null;
  knowledge_id: string | null;
  decided_at: string | null;
  overturned_at: string | null;
};

type DecisionRow = SessionDecisionRow & { session_voided_at: string | null; session_completed_at: string };

type SessionRow = {
  id: string;
  title: string;
  completed_at: string;
  voided_at: string | null;
  work_summary_json: string | null;
};

type SiblingDecisionRow = { session_id: string; id: string; text: string };

type SubmissionRow = { id: string; payload_hash: string; results_json: string };

type NormalizedVerdict = AgentReviewVerdict & { reason: string };

type PendingRows = {
  items: Map<string, ItemRow>;
  decisions: Map<string, DecisionRow>;
  candidates: Map<string, CandidateRow>;
};

type Decided =
  | { outcome: AgentReviewItemOutcome; knowledgeId?: string; redactions?: RedactionSummary }
  | { outcome: "knowledge_rejected"; knowledgeOutcome: string; knowledgeReason?: string };

type ContextResult = Extract<AgentReviewContextResult, { outcome: "agent_review_context" }>;

const MAX_SNAPSHOT_ITEMS = 500;
const CONTEXT_BUDGET = 24_000;
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COMPLETION_PAGES = 12;
const OPEN_STATUSES = "('pending', 'processing', 'failed')";
const OPEN_STATUS_LIST: readonly AgentReviewRequestStatus[] = ["pending", "processing", "failed"];
const SESSION_TITLE_LIMIT = 160;
const SESSION_OUTCOMES_SHOWN = 3;
const SESSION_OUTCOME_LIMIT = 240;
const SIBLING_DECISIONS_SHOWN = 5;
const SIBLING_DECISION_LIMIT = 240;
const BODY_LIMIT = 2_000;
const RATIONALE_LIMIT = 600;
const EXISTING_TITLE_LIMIT = 120;
const KNOWLEDGE_REASON_LIMIT = 200;
const CONTEXT_HINT =
  "逐項核對 open 項目的來源 Session 後，用 work_submit_agent_review 提交 verdict；理由要具體，" +
  "證據不足的項目不提交，留給使用者。已有結果、stale 或已被審查的項目不需處理。verdict 直接生效，使用者之後可以推翻。";
const REQUEST_SELECT = `SELECT r.*, p.name AS project_name
  FROM agent_review_requests r JOIN projects p ON p.id = r.project_id`;

function bounded(value: string, limit: number): { text: string; truncated: boolean } {
  return { text: value.slice(0, limit), truncated: value.length > limit };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decisionFingerprint(row: DecisionRow): string {
  return hashJson([
    row.text,
    row.origin,
    row.review_status,
    row.reviewed_at,
    row.knowledge_id,
    row.session_voided_at !== null,
  ]);
}

function candidateFingerprint(row: CandidateRow): string {
  return hashJson([
    row.kind,
    row.title,
    row.body,
    row.tags_json,
    row.references_json,
    row.applies_to_json,
    row.rationale,
    row.status,
    row.knowledge_id,
  ]);
}

function itemKey(kind: AgentReviewItemKind, id: string): string {
  return `${kind}:${id}`;
}

function parseOutcomes(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    const outcomes = (parsed as { outcomes?: unknown }).outcomes;
    return Array.isArray(outcomes) ? outcomes.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function normalizeVerdicts(verdicts: readonly AgentReviewVerdict[]): NormalizedVerdict[] {
  return verdicts
    .map((verdict): NormalizedVerdict => ({ ...verdict, reason: verdict.reason.trim() }))
    .sort((left, right) => itemKey(left.itemKind, left.itemId).localeCompare(itemKey(right.itemKind, right.itemId)));
}

function skippedByRoot(decision: PolicyDecision): AgentReviewSkippedResult {
  return {
    outcome: "skipped",
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

function skippedById(projectId: string, decision: PolicyDecision): AgentReviewSkippedResult {
  return {
    outcome: "skipped",
    projectId,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

function isOpen(status: AgentReviewRequestStatus): boolean {
  return OPEN_STATUS_LIST.includes(status);
}

function itemState(
  item: ItemRow,
  decision: DecisionRow | undefined,
  candidate: CandidateRow | undefined,
): AgentReviewItemState {
  if (item.outcome === "applied") return "applied";
  if (item.outcome) return "skipped";
  const current = item.item_kind === "decision" ? decision : candidate;
  if (!current) return "stale";
  const pending = decision ? decision.review_status === "pending" : candidate?.status === "proposed";
  if (!pending) return "reviewed";
  return (decision ? decisionFingerprint(decision) : candidateFingerprint(candidate!)) === item.fingerprint
    ? "open"
    : "stale";
}

/** A failed Knowledge write keeps its item open; only the outcome code and a short reason are reported. */
function knowledgeRejected(recorded: Exclude<RecordKnowledgeResult, { outcome: "knowledge_recorded" }>): Decided {
  return {
    outcome: "knowledge_rejected",
    knowledgeOutcome: recorded.outcome,
    ...("reason" in recorded && recorded.reason
      ? { knowledgeReason: recorded.reason.slice(0, KNOWLEDGE_REASON_LIMIT) }
      : {}),
  };
}

/** Shortens every free-text field of a page to `limit` characters; ids, kinds and states are never touched. */
function shortenContext(result: ContextResult, limit: number): void {
  const cut = (value: string): string => (value.length > limit ? value.slice(0, limit) : value);
  for (const item of result.items) {
    if (item.text !== undefined && item.text.length > limit) {
      item.text = cut(item.text);
      item.textTruncated = true;
    }
    if (item.title !== undefined && item.title.length > limit) {
      item.title = cut(item.title);
      item.titleTruncated = true;
    }
    if (item.body !== undefined && item.body.length > limit) {
      item.body = cut(item.body);
      item.bodyTruncated = true;
    }
    if (item.rationale !== undefined && item.rationale.length > limit) {
      item.rationale = cut(item.rationale);
      item.rationaleTruncated = true;
    }
    for (const overlap of item.overlaps) {
      if (overlap.title && overlap.title.length > limit) overlap.title = cut(overlap.title);
    }
    const session = item.sourceSession;
    if (!session) continue;
    if (session.title.length > limit) {
      session.title = cut(session.title);
      session.titleTruncated = true;
    }
    if (session.outcomes.some((outcome) => outcome.length > limit)) {
      session.outcomes = session.outcomes.map(cut);
      session.outcomesTruncated = true;
    }
    if (session.otherDecisions.some((decision) => decision.length > limit)) {
      session.otherDecisions = session.otherDecisions.map(cut);
      session.otherDecisionsTruncated = true;
    }
  }
  result.truncated = true;
}

/**
 * Agent review: an Agent judges the pending Agent decisions and proposed Knowledge candidates a user snapshotted into
 * a request. Verdicts apply directly and are attributed to the Agent, so a person can overturn them later; without an
 * open request Agent writes are refused.
 */
export class AgentReviewService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: Dependencies,
  ) {}

  public listRequests(input: AgentReviewRequestQuery = {}): AgentReviewRequestListResult {
    this.recoverStale();
    if (input.projectId) {
      const policy = this.dependencies.checkProjectById(input.projectId);
      if (!policy.allowed) return skippedById(input.projectId, policy);
    }
    const where = `WHERE p.status = 'tracked' ${input.projectId ? "AND r.project_id = ?" : ""} ${input.status ? "AND r.status = ?" : ""}`;
    const parameters = [...(input.projectId ? [input.projectId] : []), ...(input.status ? [input.status] : [])];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_review_requests r JOIN projects p ON p.id = r.project_id ${where}`,
        )
        .get(...parameters) as { count: number }
    ).count;
    const pageInfo = createPageInfo(input.page, input.pageSize ?? 5, total, 20);
    const rows = this.db
      .prepare(`${REQUEST_SELECT} ${where} ORDER BY r.requested_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as RequestRow[];
    return { outcome: "agent_review_requests", requests: this.toRequests(rows), pageInfo };
  }

  /** Web entry: the project is named by id. */
  public create(input: CreateAgentReviewRequestInput): CreateAgentReviewRequestResult {
    const policy = this.dependencies.checkProjectById(input.projectId);
    if (!policy.allowed) return skippedById(input.projectId, policy);
    return this.open(input.projectId, input.idempotencyKey);
  }

  /** Agent entry: the project is named by its root. An already open request is returned, not rejected. */
  public requestForRoot(input: RequestAgentReviewInput): RequestAgentReviewResult {
    const policy = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!policy.allowed || !policy.project) return skippedByRoot(policy);
    return this.open(policy.project.id, input.idempotencyKey);
  }

  /** Claims the request (processing) and returns one page of its snapshot, newest state read in batches. */
  public context(input: AgentReviewContextQuery): AgentReviewContextResult {
    this.recoverStale();
    const resolved = this.resolve(input);
    if ("outcome" in resolved) return resolved;
    const requestRow = resolved;
    if (!isOpen(requestRow.status)) {
      return {
        outcome: "request_not_open",
        request: this.toRequests([requestRow])[0]!,
        reason: "This request is already completed or cancelled.",
      };
    }
    runImmediateTransaction(this.db, () =>
      this.db
        .prepare(
          `UPDATE agent_review_requests SET status = 'processing', started_at = ?, failure_reason = NULL
           WHERE id = ? AND status IN ${OPEN_STATUSES}`,
        )
        .run(nowIso(), requestRow.id),
    );
    const total = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM agent_review_request_items WHERE request_id = ?")
        .get(requestRow.id) as { count: number }
    ).count;
    const pageInfo = createPageInfo(input.page, input.pageSize ?? 10, total, 10);
    const itemRows = this.db
      .prepare("SELECT * FROM agent_review_request_items WHERE request_id = ? ORDER BY position LIMIT ? OFFSET ?")
      .all(requestRow.id, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as ItemRow[];
    const request = this.request(requestRow.id)!;
    const items = this.contextItems(request, itemRows);
    const result: ContextResult = {
      outcome: "agent_review_context",
      request,
      items,
      pageInfo,
      truncated: items.some(
        (item) =>
          item.textTruncated ||
          item.titleTruncated ||
          item.bodyTruncated ||
          item.rationaleTruncated ||
          item.sourceSession?.titleTruncated ||
          item.sourceSession?.outcomesTruncated ||
          item.sourceSession?.otherDecisionsTruncated,
      ),
      hint: CONTEXT_HINT,
    };
    if (pageInfo.page === 1) {
      const { existingKnowledge, omitted } = loadExistingKnowledge(this.db, request.projectId);
      result.existingKnowledge = existingKnowledge;
      if (omitted > 0) result.existingKnowledgeOmitted = omitted;
    }
    this.fitContext(result);
    if (JSON.stringify(result).length > CONTEXT_BUDGET) {
      return { outcome: "rejected", reason: "context_too_large", requestId: request.id };
    }
    return result;
  }

  public submit(input: SubmitAgentReviewVerdictsInput): SubmitAgentReviewVerdictsResult {
    const row = this.requestRow(input.requestId);
    if (!row) return { outcome: "not_found", requestId: input.requestId };
    const policy = this.dependencies.checkProjectById(row.project_id);
    if (!policy.allowed || !policy.project) return skippedById(row.project_id, policy);
    const normalized = normalizeVerdicts(input.verdicts);
    const hash = hashJson({ verdicts: normalized, complete: input.complete === true });

    const replay = this.replay(row.id, input.idempotencyKey, hash);
    if (replay) return replay;
    this.recoverStale();
    const rootPath = policy.project.rootPath;
    const outcome = runImmediateTransaction(this.db, (): SubmitAgentReviewVerdictsResult | { applied: Applied } => {
      const current = this.requestRow(row.id);
      if (!current) return { outcome: "not_found", requestId: row.id };
      const currentPolicy = this.dependencies.checkProjectById(current.project_id);
      if (!currentPolicy.allowed) return skippedById(current.project_id, currentPolicy);
      const concurrent = this.replay(current.id, input.idempotencyKey, hash);
      if (concurrent) return concurrent;
      if (!isOpen(current.status)) return { outcome: "rejected", reason: "request_not_open", requestId: current.id };
      return { applied: this.apply(current, rootPath, input, normalized, hash) };
    });
    if (!("applied" in outcome)) return outcome;
    const request = this.request(row.id)!;
    return {
      outcome: "agent_review_verdicts_submitted",
      request,
      results: outcome.applied.results,
      duplicate: false,
      ...(outcome.applied.redactions.total > 0 ? { redactions: outcome.applied.redactions } : {}),
      ...(request.status === "completed" ? { completion: { knowledgePages: this.completionPages(request) } } : {}),
    };
  }

  public cancel(requestId: string): CancelAgentReviewRequestResult {
    const row = this.requestRow(requestId);
    if (!row) return { outcome: "not_found", requestId };
    const policy = this.dependencies.checkProjectById(row.project_id);
    if (!policy.allowed) return skippedById(row.project_id, policy);
    return runImmediateTransaction(this.db, () => {
      const current = this.requestRow(requestId);
      if (!current) return { outcome: "not_found", requestId };
      if (current.status === "completed") return { outcome: "rejected", reason: "request_closed", requestId };
      const duplicate = current.status === "cancelled";
      if (!duplicate) {
        this.db
          .prepare("UPDATE agent_review_requests SET status = 'cancelled', completed_at = ? WHERE id = ?")
          .run(nowIso(), requestId);
      }
      return { outcome: "agent_review_request_cancelled", request: this.request(requestId)!, duplicate };
    });
  }

  /** Returns an Agent-reviewed item to the pending inbox and archives the Knowledge the verdict created, if still active. */
  public overturn(input: OverturnAgentReviewInput): OverturnAgentReviewResult {
    const policy = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!policy.allowed || !policy.project) return skippedByRoot(policy);
    const projectId = policy.project.id;
    const projectRoot = policy.project.rootPath;
    return runImmediateTransaction(this.db, (): OverturnAgentReviewResult => {
      const reviewed = this.reviewedByAgent(projectId, input.itemKind, input.itemId);
      if ("outcome" in reviewed) return reviewed;
      const createdKnowledge = reviewed.knowledgeId !== undefined || reviewed.createdKnowledge;
      const knowledge = createdKnowledge
        ? this.archiveCreated(projectId, projectRoot, reviewed.knowledgeId)
        : undefined;
      if (input.itemKind === "decision") {
        this.db
          .prepare(
            `UPDATE session_decisions
             SET review_status = 'pending', reviewed_at = NULL, knowledge_id = NULL, reviewed_by = NULL,
                 review_reason = NULL, review_request_id = NULL
             WHERE id = ?`,
          )
          .run(input.itemId);
      } else {
        this.db
          .prepare(
            `UPDATE knowledge_candidates
             SET status = 'proposed', decided_at = NULL, knowledge_id = NULL, reviewed_by = NULL,
                 review_reason = NULL, review_request_id = NULL
             WHERE id = ?`,
          )
          .run(input.itemId);
      }
      this.db
        .prepare(
          `UPDATE agent_review_request_items SET overturned_at = ?
           WHERE project_id = ? AND item_kind = ? AND item_id = ? AND outcome = 'applied' AND overturned_at IS NULL`,
        )
        .run(nowIso(), projectId, input.itemKind, input.itemId);
      return {
        outcome: "agent_review_overturned",
        itemKind: input.itemKind,
        ...(input.itemKind === "decision"
          ? { decision: toDecision(this.decisionRow(projectId, input.itemId)!) }
          : { candidate: toCandidate(this.candidateRow(projectId, input.itemId)!) }),
        ...(knowledge ? { knowledge } : {}),
      };
    });
  }

  private open(projectId: string, idempotencyKey: string): CreateAgentReviewRequestResult {
    this.recoverStale();
    return runImmediateTransaction(this.db, (): CreateAgentReviewRequestResult => {
      const policy = this.dependencies.checkProjectById(projectId);
      if (!policy.allowed) return skippedById(projectId, policy);
      const previous = this.db
        .prepare("SELECT id, project_id FROM agent_review_requests WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: string; project_id: string } | undefined;
      if (previous) {
        if (previous.project_id !== projectId) return { outcome: "rejected", reason: "idempotency_conflict" };
        return { outcome: "agent_review_request", request: this.request(previous.id)!, duplicate: true };
      }
      const open = this.db
        .prepare(`SELECT id FROM agent_review_requests WHERE project_id = ? AND status IN ${OPEN_STATUSES}`)
        .get(projectId) as { id: string } | undefined;
      if (open) return { outcome: "agent_review_request", request: this.request(open.id)!, duplicate: true };

      const snapshot = this.snapshot(projectId);
      if (snapshot.items.length === 0) {
        return {
          outcome: "agent_review_not_needed",
          projectId,
          reason: "這個專案目前沒有待 Agent 審查的決策或 Knowledge 候選。",
        };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO agent_review_requests (id, project_id, idempotency_key, status, requested_at, item_count, omitted_count)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, projectId, idempotencyKey, nowIso(), snapshot.items.length, snapshot.omitted);
      const insert = this.db.prepare(
        `INSERT INTO agent_review_request_items
           (id, request_id, project_id, item_kind, item_id, source_session_id, position, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      snapshot.items.forEach((item, position) => {
        insert.run(randomUUID(), id, projectId, item.kind, item.id, item.sessionId, position, item.fingerprint);
      });
      return {
        outcome: "agent_review_request",
        request: this.request(id)!,
        duplicate: false,
        ...(snapshot.omitted > 0 ? { remaining: snapshot.omitted } : {}),
      };
    });
  }

  /**
   * Pending Agent decisions of live Sessions first, then proposed candidates, oldest first. An item a person once
   * overturned stays in their own queue, so a later request never hands it to an Agent again.
   */
  private snapshot(projectId: string): {
    items: Array<{ kind: AgentReviewItemKind; id: string; sessionId: string | null; fingerprint: string }>;
    omitted: number;
  } {
    const notOverturned = (kind: AgentReviewItemKind, alias: string): string =>
      `AND NOT EXISTS (
         SELECT 1 FROM agent_review_request_items i
         WHERE i.project_id = ${alias}.project_id AND i.item_kind = '${kind}' AND i.item_id = ${alias}.id
           AND i.overturned_at IS NOT NULL)`;
    const decisionWhere = `d.project_id = ? AND d.origin = 'agent_autonomous' AND d.review_status = 'pending'
      AND s.voided_at IS NULL ${notOverturned("decision", "d")}`;
    const candidateWhere = `c.project_id = ? AND c.status = 'proposed' ${notOverturned("candidate", "c")}`;
    const count = (sql: string): number => (this.db.prepare(sql).get(projectId) as { count: number }).count;
    const decisionTotal = count(
      `SELECT COUNT(*) AS count FROM session_decisions d JOIN sessions s ON s.id = d.session_id WHERE ${decisionWhere}`,
    );
    const candidateTotal = count(`SELECT COUNT(*) AS count FROM knowledge_candidates c WHERE ${candidateWhere}`);
    const decisions = this.db
      .prepare(
        `SELECT d.*, s.voided_at AS session_voided_at, s.completed_at AS session_completed_at
         FROM session_decisions d JOIN sessions s ON s.id = d.session_id
         WHERE ${decisionWhere}
         ORDER BY s.completed_at ASC, d.session_id ASC, d.position ASC LIMIT ?`,
      )
      .all(projectId, MAX_SNAPSHOT_ITEMS) as DecisionRow[];
    const candidates = this.db
      .prepare(
        `SELECT c.*, NULL AS project_name, NULL AS session_title FROM knowledge_candidates c
         WHERE ${candidateWhere} ORDER BY c.created_at ASC, c.id ASC LIMIT ?`,
      )
      .all(projectId, Math.max(MAX_SNAPSHOT_ITEMS - decisions.length, 0)) as CandidateRow[];
    const items = [
      ...decisions.map((row) => ({
        kind: "decision" as const,
        id: row.id,
        sessionId: row.session_id,
        fingerprint: decisionFingerprint(row),
      })),
      ...candidates.map((row) => ({
        kind: "candidate" as const,
        id: row.id,
        sessionId: row.session_id,
        fingerprint: candidateFingerprint(row),
      })),
    ];
    return { items, omitted: decisionTotal + candidateTotal - items.length };
  }

  private contextItems(request: AgentReviewRequest, itemRows: ItemRow[]): AgentReviewContextItem[] {
    const rows = this.currentRows(
      request.projectId,
      itemRows.filter((item) => item.item_kind === "decision").map((item) => item.item_id),
      itemRows.filter((item) => item.item_kind === "candidate").map((item) => item.item_id),
    );
    const states = itemRows.map((item) =>
      itemState(item, rows.decisions.get(item.item_id), rows.candidates.get(item.item_id)),
    );
    const openIndexes = itemRows.flatMap((_, index) => (states[index] === "open" ? [index] : []));
    const sessionIds = [...new Set(openIndexes.flatMap((index) => itemRows[index]!.source_session_id ?? []))];
    const sessions = this.sessions(request.projectId, sessionIds);
    const siblings = this.siblingDecisions(sessionIds);

    const openDecisions = openIndexes.filter((index) => itemRows[index]!.item_kind === "decision");
    const decisionHints = findKnowledgeCandidateOverlaps(
      this.db,
      { projectId: request.projectId, requestId: request.id, createdAtOrBefore: nowIso() },
      openDecisions.map((index) => {
        const text = rows.decisions.get(itemRows[index]!.item_id)!.text;
        return { title: text, body: "" };
      }),
    );
    const openCandidates = openIndexes.filter((index) => itemRows[index]!.item_kind === "candidate");
    const candidateHints = resolveStoredOverlaps(
      this.db,
      openCandidates.map((index) => ({
        projectId: request.projectId,
        overlaps: parseStoredOverlaps(rows.candidates.get(itemRows[index]!.item_id)!.overlaps_json) ?? [],
      })),
    );
    const decisionHintByIndex = new Map(openDecisions.map((index, position) => [index, decisionHints[position] ?? []]));
    const candidateHintByIndex = new Map(openCandidates.map((index, position) => [index, candidateHints[position]!]));

    return itemRows.map((item, index): AgentReviewContextItem => {
      const state = states[index]!;
      const base = { itemKind: item.item_kind, id: item.item_id, state, overlaps: [] };
      if (state !== "open") return base;
      const sourceSession = this.sessionContext(
        item.source_session_id ? sessions.get(item.source_session_id) : undefined,
        item.source_session_id ? (siblings.get(item.source_session_id) ?? []) : [],
        item.item_kind === "decision" ? item.item_id : undefined,
      );
      if (item.item_kind === "decision") {
        const text = bounded(rows.decisions.get(item.item_id)!.text, BODY_LIMIT);
        return {
          ...base,
          ...(sourceSession ? { sourceSession } : {}),
          text: text.text,
          ...(text.truncated ? { textTruncated: true } : {}),
          overlaps: decisionHintByIndex.get(index) ?? [],
        };
      }
      const candidate = rows.candidates.get(item.item_id)!;
      const title = bounded(candidate.title, SESSION_TITLE_LIMIT * 2);
      const body = bounded(candidate.body, BODY_LIMIT);
      const rationale = bounded(candidate.rationale, RATIONALE_LIMIT);
      return {
        ...base,
        ...(sourceSession ? { sourceSession } : {}),
        kind: candidate.kind,
        title: title.text,
        ...(title.truncated ? { titleTruncated: true } : {}),
        body: body.text,
        ...(body.truncated ? { bodyTruncated: true } : {}),
        rationale: rationale.text,
        ...(rationale.truncated ? { rationaleTruncated: true } : {}),
        tags: parseList(candidate.tags_json),
        references: parseList(candidate.references_json),
        appliesTo: parseList(candidate.applies_to_json),
        overlaps: candidateHintByIndex.get(index) ?? [],
      };
    });
  }

  private sessionContext(
    session: SessionRow | undefined,
    siblings: SiblingDecisionRow[],
    excludeDecisionId: string | undefined,
  ): AgentReviewSessionContext | undefined {
    if (!session) return undefined;
    const title = bounded(session.title, SESSION_TITLE_LIMIT);
    const outcomes = parseOutcomes(session.work_summary_json);
    const shownOutcomes = outcomes
      .slice(0, SESSION_OUTCOMES_SHOWN)
      .map((value) => bounded(value, SESSION_OUTCOME_LIMIT));
    const others = siblings.filter((row) => row.id !== excludeDecisionId);
    const shownOthers = others
      .slice(0, SIBLING_DECISIONS_SHOWN)
      .map((row) => bounded(row.text, SIBLING_DECISION_LIMIT));
    return {
      id: session.id,
      title: title.text,
      ...(title.truncated ? { titleTruncated: true } : {}),
      completedAt: session.completed_at,
      outcomes: shownOutcomes.map((value) => value.text),
      ...(outcomes.length > shownOutcomes.length || shownOutcomes.some((value) => value.truncated)
        ? { outcomesTruncated: true }
        : {}),
      otherDecisions: shownOthers.map((value) => value.text),
      ...(others.length > shownOthers.length || shownOthers.some((value) => value.truncated)
        ? { otherDecisionsTruncated: true }
        : {}),
    };
  }

  /**
   * Items keep their normal field limits and are shortened only when they alone exceed the budget; the Knowledge
   * titles get what is left, dropped from the end of the list (active first, then archived, then rejected).
   */
  private fitContext(result: ContextResult): void {
    const existing = result.existingKnowledge;
    const omitted = result.existingKnowledgeOmitted ?? 0;
    delete result.existingKnowledge;
    delete result.existingKnowledgeOmitted;
    for (
      let limit = 500;
      JSON.stringify(result).length > CONTEXT_BUDGET && limit >= 25;
      limit = Math.floor(limit / 2)
    ) {
      shortenContext(result, limit);
    }
    if (!existing) return;
    const titles = existing.map((entry) => ({ ...entry, title: entry.title.slice(0, EXISTING_TITLE_LIMIT) }));
    // Measured with the largest omitted count the result can carry, so the final count always fits.
    result.existingKnowledge = [];
    result.existingKnowledgeOmitted = omitted + titles.length;
    let remaining = CONTEXT_BUDGET - JSON.stringify(result).length;
    let kept = 0;
    for (const entry of titles) {
      remaining -= JSON.stringify(entry).length + 1;
      if (remaining < 0) break;
      kept += 1;
    }
    result.existingKnowledge = titles.slice(0, kept);
    const dropped = titles.length - kept;
    if (omitted + dropped > 0) result.existingKnowledgeOmitted = omitted + dropped;
    else delete result.existingKnowledgeOmitted;
    if (dropped > 0) result.truncated = true;
  }

  private apply(
    request: RequestRow,
    rootPath: string,
    input: SubmitAgentReviewVerdictsInput,
    normalized: readonly NormalizedVerdict[],
    hash: string,
  ): Applied {
    const submissionId = randomUUID();
    const at = nowIso();
    const ids = input.verdicts.map((verdict) => verdict.itemId);
    const pending = this.pendingRows(request, ids);
    const redactions: RedactionSummary[] = [];
    const resultByKey = new Map<string, AgentReviewVerdictResult>();
    for (const verdict of normalized) {
      const key = itemKey(verdict.itemKind, verdict.itemId);
      const item = pending.items.get(key);
      if (!item) {
        resultByKey.set(key, { itemKind: verdict.itemKind, itemId: verdict.itemId, outcome: "not_in_request" });
        continue;
      }
      const reason = redactText(verdict.reason);
      redactions.push(reason.redactions);
      const decided = this.decide(request, rootPath, item, verdict, reason.value, pending, at);
      if (decided.outcome === "knowledge_rejected") {
        resultByKey.set(key, {
          itemKind: verdict.itemKind,
          itemId: verdict.itemId,
          outcome: decided.outcome,
          knowledgeOutcome: decided.knowledgeOutcome,
          ...(decided.knowledgeReason ? { knowledgeReason: decided.knowledgeReason } : {}),
        });
        continue;
      }
      this.db
        .prepare(
          `UPDATE agent_review_request_items
           SET submission_id = ?, verdict = ?, outcome = ?, reason = ?, knowledge_id = ?, decided_at = ?
           WHERE id = ?`,
        )
        .run(submissionId, verdict.verdict, decided.outcome, reason.value, decided.knowledgeId ?? null, at, item.id);
      if (decided.redactions) redactions.push(decided.redactions);
      resultByKey.set(key, {
        itemKind: verdict.itemKind,
        itemId: verdict.itemId,
        outcome: decided.outcome,
        ...(decided.knowledgeId ? { knowledgeId: decided.knowledgeId } : {}),
      });
    }
    const results = input.verdicts.map((verdict) => resultByKey.get(itemKey(verdict.itemKind, verdict.itemId))!);
    this.db
      .prepare(
        `INSERT INTO agent_review_submissions (id, request_id, project_id, idempotency_key, payload_hash, results_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(submissionId, request.id, request.project_id, input.idempotencyKey, hash, JSON.stringify(results), at);
    const openLeft = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM agent_review_request_items WHERE request_id = ? AND outcome IS NULL")
        .get(request.id) as { count: number }
    ).count;
    if (input.complete === true || openLeft === 0) {
      this.db
        .prepare(
          "UPDATE agent_review_requests SET status = 'completed', completed_at = ?, failure_reason = NULL WHERE id = ?",
        )
        .run(at, request.id);
    }
    return { results, redactions: combineRedactionSummaries(...redactions) };
  }

  /** One verdict against the item's current row: only an unchanged pending row is written, anything else is skipped. */
  private decide(
    request: RequestRow,
    rootPath: string,
    item: ItemRow,
    verdict: NormalizedVerdict,
    reason: string,
    pending: PendingRows,
    at: string,
  ): Decided {
    if (item.outcome) return { outcome: "skipped_reviewed" };
    if (verdict.itemKind === "decision") {
      const row = pending.decisions.get(item.item_id);
      if (!row) return { outcome: "skipped_stale" };
      if (row.review_status !== "pending") return { outcome: "skipped_reviewed" };
      if (decisionFingerprint(row) !== item.fingerprint) return { outcome: "skipped_stale" };
      let status: "confirmed" | "rejected" | "promoted" = verdict.verdict === "confirm" ? "confirmed" : "rejected";
      let knowledgeId: string | null = null;
      let redactions: RedactionSummary | undefined;
      if (verdict.verdict === "promote") {
        const draft = verdict.knowledge;
        if (!draft) return { outcome: "skipped_stale" };
        const recorded = this.dependencies.recordKnowledge({
          projectRoot: rootPath,
          idempotencyKey: `agent-review-${request.id}-${item.item_id}`,
          sessionId: row.session_id,
          kind: draft.kind ?? "decision",
          title: draft.title,
          body: draft.body,
          ...(draft.tags ? { tags: draft.tags } : {}),
          ...(draft.references ? { references: draft.references } : {}),
          ...(draft.appliesTo ? { appliesTo: draft.appliesTo } : {}),
        });
        if (recorded.outcome !== "knowledge_recorded") return knowledgeRejected(recorded);
        status = "promoted";
        knowledgeId = recorded.knowledge.id;
        redactions = recorded.redactions;
      }
      this.db
        .prepare(
          `UPDATE session_decisions
           SET review_status = ?, reviewed_at = ?, knowledge_id = ?, reviewed_by = 'agent', review_reason = ?,
               review_request_id = ?
           WHERE id = ?`,
        )
        .run(status, at, knowledgeId, reason, request.id, row.id);
      return { outcome: "applied", ...(knowledgeId ? { knowledgeId } : {}), ...(redactions ? { redactions } : {}) };
    }
    const row = pending.candidates.get(item.item_id);
    if (!row) return { outcome: "skipped_stale" };
    if (row.status !== "proposed") return { outcome: "skipped_reviewed" };
    if (candidateFingerprint(row) !== item.fingerprint) return { outcome: "skipped_stale" };
    let knowledgeId: string | null = null;
    let redactions: RedactionSummary | undefined;
    if (verdict.verdict === "accept") {
      const edits = verdict.edits ?? {};
      const recorded = this.dependencies.recordKnowledge({
        projectRoot: rootPath,
        idempotencyKey: `agent-review-${request.id}-${row.id}`,
        kind: edits.kind ?? row.kind,
        title: edits.title?.trim() || row.title,
        body: edits.body?.trim() || row.body,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        tags: edits.tags ?? parseList(row.tags_json),
        references: edits.references ?? parseList(row.references_json),
        appliesTo: edits.appliesTo ?? parseList(row.applies_to_json),
      });
      if (recorded.outcome !== "knowledge_recorded") return knowledgeRejected(recorded);
      knowledgeId = recorded.knowledge.id;
      redactions = recorded.redactions;
    }
    this.db
      .prepare(
        `UPDATE knowledge_candidates
         SET status = ?, decided_at = ?, knowledge_id = ?, reviewed_by = 'agent', review_reason = ?, review_request_id = ?
         WHERE id = ?`,
      )
      .run(verdict.verdict === "accept" ? "accepted" : "rejected", at, knowledgeId, reason, request.id, row.id);
    return { outcome: "applied", ...(knowledgeId ? { knowledgeId } : {}), ...(redactions ? { redactions } : {}) };
  }

  /** The stored results of an earlier submission with this key, when the payload is the same. */
  private replay(requestId: string, idempotencyKey: string, hash: string): SubmitAgentReviewVerdictsResult | undefined {
    const previous = this.db
      .prepare(
        "SELECT id, payload_hash, results_json FROM agent_review_submissions WHERE request_id = ? AND idempotency_key = ?",
      )
      .get(requestId, idempotencyKey) as SubmissionRow | undefined;
    if (!previous) return undefined;
    if (previous.payload_hash !== hash) return { outcome: "rejected", reason: "idempotency_conflict", requestId };
    const request = this.request(requestId)!;
    return {
      outcome: "agent_review_verdicts_submitted",
      request,
      results: JSON.parse(previous.results_json) as AgentReviewVerdictResult[],
      duplicate: true,
      ...(request.status === "completed" ? { completion: { knowledgePages: this.completionPages(request) } } : {}),
    };
  }

  /** Pages of the project that cite a reviewed Session, then the project's own update queue, at most 12 in all. */
  private completionPages(request: AgentReviewRequest): AgentReviewKnowledgePage[] {
    const applied = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT source_session_id FROM agent_review_request_items
             WHERE request_id = ? AND outcome = 'applied' AND source_session_id IS NOT NULL`,
          )
          .all(request.id) as Array<{ source_session_id: string }>
      ).map((row) => row.source_session_id),
    );
    const pages = new Map<string, AgentReviewKnowledgePage>();
    const add = (page: { slug: string; title: string }, reason: AgentReviewKnowledgePage["reasons"][number]): void => {
      const known = pages.get(page.slug);
      if (known) known.reasons.push(reason);
      else pages.set(page.slug, { slug: page.slug, title: page.title, reasons: [reason] });
    };
    for (const page of this.dependencies.pagesCitingSessions(request.projectId, applied)) {
      add(page, "cites_reviewed_session");
    }
    for (const page of this.dependencies.pendingPages(request.projectId)) add(page, "queued_for_update");
    return [...pages.values()].slice(0, MAX_COMPLETION_PAGES);
  }

  /** A decision or candidate this service's Agent verdict decided, with the Knowledge id that verdict created. */
  private reviewedByAgent(
    projectId: string,
    kind: AgentReviewItemKind,
    itemId: string,
  ):
    | { knowledgeId: string | undefined; createdKnowledge: boolean }
    | Extract<OverturnAgentReviewResult, { outcome: "not_found" | "rejected" }> {
    const row =
      kind === "decision"
        ? (this.db
            .prepare(
              "SELECT reviewed_by, review_status, knowledge_id FROM session_decisions WHERE id = ? AND project_id = ?",
            )
            .get(itemId, projectId) as
            { reviewed_by: string | null; review_status: string; knowledge_id: string | null } | undefined)
        : (this.db
            .prepare(
              "SELECT reviewed_by, status AS review_status, knowledge_id FROM knowledge_candidates WHERE id = ? AND project_id = ?",
            )
            .get(itemId, projectId) as
            { reviewed_by: string | null; review_status: string; knowledge_id: string | null } | undefined);
    if (!row) return { outcome: "not_found", itemId };
    if (row.reviewed_by !== "agent") return { outcome: "rejected", reason: "not_agent_reviewed" };
    const created = this.db
      .prepare(
        `SELECT 1 AS found FROM agent_review_request_items
         WHERE project_id = ? AND item_kind = ? AND item_id = ? AND outcome = 'applied' AND overturned_at IS NULL
           AND verdict IN ('promote', 'accept')`,
      )
      .get(projectId, kind, itemId);
    return { knowledgeId: row.knowledge_id ?? undefined, createdKnowledge: Boolean(created) };
  }

  /** Archives the verdict's Knowledge only while it is still active; an edited, replaced or deleted one is left alone. */
  private archiveCreated(
    projectId: string,
    projectRoot: string,
    knowledgeId: string | undefined,
  ): { id?: string; action: "archived" | "unchanged" | "missing"; status?: KnowledgeStatus } {
    const current = knowledgeId
      ? (this.db
          .prepare("SELECT id, status FROM knowledge WHERE id = ? AND project_id = ?")
          .get(knowledgeId, projectId) as { id: string; status: KnowledgeStatus } | undefined)
      : undefined;
    if (!current) return { ...(knowledgeId ? { id: knowledgeId } : {}), action: "missing" };
    if (current.status !== "active") return { id: current.id, action: "unchanged", status: current.status };
    const updated = this.dependencies.updateKnowledge({ projectRoot, knowledgeId: current.id, status: "archived" });
    return updated.outcome === "knowledge_updated"
      ? { id: current.id, action: "archived", status: "archived" }
      : { id: current.id, action: "unchanged", status: current.status };
  }

  private pendingRows(request: RequestRow, itemIds: readonly string[]): PendingRows {
    const itemRows = this.db
      .prepare(
        "SELECT * FROM agent_review_request_items WHERE request_id = ? AND item_id IN (SELECT value FROM json_each(?))",
      )
      .all(request.id, JSON.stringify(itemIds)) as ItemRow[];
    const rows = this.currentRows(
      request.project_id,
      itemRows.filter((item) => item.item_kind === "decision").map((item) => item.item_id),
      itemRows.filter((item) => item.item_kind === "candidate").map((item) => item.item_id),
    );
    return { items: new Map(itemRows.map((item) => [itemKey(item.item_kind, item.item_id), item])), ...rows };
  }

  private currentRows(
    projectId: string,
    decisionIds: readonly string[],
    candidateIds: readonly string[],
  ): Pick<PendingRows, "decisions" | "candidates"> {
    const decisions = decisionIds.length
      ? (this.db
          .prepare(
            `SELECT d.*, s.voided_at AS session_voided_at, s.completed_at AS session_completed_at
             FROM session_decisions d JOIN sessions s ON s.id = d.session_id
             WHERE d.project_id = ? AND d.id IN (SELECT value FROM json_each(?))`,
          )
          .all(projectId, JSON.stringify(decisionIds)) as DecisionRow[])
      : [];
    const candidates = candidateIds.length
      ? (this.db
          .prepare(`${CANDIDATE_SELECT} WHERE c.project_id = ? AND c.id IN (SELECT value FROM json_each(?))`)
          .all(projectId, JSON.stringify(candidateIds)) as CandidateRow[])
      : [];
    return {
      decisions: new Map(decisions.map((row) => [row.id, row])),
      candidates: new Map(candidates.map((row) => [row.id, row])),
    };
  }

  private sessions(projectId: string, ids: readonly string[]): Map<string, SessionRow> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, voided_at, work_summary_json FROM sessions
         WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(projectId, JSON.stringify(ids)) as SessionRow[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The first decisions of each Session, enough for the page to show five besides the one being reviewed. */
  private siblingDecisions(sessionIds: readonly string[]): Map<string, SiblingDecisionRow[]> {
    const grouped = new Map<string, SiblingDecisionRow[]>();
    if (sessionIds.length === 0) return grouped;
    const rows = this.db
      .prepare(
        `SELECT session_id, id, text FROM (
           SELECT session_id, id, text, position,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY position) AS rank
           FROM session_decisions WHERE session_id IN (SELECT value FROM json_each(?))
         ) WHERE rank <= ? ORDER BY session_id, position`,
      )
      .all(JSON.stringify(sessionIds), SIBLING_DECISIONS_SHOWN + 2) as SiblingDecisionRow[];
    for (const row of rows) {
      const group = grouped.get(row.session_id) ?? [];
      group.push(row);
      grouped.set(row.session_id, group);
    }
    return grouped;
  }

  private decisionRow(projectId: string, id: string): SessionDecisionRow | undefined {
    return this.db.prepare("SELECT * FROM session_decisions WHERE id = ? AND project_id = ?").get(id, projectId) as
      SessionDecisionRow | undefined;
  }

  private candidateRow(projectId: string, id: string): CandidateRow | undefined {
    return this.db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ? AND c.project_id = ?`).get(id, projectId) as
      CandidateRow | undefined;
  }

  private resolve(
    input: AgentReviewContextQuery,
  ): RequestRow | Extract<AgentReviewContextResult, { outcome: "not_found" | "skipped" }> {
    let row: RequestRow | undefined;
    if (input.requestId) {
      row = this.requestRow(input.requestId);
    } else if (input.projectRoot) {
      const policy = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!policy.allowed || !policy.project) return skippedByRoot(policy);
      row = this.db
        .prepare(
          `${REQUEST_SELECT} WHERE r.project_id = ? AND r.status IN ${OPEN_STATUSES} ORDER BY r.requested_at DESC LIMIT 1`,
        )
        .get(policy.project.id) as RequestRow | undefined;
    }
    if (!row) return { outcome: "not_found", requestId: input.requestId };
    const policy = this.dependencies.checkProjectById(row.project_id);
    return policy.allowed ? row : skippedById(row.project_id, policy);
  }

  private requestRow(id: string): RequestRow | undefined {
    return this.db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  }

  private request(id: string): AgentReviewRequest | undefined {
    const row = this.requestRow(id);
    return row ? this.toRequests([row])[0] : undefined;
  }

  /** Counts come from one aggregate over the page's requests, not from a query per request. */
  private toRequests(rows: readonly RequestRow[]): AgentReviewRequest[] {
    if (rows.length === 0) return [];
    const counts = new Map(
      (
        this.db
          .prepare(
            `SELECT request_id,
                    SUM(item_kind = 'decision') AS decision_count,
                    SUM(item_kind = 'candidate') AS candidate_count,
                    SUM(outcome = 'applied') AS applied_count,
                    SUM(outcome IN ('skipped_stale', 'skipped_reviewed')) AS skipped_count,
                    SUM(outcome IS NULL) AS open_count
             FROM agent_review_request_items
             WHERE request_id IN (SELECT value FROM json_each(?)) GROUP BY request_id`,
          )
          .all(JSON.stringify(rows.map((row) => row.id))) as RequestCountRow[]
      ).map((row) => [row.request_id, row]),
    );
    return rows.map((row) => {
      const count = counts.get(row.id);
      return {
        id: row.id,
        projectId: row.project_id,
        ...(row.project_name ? { projectName: row.project_name } : {}),
        status: row.status,
        requestedAt: row.requested_at,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
        ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
        itemCount: row.item_count,
        omittedCount: row.omitted_count,
        decisionCount: count?.decision_count ?? 0,
        candidateCount: count?.candidate_count ?? 0,
        appliedCount: count?.applied_count ?? 0,
        skippedCount: count?.skipped_count ?? 0,
        openCount: count?.open_count ?? 0,
      };
    });
  }

  /** Processing requests abandoned for 30 minutes become failed, which an Agent can pick up again. */
  private recoverStale(now = Date.now()): void {
    const cutoff = new Date(now - PROCESSING_TIMEOUT_MS).toISOString();
    const stale = this.db
      .prepare(
        "SELECT 1 FROM agent_review_requests WHERE status = 'processing' AND started_at IS NOT NULL AND started_at <= ? LIMIT 1",
      )
      .get(cutoff);
    if (!stale) return;
    try {
      runImmediateTransaction(this.db, () =>
        this.db
          .prepare(
            `UPDATE agent_review_requests
             SET status = 'failed', failure_reason = 'Agent 審查超過 30 分鐘仍未完成，可重新處理。'
             WHERE status = 'processing' AND started_at IS NOT NULL AND started_at <= ?`,
          )
          .run(cutoff),
      );
    } catch (error) {
      // This lazy cleanup runs on read paths; once another process migrated the database the reads keep working.
      if (!isDatabaseSchemaChangedError(error)) throw error;
    }
  }
}

interface Applied {
  results: AgentReviewVerdictResult[];
  redactions: RedactionSummary;
}
