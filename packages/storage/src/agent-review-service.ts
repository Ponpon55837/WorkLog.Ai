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
  AgentReviewLaterSession,
  AgentReviewPageState,
  AgentReviewPendingListResult,
  AgentReviewRequest,
  AgentReviewRequestPage,
  AgentReviewRequestListResult,
  AgentReviewRequestQuery,
  AgentReviewRequestStatus,
  AgentReviewSessionContext,
  AgentReviewSkippedResult,
  AgentReviewVerdict,
  AgentReviewVerdictResult,
  AgentReviewedKnowledge,
  AgentReviewedKnowledgeListResult,
  AgentReviewedKnowledgeQuery,
  CancelAgentReviewRequestResult,
  CreateAgentReviewRequestInput,
  CreateAgentReviewRequestResult,
  KnowledgeRecord,
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
import { CONVENTION_WITHDRAWN_WARNING, type WithdrawnConfirmation } from "./knowledge-service.js";
import { isDatabaseSchemaChangedError } from "./schema-write-gate.js";
import { toDecision, type SessionDecisionRow } from "./session-decision-service.js";
import { toKnowledge, type KnowledgeRow } from "./session-record-codecs.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { isKnowledgeInDoubt } from "./stale-flags.js";

interface Dependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  checkProjectById(projectId: string): PolicyDecision;
  recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult;
  updateKnowledge(input: UpdateKnowledgeInput, actor?: "user" | "agent"): UpdateKnowledgeResult;
  pagesCitingSessions(projectId: string, sessionIds: ReadonlySet<string>): Array<{ slug: string; title: string }>;
  pendingPages(projectId: string): Array<{ slug: string; title: string }>;
  withKnowledgeTrustMany(items: KnowledgeRecord[]): KnowledgeRecord[];
  laterSessionsOf(items: readonly KnowledgeRecord[], limit: number): Map<string, AgentReviewLaterSession[]>;
  withdrawConfirmation(
    projectId: string,
    knowledgeId: string,
    confirmedSince: string,
  ): WithdrawnConfirmation | undefined;
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
  completion_pages_json: string | null;
};

type RequestCountRow = {
  request_id: string;
  decision_count: number;
  candidate_count: number;
  knowledge_count: number;
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
  knowledge: Map<string, TrustedKnowledge>;
};

type TrustedKnowledge = { row: KnowledgeRow; record: KnowledgeRecord };

type CurrentRows = Omit<PendingRows, "items">;

type ReviewedKnowledgeRow = {
  item_id: string;
  verdict: AgentReviewedKnowledge["verdict"];
  reason: string;
  decided_at: string;
  request_id: string;
  knowledge_id: string | null;
};

type Decided =
  | { outcome: AgentReviewItemOutcome; knowledgeId?: string; redactions?: RedactionSummary; conventionWithdrawn?: true }
  | { outcome: "knowledge_rejected"; knowledgeOutcome: string; knowledgeReason?: string };

type KnowledgeWriteFailure =
  | Exclude<RecordKnowledgeResult, { outcome: "knowledge_recorded" }>
  | Exclude<UpdateKnowledgeResult, { outcome: "knowledge_updated" }>;

type ContextResult = Extract<AgentReviewContextResult, { outcome: "agent_review_context" }>;

const MAX_SNAPSHOT_ITEMS = 500;
const CONTEXT_BUDGET = 24_000;
/** Room left for the server status the MCP adds to every write-tool response. */
const SERVER_STATUS_RESERVE = 200;
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
const LATER_SESSIONS_SHOWN = 5;
const REVIEWED_KNOWLEDGE_LIMIT = 200;
const CONTEXT_HINT =
  "逐項核對 open 項目後用 work_submit_agent_review_verdicts 提交 verdict：決策與候選用 sourceSessionId 對照 sessions 的來源 Session，Knowledge 要讀現在的程式碼或" +
  " laterSessions 的工作記錄，不可只因檔案改過就封存。理由要具體，證據不足的項目不提交，留給使用者。" +
  "已有結果、stale 或已被審查的項目不需處理。verdict 直接生效，使用者之後可以推翻。";
const REQUEST_SELECT = `SELECT r.*, p.name AS project_name
  FROM agent_review_requests r JOIN projects p ON p.id = r.project_id`;

/** An item a person once overturned stays in their queue, so a later request never hands it to an Agent again. */
function notOverturned(kind: AgentReviewItemKind, alias: string): string {
  return `AND NOT EXISTS (
         SELECT 1 FROM agent_review_request_items i
         WHERE i.project_id = ${alias}.project_id AND i.item_kind = '${kind}' AND i.item_id = ${alias}.id
           AND i.overturned_at IS NOT NULL)`;
}

function decisionWhere(projectRef: string): string {
  return `d.project_id = ${projectRef} AND d.origin = 'agent_autonomous' AND d.review_status = 'pending'
      AND s.voided_at IS NULL ${notOverturned("decision", "d")}`;
}

function candidateWhere(projectRef: string): string {
  return `c.project_id = ${projectRef} AND c.status = 'proposed' ${notOverturned("candidate", "c")}`;
}

function parseStoredPages(json: string | null): AgentReviewKnowledgePage[] | undefined {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const pages = parsed.filter(
      (page): page is AgentReviewKnowledgePage =>
        typeof page === "object" &&
        page !== null &&
        typeof page.slug === "string" &&
        typeof page.title === "string" &&
        Array.isArray(page.reasons),
    );
    return pages.length === parsed.length ? pages.slice(0, MAX_COMPLETION_PAGES) : undefined;
  } catch {
    return undefined;
  }
}

function pageState(
  page: AgentReviewKnowledgePage,
  queued: boolean,
  savedAt: string | undefined,
  completedAt: string | undefined,
): AgentReviewPageState {
  if (queued) return "pending";
  if (savedAt !== undefined && completedAt !== undefined && savedAt >= completedAt) return "updated";
  return page.reasons.includes("queued_for_update") ? "checked" : "unchanged";
}

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

/** Includes the count of later focused Sessions: one touching appliesTo while a request is open makes a verdict stale. */
function knowledgeFingerprint({ row, record }: TrustedKnowledge): string {
  return hashJson([
    row.kind,
    row.title,
    row.body,
    row.tags_json,
    row.references_json,
    row.applies_to_json ?? "[]",
    row.status,
    row.last_confirmed_at ?? null,
    row.last_confirmed_session_id ?? null,
    row.review_json ?? null,
    record.possiblyStale?.sessionCount ?? 0,
  ]);
}

function currentOf(item: ItemRow, rows: CurrentRows): { pending: boolean; fingerprint: string } | undefined {
  if (item.item_kind === "decision") {
    const row = rows.decisions.get(item.item_id);
    return row && { pending: row.review_status === "pending", fingerprint: decisionFingerprint(row) };
  }
  if (item.item_kind === "candidate") {
    const row = rows.candidates.get(item.item_id);
    return row && { pending: row.status === "proposed", fingerprint: candidateFingerprint(row) };
  }
  const knowledge = rows.knowledge.get(item.item_id);
  return knowledge && { pending: knowledge.row.status === "active", fingerprint: knowledgeFingerprint(knowledge) };
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

function conventionWarnings(results: readonly AgentReviewVerdictResult[]): { warnings?: string[] } {
  return results.some((result) => result.conventionWithdrawn) ? { warnings: [CONVENTION_WITHDRAWN_WARNING] } : {};
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

function itemState(item: ItemRow, rows: CurrentRows): AgentReviewItemState {
  if (item.outcome === "applied") return "applied";
  if (item.outcome) return "skipped";
  const current = currentOf(item, rows);
  if (!current) return "stale";
  if (!current.pending) return "reviewed";
  return current.fingerprint === item.fingerprint ? "open" : "stale";
}

function knowledgeRejected(failure: KnowledgeWriteFailure): Decided {
  return {
    outcome: "knowledge_rejected",
    knowledgeOutcome: failure.outcome,
    ...("reason" in failure && failure.reason
      ? { knowledgeReason: failure.reason.slice(0, KNOWLEDGE_REASON_LIMIT) }
      : {}),
  };
}

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
    const contradicted = item.doubt?.contradicted;
    if (contradicted?.sessionTitle && contradicted.sessionTitle.length > limit) {
      contradicted.sessionTitle = cut(contradicted.sessionTitle);
    }
  }
  for (const session of result.sessions) {
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
    return {
      outcome: "agent_review_requests",
      requests: this.withKnowledgePages(this.toRequests(rows), rows),
      pageInfo,
    };
  }

  /** Counts what a request would hand an Agent per tracked project, without the fingerprints and rows a snapshot builds. */
  public listPending(): AgentReviewPendingListResult {
    const counts = this.db
      .prepare(
        `SELECT p.id, p.name,
           (SELECT COUNT(*) FROM session_decisions d JOIN sessions s ON s.id = d.session_id
             WHERE ${decisionWhere("p.id")}) AS decision_count,
           (SELECT COUNT(*) FROM knowledge_candidates c WHERE ${candidateWhere("p.id")}) AS candidate_count
         FROM projects p WHERE p.status = 'tracked' ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all() as Array<{ id: string; name: string; decision_count: number; candidate_count: number }>;
    const knowledgeCounts = new Map<string, number>();
    for (const { row } of this.knowledgeInDoubt(undefined, notOverturned("knowledge", "k"))) {
      knowledgeCounts.set(row.project_id, (knowledgeCounts.get(row.project_id) ?? 0) + 1);
    }
    return {
      outcome: "agent_review_pending",
      projects: counts.flatMap((row) => {
        const knowledgeCount = knowledgeCounts.get(row.id) ?? 0;
        if (row.decision_count + row.candidate_count + knowledgeCount === 0) return [];
        return [
          {
            projectId: row.id,
            projectName: row.name,
            decisionCount: row.decision_count,
            candidateCount: row.candidate_count,
            knowledgeCount,
          },
        ];
      }),
    };
  }

  public listReviewedKnowledge(input: AgentReviewedKnowledgeQuery = {}): AgentReviewedKnowledgeListResult {
    let projectId: string | undefined;
    if (input.projectRoot) {
      const policy = this.dependencies.checkProjectRoot(input.projectRoot);
      if (!policy.allowed || !policy.project) return skippedByRoot(policy);
      projectId = policy.project.id;
    }
    const rows = this.db
      .prepare(
        `SELECT i.item_id, i.verdict, i.reason, i.decided_at, i.request_id, i.knowledge_id
         FROM agent_review_request_items i JOIN projects p ON p.id = i.project_id
         WHERE p.status = 'tracked' AND i.item_kind = 'knowledge' AND i.outcome = 'applied' AND i.overturned_at IS NULL
           ${projectId ? "AND i.project_id = ?" : ""}
           AND NOT EXISTS (
             SELECT 1 FROM agent_review_request_items later
             WHERE later.project_id = i.project_id AND later.item_kind = 'knowledge' AND later.item_id = i.item_id
               AND later.outcome = 'applied' AND later.overturned_at IS NULL
               AND (later.decided_at > i.decided_at OR (later.decided_at = i.decided_at AND later.rowid > i.rowid)))
         ORDER BY i.decided_at DESC, i.rowid DESC LIMIT ?`,
      )
      .all(...(projectId ? [projectId] : []), REVIEWED_KNOWLEDGE_LIMIT) as ReviewedKnowledgeRow[];
    const ids = [...new Set(rows.flatMap((row) => [row.item_id, ...(row.knowledge_id ? [row.knowledge_id] : [])]))];
    const knowledge = new Map(this.knowledgeRows(projectId, ids).map((row) => [row.id, row]));
    const reviewed = rows.filter((row) => knowledge.has(row.item_id));
    const records = this.dependencies.withKnowledgeTrustMany(
      reviewed.map((row) => toKnowledge(knowledge.get(row.item_id)!)),
    );
    return {
      outcome: "agent_reviewed_knowledge",
      items: reviewed.map((row, index): AgentReviewedKnowledge => {
        const successor = row.knowledge_id ? knowledge.get(row.knowledge_id) : undefined;
        return {
          knowledge: records[index]!,
          verdict: row.verdict,
          reason: row.reason,
          reviewedAt: row.decided_at,
          requestId: row.request_id,
          ...(successor ? { successor: { id: successor.id, title: successor.title, status: successor.status } } : {}),
        };
      }),
    };
  }

  public create(input: CreateAgentReviewRequestInput): CreateAgentReviewRequestResult {
    const policy = this.dependencies.checkProjectById(input.projectId);
    if (!policy.allowed) return skippedById(input.projectId, policy);
    return this.open(input.projectId, input.idempotencyKey);
  }

  public requestForRoot(input: RequestAgentReviewInput): RequestAgentReviewResult {
    const policy = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!policy.allowed || !policy.project) return skippedByRoot(policy);
    return this.open(policy.project.id, input.idempotencyKey);
  }

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
    const { items, sessions } = this.contextItems(request, itemRows);
    const result: ContextResult = {
      outcome: "agent_review_context",
      request,
      items,
      sessions,
      pageInfo,
      truncated:
        items.some(
          (item) => item.textTruncated || item.titleTruncated || item.bodyTruncated || item.rationaleTruncated,
        ) ||
        sessions.some(
          (session) => session.titleTruncated || session.outcomesTruncated || session.otherDecisionsTruncated,
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
      ...conventionWarnings(outcome.applied.results),
      ...(request.status === "completed" ? { completion: { knowledgePages: this.completionOf(request.id) } } : {}),
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

  public overturn(input: OverturnAgentReviewInput): OverturnAgentReviewResult {
    const policy = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!policy.allowed || !policy.project) return skippedByRoot(policy);
    const projectId = policy.project.id;
    const projectRoot = policy.project.rootPath;
    if (input.itemKind === "knowledge") return this.overturnKnowledge(projectId, projectRoot, input.itemId);
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
          reason: "這個專案目前沒有待 Agent 審查的決策、Knowledge 候選或需要複查的 Knowledge。",
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

  private snapshot(projectId: string): {
    items: Array<{ kind: AgentReviewItemKind; id: string; sessionId: string | null; fingerprint: string }>;
    omitted: number;
  } {
    const decisionFilter = decisionWhere("?");
    const candidateFilter = candidateWhere("?");
    const count = (sql: string): number => (this.db.prepare(sql).get(projectId) as { count: number }).count;
    const decisionTotal = count(
      `SELECT COUNT(*) AS count FROM session_decisions d JOIN sessions s ON s.id = d.session_id WHERE ${decisionFilter}`,
    );
    const candidateTotal = count(`SELECT COUNT(*) AS count FROM knowledge_candidates c WHERE ${candidateFilter}`);
    const decisions = this.db
      .prepare(
        `SELECT d.*, s.voided_at AS session_voided_at, s.completed_at AS session_completed_at
         FROM session_decisions d JOIN sessions s ON s.id = d.session_id
         WHERE ${decisionFilter}
         ORDER BY s.completed_at ASC, d.session_id ASC, d.position ASC LIMIT ?`,
      )
      .all(projectId, MAX_SNAPSHOT_ITEMS) as DecisionRow[];
    const candidates = this.db
      .prepare(
        `SELECT c.*, NULL AS project_name, NULL AS session_title FROM knowledge_candidates c
         WHERE ${candidateFilter} ORDER BY c.created_at ASC, c.id ASC LIMIT ?`,
      )
      .all(projectId, Math.max(MAX_SNAPSHOT_ITEMS - decisions.length, 0)) as CandidateRow[];
    const knowledge = this.knowledgeInDoubt(projectId, notOverturned("knowledge", "k"));
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
      ...knowledge.slice(0, Math.max(MAX_SNAPSHOT_ITEMS - decisions.length - candidates.length, 0)).map((trusted) => ({
        kind: "knowledge" as const,
        id: trusted.row.id,
        sessionId: null,
        fingerprint: knowledgeFingerprint(trusted),
      })),
    ];
    return { items, omitted: decisionTotal + candidateTotal + knowledge.length - items.length };
  }

  /** Without a project, every tracked project's Knowledge is read and trusted in one batch. */
  private knowledgeInDoubt(projectId: string | undefined, notOverturned: string): TrustedKnowledge[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
         WHERE ${projectId ? "k.project_id = ?" : "p.status = 'tracked'"} AND k.status = 'active'
           AND (k.applies_to_json <> '[]' OR k.review_json IS NOT NULL)
           ${notOverturned}
         ORDER BY k.created_at ASC, k.id ASC`,
      )
      .all(...(projectId ? [projectId] : [])) as KnowledgeRow[];
    return this.trusted(rows).filter(({ record }) => isKnowledgeInDoubt(record));
  }

  private trusted(rows: readonly KnowledgeRow[]): TrustedKnowledge[] {
    const records = this.dependencies.withKnowledgeTrustMany(rows.map(toKnowledge));
    return rows.map((row, index) => ({ row, record: records[index]! }));
  }

  private contextItems(
    request: AgentReviewRequest,
    itemRows: ItemRow[],
  ): { items: AgentReviewContextItem[]; sessions: AgentReviewSessionContext[] } {
    const rows = this.currentRows(request.projectId, itemRows);
    const states = itemRows.map((item) => itemState(item, rows));
    const openIndexes = itemRows.flatMap((_, index) => (states[index] === "open" ? [index] : []));
    const openKnowledge = openIndexes
      .filter((index) => itemRows[index]!.item_kind === "knowledge")
      .map((index) => rows.knowledge.get(itemRows[index]!.item_id)!.record);
    const knowledgeById = new Map(openKnowledge.map((record) => [record.id, record]));
    const laterSessions = this.dependencies.laterSessionsOf(openKnowledge, LATER_SESSIONS_SHOWN);
    const sessionIds = [...new Set(openIndexes.flatMap((index) => itemRows[index]!.source_session_id ?? []))];
    const reviewSessionIds = openKnowledge.flatMap((record) => record.review?.sessionId ?? []);
    const sessions = this.sessions(request.projectId, [...new Set([...sessionIds, ...reviewSessionIds])]);
    const openDecisions = openIndexes.filter((index) => itemRows[index]!.item_kind === "decision");
    const shownDecisionIds = new Set(openDecisions.map((index) => itemRows[index]!.item_id));
    const siblings = this.siblingDecisions(sessionIds, shownDecisionIds.size);
    const sessionContexts = new Map<string, AgentReviewSessionContext>();
    for (const id of sessionIds) {
      const context = this.sessionContext(
        sessions.get(id),
        (siblings.get(id) ?? []).filter((row) => !shownDecisionIds.has(row.id)),
      );
      if (context) sessionContexts.set(id, context);
    }

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

    const items = itemRows.map((item, index): AgentReviewContextItem => {
      const state = states[index]!;
      const base = { itemKind: item.item_kind, id: item.item_id, state, overlaps: [] };
      if (state !== "open") return base;
      if (item.item_kind === "knowledge") {
        const record = knowledgeById.get(item.item_id)!;
        return this.knowledgeContext(base, record, laterSessions.get(record.id), sessions);
      }
      const sourceSessionId =
        item.source_session_id && sessionContexts.has(item.source_session_id) ? item.source_session_id : undefined;
      if (item.item_kind === "decision") {
        const text = bounded(rows.decisions.get(item.item_id)!.text, BODY_LIMIT);
        return {
          ...base,
          ...(sourceSessionId ? { sourceSessionId } : {}),
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
        ...(sourceSessionId ? { sourceSessionId } : {}),
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
    return { items, sessions: [...sessionContexts.values()] };
  }

  private knowledgeContext(
    base: Pick<AgentReviewContextItem, "itemKind" | "id" | "state" | "overlaps">,
    record: KnowledgeRecord,
    later: AgentReviewLaterSession[] | undefined,
    sessions: Map<string, SessionRow>,
  ): AgentReviewContextItem {
    const title = bounded(record.title, SESSION_TITLE_LIMIT * 2);
    const body = bounded(record.body, BODY_LIMIT);
    const review = record.review;
    const reviewSession = review?.sessionId ? sessions.get(review.sessionId) : undefined;
    const shown = (later ?? []).map((session) => ({ ...session, title: session.title.slice(0, SESSION_TITLE_LIMIT) }));
    const omitted = Math.max((record.possiblyStale?.sessionCount ?? shown.length) - shown.length, 0);
    return {
      ...base,
      kind: record.kind,
      title: title.text,
      ...(title.truncated ? { titleTruncated: true } : {}),
      body: body.text,
      ...(body.truncated ? { bodyTruncated: true } : {}),
      tags: record.tags,
      references: record.references,
      appliesTo: record.appliesTo,
      createdAt: record.createdAt,
      ...(record.lastConfirmedAt ? { lastConfirmedAt: record.lastConfirmedAt } : {}),
      doubt: {
        ...(record.possiblyStale
          ? {
              possiblyStale: {
                reason: record.possiblyStale.reason,
                sessionCount: record.possiblyStale.sessionCount,
              },
            }
          : {}),
        ...(review
          ? {
              contradicted: {
                ...(review.sessionId ? { sessionId: review.sessionId } : {}),
                ...(reviewSession ? { sessionTitle: reviewSession.title.slice(0, SESSION_TITLE_LIMIT) } : {}),
                at: review.at,
              },
            }
          : {}),
      },
      ...(shown.length > 0 ? { laterSessions: shown } : {}),
      ...(omitted > 0 ? { laterSessionsOmitted: omitted } : {}),
    };
  }

  private sessionContext(
    session: SessionRow | undefined,
    others: SiblingDecisionRow[],
  ): AgentReviewSessionContext | undefined {
    if (!session) return undefined;
    const title = bounded(session.title, SESSION_TITLE_LIMIT);
    const outcomes = parseOutcomes(session.work_summary_json);
    const shownOutcomes = outcomes
      .slice(0, SESSION_OUTCOMES_SHOWN)
      .map((value) => bounded(value, SESSION_OUTCOME_LIMIT));
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

  /** Every list is reserved at its largest omitted count before any is filled, so a later count never pushes it over. */
  private fitContext(result: ContextResult): void {
    const existing = result.existingKnowledge?.map((entry) => ({
      ...entry,
      title: entry.title.slice(0, EXISTING_TITLE_LIMIT),
    }));
    const existingOmitted = result.existingKnowledgeOmitted ?? 0;
    delete result.existingKnowledge;
    delete result.existingKnowledgeOmitted;
    const later = result.items.map((item) => {
      const sessions = item.laterSessions;
      const omitted = item.laterSessionsOmitted ?? 0;
      delete item.laterSessions;
      delete item.laterSessionsOmitted;
      return sessions ? { sessions, omitted } : undefined;
    });
    for (
      let limit = 500;
      JSON.stringify(result).length > CONTEXT_BUDGET && limit >= 25;
      limit = Math.floor(limit / 2)
    ) {
      shortenContext(result, limit);
    }
    const lists: Array<{
      target: object;
      key: string;
      omittedKey: string;
      entries: readonly unknown[];
      omitted: number;
    }> = [];
    result.items.forEach((item, index) => {
      const list = later[index];
      if (list)
        lists.push({
          target: item,
          key: "laterSessions",
          omittedKey: "laterSessionsOmitted",
          ...list,
          entries: list.sessions,
        });
    });
    if (existing) {
      lists.push({
        target: result,
        key: "existingKnowledge",
        omittedKey: "existingKnowledgeOmitted",
        entries: existing,
        omitted: existingOmitted,
      });
    }
    for (const list of lists) {
      const fields = list.target as Record<string, unknown>;
      fields[list.key] = [];
      fields[list.omittedKey] = list.omitted + list.entries.length;
    }
    for (const list of lists) {
      const kept = this.fitList(result, list.target, list.key, list.omittedKey, list.entries, list.omitted);
      if (kept < list.entries.length) result.truncated = true;
    }
  }

  /** The target must already carry its largest omitted count, so the final count always fits. */
  private fitList(
    result: ContextResult,
    target: object,
    key: string,
    omittedKey: string,
    entries: readonly unknown[],
    omitted: number,
  ): number {
    const fields = target as Record<string, unknown>;
    let remaining = CONTEXT_BUDGET - SERVER_STATUS_RESERVE - JSON.stringify(result).length;
    let kept = 0;
    for (const entry of entries) {
      remaining -= JSON.stringify(entry).length + 1;
      if (remaining < 0) break;
      kept += 1;
    }
    fields[key] = entries.slice(0, kept);
    const dropped = entries.length - kept;
    if (omitted + dropped > 0) fields[omittedKey] = omitted + dropped;
    else delete fields[omittedKey];
    return kept;
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
        ...(decided.conventionWithdrawn ? { conventionWithdrawn: true as const } : {}),
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
          `UPDATE agent_review_requests
           SET status = 'completed', completed_at = ?, failure_reason = NULL, completion_pages_json = ?
           WHERE id = ?`,
        )
        .run(at, JSON.stringify(this.completionPages(request.id, request.project_id)), request.id);
    }
    return { results, redactions: combineRedactionSummaries(...redactions) };
  }

  /** Only an unchanged pending row is written; anything else is skipped. */
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
    const current = currentOf(item, pending);
    if (!current) return { outcome: "skipped_stale" };
    if (!current.pending) return { outcome: "skipped_reviewed" };
    if (current.fingerprint !== item.fingerprint) return { outcome: "skipped_stale" };
    if (verdict.itemKind === "knowledge") return this.decideKnowledge(request, rootPath, pending, verdict);
    if (verdict.itemKind === "decision") {
      const row = pending.decisions.get(item.item_id)!;
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
    const row = pending.candidates.get(item.item_id)!;
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

  private decideKnowledge(
    request: RequestRow,
    rootPath: string,
    pending: PendingRows,
    verdict: Extract<NormalizedVerdict, { itemKind: "knowledge" }>,
  ): Decided {
    const old = pending.knowledge.get(verdict.itemId)!.record;
    if (verdict.verdict !== "supersede") {
      const updated = this.dependencies.updateKnowledge({
        projectRoot: rootPath,
        knowledgeId: old.id,
        ...(verdict.verdict === "confirm" ? { confirm: true } : { status: "archived" as const }),
      });
      return updated.outcome === "knowledge_updated"
        ? {
            outcome: "applied",
            ...(updated.warnings?.includes(CONVENTION_WITHDRAWN_WARNING) ? { conventionWithdrawn: true as const } : {}),
          }
        : knowledgeRejected(updated);
    }
    const draft = verdict.knowledge;
    if (!draft) return { outcome: "skipped_stale" };
    const recorded = this.dependencies.recordKnowledge({
      projectRoot: rootPath,
      idempotencyKey: `agent-review-${request.id}-${old.id}`,
      kind: draft.kind ?? old.kind,
      title: draft.title,
      body: draft.body,
      tags: draft.tags ?? old.tags,
      references: draft.references ?? old.references,
      appliesTo: draft.appliesTo ?? old.appliesTo,
      supersedesId: old.id,
    });
    if (recorded.outcome !== "knowledge_recorded") return knowledgeRejected(recorded);
    return {
      outcome: "applied",
      knowledgeId: recorded.knowledge.id,
      redactions: recorded.redactions,
      ...(recorded.warnings?.includes(CONVENTION_WITHDRAWN_WARNING) ? { conventionWithdrawn: true as const } : {}),
    };
  }

  private replay(requestId: string, idempotencyKey: string, hash: string): SubmitAgentReviewVerdictsResult | undefined {
    const previous = this.db
      .prepare(
        "SELECT id, payload_hash, results_json FROM agent_review_submissions WHERE request_id = ? AND idempotency_key = ?",
      )
      .get(requestId, idempotencyKey) as SubmissionRow | undefined;
    if (!previous) return undefined;
    if (previous.payload_hash !== hash) return { outcome: "rejected", reason: "idempotency_conflict", requestId };
    const request = this.request(requestId)!;
    const results = JSON.parse(previous.results_json) as AgentReviewVerdictResult[];
    return {
      outcome: "agent_review_verdicts_submitted",
      request,
      results,
      duplicate: true,
      ...conventionWarnings(results),
      ...(request.status === "completed" ? { completion: { knowledgePages: this.completionOf(request.id) } } : {}),
    };
  }

  /** A request completed before schema 40 has no stored list, so it is computed. */
  private completionOf(requestId: string): AgentReviewKnowledgePage[] {
    const row = this.requestRow(requestId)!;
    return parseStoredPages(row.completion_pages_json) ?? this.completionPages(row.id, row.project_id);
  }

  private completionPages(requestId: string, projectId: string): AgentReviewKnowledgePage[] {
    const applied = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT source_session_id FROM agent_review_request_items
             WHERE request_id = ? AND outcome = 'applied' AND source_session_id IS NOT NULL`,
          )
          .all(requestId) as Array<{ source_session_id: string }>
      ).map((row) => row.source_session_id),
    );
    const pages = new Map<string, AgentReviewKnowledgePage>();
    const add = (page: { slug: string; title: string }, reason: AgentReviewKnowledgePage["reasons"][number]): void => {
      const known = pages.get(page.slug);
      if (known) known.reasons.push(reason);
      else pages.set(page.slug, { slug: page.slug, title: page.title, reasons: [reason] });
    };
    for (const page of this.dependencies.pagesCitingSessions(projectId, applied)) {
      add(page, "cites_reviewed_session");
    }
    for (const page of this.dependencies.pendingPages(projectId)) add(page, "queued_for_update");
    return [...pages.values()].slice(0, MAX_COMPLETION_PAGES);
  }

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

  /** Only while still active: an edited, replaced or deleted Knowledge is left alone. */
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
    const updated = this.dependencies.updateKnowledge(
      { projectRoot, knowledgeId: current.id, status: "archived" },
      "user",
    );
    return updated.outcome === "knowledge_updated"
      ? { id: current.id, action: "archived", status: "archived" }
      : { id: current.id, action: "unchanged", status: current.status };
  }

  /** Each undo step happens only while nothing else changed that Knowledge since the verdict. */
  private overturnKnowledge(projectId: string, projectRoot: string, knowledgeId: string): OverturnAgentReviewResult {
    return runImmediateTransaction(this.db, (): OverturnAgentReviewResult => {
      if (this.knowledgeRows(projectId, [knowledgeId]).length === 0)
        return { outcome: "not_found", itemId: knowledgeId };
      const standing = this.db
        .prepare(
          `SELECT * FROM agent_review_request_items
           WHERE project_id = ? AND item_kind = 'knowledge' AND item_id = ? AND outcome = 'applied' AND overturned_at IS NULL
           ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectId, knowledgeId) as ItemRow | undefined;
      if (!standing) return { outcome: "rejected", reason: "not_agent_reviewed" };
      let action: "confirmation_withdrawn" | "restored" | "unchanged" = "unchanged";
      let created: ReturnType<AgentReviewService["archiveCreated"]> | undefined;
      if (standing.verdict === "confirm") {
        const withdrawn = this.dependencies.withdrawConfirmation(projectId, knowledgeId, standing.decided_at ?? "");
        if (withdrawn?.withdrawn) action = "confirmation_withdrawn";
      } else {
        if (standing.verdict === "supersede") {
          created = this.archiveCreated(projectId, projectRoot, standing.knowledge_id ?? undefined);
        }
        action = this.restoreArchived(projectId, projectRoot, knowledgeId);
      }
      this.db
        .prepare(
          `UPDATE agent_review_request_items SET overturned_at = ?
           WHERE project_id = ? AND item_kind = 'knowledge' AND item_id = ? AND outcome = 'applied' AND overturned_at IS NULL`,
        )
        .run(nowIso(), projectId, knowledgeId);
      const [knowledge] = this.dependencies.withKnowledgeTrustMany([
        toKnowledge(this.knowledgeRows(projectId, [knowledgeId])[0]!),
      ]);
      return {
        outcome: "agent_review_overturned",
        itemKind: "knowledge",
        reviewedKnowledge: { knowledge: knowledge!, action },
        ...(created ? { knowledge: created } : {}),
      };
    });
  }

  private restoreArchived(projectId: string, projectRoot: string, knowledgeId: string): "restored" | "unchanged" {
    const [row] = this.knowledgeRows(projectId, [knowledgeId]);
    if (row?.status !== "archived") return "unchanged";
    const restored = this.dependencies.updateKnowledge({ projectRoot, knowledgeId, status: "active" });
    return restored.outcome === "knowledge_updated" ? "restored" : "unchanged";
  }

  private pendingRows(request: RequestRow, itemIds: readonly string[]): PendingRows {
    const itemRows = this.db
      .prepare(
        "SELECT * FROM agent_review_request_items WHERE request_id = ? AND item_id IN (SELECT value FROM json_each(?))",
      )
      .all(request.id, JSON.stringify(itemIds)) as ItemRow[];
    return {
      items: new Map(itemRows.map((item) => [itemKey(item.item_kind, item.item_id), item])),
      ...this.currentRows(request.project_id, itemRows),
    };
  }

  private currentRows(projectId: string, itemRows: readonly ItemRow[]): CurrentRows {
    const idsOf = (kind: AgentReviewItemKind): string[] =>
      itemRows.filter((item) => item.item_kind === kind).map((item) => item.item_id);
    const decisionIds = idsOf("decision");
    const candidateIds = idsOf("candidate");
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
      knowledge: new Map(
        this.trusted(this.knowledgeRows(projectId, idsOf("knowledge"))).map((trusted) => [trusted.row.id, trusted]),
      ),
    };
  }

  private knowledgeRows(projectId: string | undefined, ids: readonly string[]): KnowledgeRow[] {
    if (ids.length === 0) return [];
    return this.db
      .prepare(
        `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
         WHERE k.id IN (SELECT value FROM json_each(?)) ${projectId ? "AND k.project_id = ?" : ""}`,
      )
      .all(JSON.stringify(ids), ...(projectId ? [projectId] : [])) as KnowledgeRow[];
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

  private siblingDecisions(sessionIds: readonly string[], excluded: number): Map<string, SiblingDecisionRow[]> {
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
      .all(JSON.stringify(sessionIds), SIBLING_DECISIONS_SHOWN + 1 + excluded) as SiblingDecisionRow[];
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

  private toRequests(rows: readonly RequestRow[]): AgentReviewRequest[] {
    if (rows.length === 0) return [];
    const counts = new Map(
      (
        this.db
          .prepare(
            `SELECT request_id,
                    SUM(item_kind = 'decision') AS decision_count,
                    SUM(item_kind = 'candidate') AS candidate_count,
                    SUM(item_kind = 'knowledge') AS knowledge_count,
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
        knowledgeCount: count?.knowledge_count ?? 0,
        appliedCount: count?.applied_count ?? 0,
        skippedCount: count?.skipped_count ?? 0,
        openCount: count?.open_count ?? 0,
      };
    });
  }

  private withKnowledgePages(requests: AgentReviewRequest[], rows: readonly RequestRow[]): AgentReviewRequest[] {
    const pagesById = new Map<string, AgentReviewKnowledgePage[]>();
    for (const row of rows) {
      if (row.status !== "completed") continue;
      pagesById.set(
        row.id,
        parseStoredPages(row.completion_pages_json) ?? this.completionPages(row.id, row.project_id),
      );
    }
    if (pagesById.size === 0) return requests;
    const projectIds = [...new Set(rows.filter((row) => pagesById.has(row.id)).map((row) => row.project_id))];
    const slugs = [...new Set([...pagesById.values()].flatMap((pages) => pages.map((page) => page.slug)))];
    const pending = new Map(
      projectIds.map((projectId) => [
        projectId,
        new Set(this.dependencies.pendingPages(projectId).map((page) => page.slug)),
      ]),
    );
    const savedAt = new Map(
      (slugs.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT kp.project_id AS project_id, kp.slug AS slug, MAX(v.created_at) AS saved_at
                 FROM knowledge_page_versions v JOIN knowledge_pages kp ON kp.id = v.page_id
                 WHERE kp.project_id IN (SELECT value FROM json_each(?)) AND kp.slug IN (SELECT value FROM json_each(?))
                 GROUP BY kp.project_id, kp.slug`,
            )
            .all(JSON.stringify(projectIds), JSON.stringify(slugs)) as Array<{
            project_id: string;
            slug: string;
            saved_at: string;
          }>)
      ).map((row) => [`${row.project_id}\u0000${row.slug}`, row.saved_at]),
    );
    return requests.map((request) => {
      const pages = pagesById.get(request.id);
      if (!pages) return request;
      const queued = pending.get(request.projectId)!;
      const knowledgePages = pages.map((page): AgentReviewRequestPage => ({
        ...page,
        state: pageState(
          page,
          queued.has(page.slug),
          savedAt.get(`${request.projectId}\u0000${page.slug}`),
          request.completedAt,
        ),
      }));
      return { ...request, knowledgePages };
    });
  }

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
      // Lazy cleanup on read paths: once another process migrated the database, reads go on without it.
      if (!isDatabaseSchemaChangedError(error)) throw error;
    }
  }
}

interface Applied {
  results: AgentReviewVerdictResult[];
  redactions: RedactionSummary;
}
