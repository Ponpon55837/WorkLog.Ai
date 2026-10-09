import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CancelOutstandingCleanupRequestResult,
  CreateOutstandingCleanupRequestInput,
  CreateOutstandingCleanupRequestResult,
  DecideOutstandingCleanupProposalsInput,
  DecideOutstandingCleanupProposalsResult,
  OutstandingCleanupContextQuery,
  OutstandingCleanupContextResult,
  OutstandingCleanupItem,
  OutstandingCleanupProposal,
  OutstandingCleanupProposalListResult,
  OutstandingCleanupProposalQuery,
  OutstandingCleanupRequest,
  OutstandingCleanupRequestListResult,
  OutstandingCleanupRequestQuery,
  OutstandingCleanupRequestStatus,
  OutstandingCleanupSession,
  PolicyDecision,
  ProjectIdSkippedResult,
  SubmitOutstandingCleanupProposalsInput,
  SubmitOutstandingCleanupProposalsResult,
  VerificationStatus,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { createPageInfo } from "./pagination.js";
import { redactText } from "./secret-redaction.js";
import type { SessionRow } from "./session-repository.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

interface CleanupDependencies {
  checkProjectById(projectId: string): PolicyDecision;
}

type RequestRow = {
  id: string;
  project_id: string;
  project_name: string;
  status: OutstandingCleanupRequestStatus;
  requested_at: string;
  completed_at: string | null;
  item_count: number;
  examined_count: number;
  proposal_count: number;
  pending_proposal_count: number;
};

type SnapshotRow = {
  id: string;
  request_id: string;
  project_id: string;
  item_id: string;
  source_session_id: string;
  position: number;
  text: string;
  item_updated_at: string;
  source_updated_at: string;
  source_fingerprint: string;
  source_completed_at: string;
  examined_submission_id: string | null;
  current_status: string;
  current_updated_at: string;
  current_text: string;
};

type ProposalRow = {
  id: string;
  request_id: string;
  project_id: string;
  request_item_id: string;
  submission_id: string;
  target_status: "completed" | "not_needed";
  reason: string;
  review_status: "pending" | "accepted" | "rejected";
  created_at: string;
  decided_at: string | null;
};

type EvidenceRow = {
  proposal_id: string;
  session_id: string;
  session_updated_at: string;
  session_fingerprint: string;
  session_completed_at: string;
};

const MAX_SNAPSHOT_ITEMS = 10_000;
const CONTEXT_BUDGET = 24_000;
const REQUEST_SELECT = `SELECT r.*, p.name AS project_name,
  (SELECT COUNT(*) FROM outstanding_cleanup_request_items ci WHERE ci.request_id = r.id AND ci.examined_submission_id IS NOT NULL) AS examined_count,
  (SELECT COUNT(*) FROM outstanding_cleanup_proposals cp WHERE cp.request_id = r.id) AS proposal_count,
  (SELECT COUNT(*) FROM outstanding_cleanup_proposals cp WHERE cp.request_id = r.id AND cp.review_status = 'pending') AS pending_proposal_count
  FROM outstanding_cleanup_requests r JOIN projects p ON p.id = r.project_id`;
const SNAPSHOT_SELECT = `SELECT ci.*, i.status AS current_status, i.updated_at AS current_updated_at, i.text AS current_text
  FROM outstanding_cleanup_request_items ci JOIN outstanding_items i ON i.id = ci.item_id AND i.project_id = ci.project_id`;

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bounded(value: string, limit: number): { text: string; truncated: boolean } {
  return { text: value.slice(0, limit), truncated: value.length > limit };
}

function validIds(ids: readonly string[], max = 100): boolean {
  return (
    ids.length > 0 &&
    ids.length <= max &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === "string" && Boolean(id.trim()) && id === id.trim() && id.length <= 200)
  );
}

/** Fingerprints structured evidence as well as time, so corrections in the same millisecond still invalidate it. */
function sessionFingerprint(row: SessionRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.title,
        row.summary,
        row.work_summary_json,
        row.verification_json,
        row.completed_at,
        row.commit_sha,
        row.git_branch,
        row.changed_files_json,
        row.changed_files_confirmed ?? 0,
        row.changed_files_provenance_json,
        row.changed_file_changes_json,
        row.voided_at,
      ]),
    )
    .digest("hex");
}

function sessionVersion(row: SessionRow): string {
  return row.updated_at ?? row.created_at;
}

function toRequest(row: RequestRow): OutstandingCleanupRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name.slice(0, 160),
    ...(row.project_name.length > 160 ? { projectNameTruncated: true } : {}),
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    itemCount: row.item_count,
    examinedCount: row.examined_count,
    proposalCount: row.proposal_count,
    pendingProposalCount: row.pending_proposal_count,
  };
}

function snapshotIsStale(row: SnapshotRow, source: SessionRow | undefined): boolean {
  return (
    !source ||
    Boolean(source.voided_at) ||
    source.status !== "finalized" ||
    source.project_id !== row.project_id ||
    row.current_status !== "pending" ||
    row.current_updated_at !== row.item_updated_at ||
    row.current_text !== row.text ||
    sessionVersion(source) !== row.source_updated_at ||
    sessionFingerprint(source) !== row.source_fingerprint
  );
}

function evidenceIsEligible(source: SessionRow | undefined, row: SnapshotRow, cutoff: string): source is SessionRow {
  return Boolean(
    source &&
    source.project_id === row.project_id &&
    !source.voided_at &&
    source.status === "finalized" &&
    source.execution_status === "completed" &&
    source.completed_at > row.source_completed_at &&
    source.completed_at <= cutoff &&
    source.created_at <= cutoff,
  );
}

function safePullRequest(reference: string): boolean {
  try {
    const url = new URL(reference);
    return url.protocol === "https:" && !url.username && !url.password && /\/pull\/\d+(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Holds evidence-linked proposals without transitioning items until a human accepts them in the Web UI. */
export class OutstandingCleanupService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: CleanupDependencies,
  ) {}

  public listRequests(input: OutstandingCleanupRequestQuery = {}): OutstandingCleanupRequestListResult {
    if (input.projectId) {
      const denied = this.denied(input.projectId);
      if (denied) return denied;
    }
    const where = `WHERE p.status = 'tracked' ${input.projectId ? "AND r.project_id = ?" : ""} ${input.status ? "AND r.status = ?" : ""}`;
    const parameters = [...(input.projectId ? [input.projectId] : []), ...(input.status ? [input.status] : [])];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM outstanding_cleanup_requests r JOIN projects p ON p.id = r.project_id ${where}`,
        )
        .get(...parameters) as { count: number }
    ).count;
    const pageInfo = createPageInfo(input.page, input.pageSize ?? 5, total, 100);
    const rows = this.db
      .prepare(`${REQUEST_SELECT} ${where} ORDER BY r.requested_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as RequestRow[];
    return { outcome: "outstanding_cleanup_requests", requests: rows.map(toRequest), pageInfo };
  }

  public context(input: OutstandingCleanupContextQuery): OutstandingCleanupContextResult {
    const request = this.request(input.requestId);
    if (!request) return { outcome: "not_found", requestId: input.requestId };
    const denied = this.denied(request.project_id);
    if (denied) return denied;
    const total = (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM outstanding_cleanup_request_items WHERE request_id = ?")
        .get(request.id) as { count: number }
    ).count;
    const itemPageInfo = createPageInfo(input.itemPage, input.itemPageSize ?? 5, total, 5);
    const rows = this.db
      .prepare(`${SNAPSHOT_SELECT} WHERE ci.request_id = ? ORDER BY ci.position, ci.id LIMIT ? OFFSET ?`)
      .all(request.id, itemPageInfo.pageSize, (itemPageInfo.page - 1) * itemPageInfo.pageSize) as SnapshotRow[];
    const sources = this.sessions(
      rows.map((row) => row.source_session_id),
      request.project_id,
    );
    const items: OutstandingCleanupItem[] = rows.map((row) => {
      const source = sources.get(row.source_session_id);
      const text = bounded(row.text, 400);
      const title = bounded(source?.title ?? "", 160);
      return {
        id: row.item_id,
        sourceSessionId: row.source_session_id,
        sourceSessionTitle: title.text,
        sourceSessionCompletedAt: row.source_completed_at,
        text: text.text,
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(title.truncated ? { sourceSessionTitleTruncated: true } : {}),
        examined: Boolean(row.examined_submission_id),
        stale: snapshotIsStale(row, source),
      };
    });
    const earliestSource = rows.map((row) => row.source_completed_at).sort()[0] ?? request.requested_at;
    const sourceWhere =
      "project_id = ? AND voided_at IS NULL AND status = 'finalized' AND execution_status = 'completed' AND completed_at > ? AND completed_at <= ? AND created_at <= ?";
    const sourceParameters = [request.project_id, earliestSource, request.requested_at, request.requested_at];
    const sessionTotal = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${sourceWhere}`).get(...sourceParameters) as {
        count: number;
      }
    ).count;
    const sessionPageInfo = createPageInfo(input.sessionPage, input.sessionPageSize ?? 10, sessionTotal, 10);
    const sessionRows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${sourceWhere} ORDER BY completed_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(
        ...sourceParameters,
        sessionPageInfo.pageSize,
        (sessionPageInfo.page - 1) * sessionPageInfo.pageSize,
      ) as SessionRow[];
    const references = this.pullRequests(sessionRows.map((row) => row.id));
    const sessions: OutstandingCleanupSession[] = sessionRows.map((row) => {
      const title = bounded(row.title, 160);
      const summary = bounded(row.summary, 400);
      const workSummary = parseObject(row.work_summary_json);
      const outcomes = Array.isArray(workSummary.outcomes)
        ? workSummary.outcomes.filter((value): value is string => typeof value === "string")
        : [];
      const shownOutcomes = outcomes.slice(0, 3).map((value) => bounded(value, 240));
      const verification = parseObject(row.verification_json).status;
      const verificationStatus: VerificationStatus | "not_supplied" =
        verification === "passed" ||
        verification === "failed" ||
        verification === "in_progress" ||
        verification === "not_run"
          ? verification
          : "not_supplied";
      const links = references.get(row.id) ?? { values: [], total: 0 };
      return {
        id: row.id,
        title: title.text,
        ...(title.truncated ? { titleTruncated: true } : {}),
        summary: summary.text,
        ...(summary.truncated ? { summaryTruncated: true } : {}),
        completedAt: row.completed_at,
        outcomes: shownOutcomes.map((value) => value.text),
        outcomesOmitted: Math.max(0, outcomes.length - shownOutcomes.length),
        outcomesTruncated: shownOutcomes.some((value) => value.truncated),
        verificationStatus,
        ...(row.git_branch ? { branch: row.git_branch.slice(0, 120) } : {}),
        ...(row.git_branch && row.git_branch.length > 120 ? { branchTruncated: true } : {}),
        ...(row.commit_sha ? { commitSha: row.commit_sha.slice(0, 80) } : {}),
        ...(row.commit_sha && row.commit_sha.length > 80 ? { commitShaTruncated: true } : {}),
        pullRequests: links.values,
        pullRequestsOmitted: Math.max(0, links.total - links.values.length),
      };
    });
    const result: Extract<OutstandingCleanupContextResult, { outcome: "outstanding_cleanup_context" }> = {
      outcome: "outstanding_cleanup_context",
      request: toRequest(request),
      items,
      itemPageInfo,
      sessions,
      sessionPageInfo,
      hint: "逐頁檢查固定項目與之後的來源；截短摘要只是指標，請讀完整 Session 核對成果與 PR。只有明確完成或已被取代才提出附證據 ID 的建議，證據不足只回報已檢查且不提建議。stale 項目不提建議；狀態只能由使用者在 Web 接受後變更。",
      truncated:
        request.project_name.length > 160 ||
        items.some((item) => item.textTruncated || item.sourceSessionTitleTruncated) ||
        sessions.some(
          (session) =>
            session.titleTruncated ||
            session.summaryTruncated ||
            session.branchTruncated ||
            session.commitShaTruncated ||
            session.outcomesTruncated ||
            session.outcomesOmitted > 0 ||
            session.pullRequestsOmitted > 0,
        ),
    };
    this.fitContext(result);
    // Imported identities and timestamps remain intact; never return an over-budget or incomplete page.
    if (JSON.stringify(result).length > CONTEXT_BUDGET) {
      return { outcome: "rejected", reason: "context_too_large", requestId: input.requestId };
    }
    return result;
  }

  public listProposals(input: OutstandingCleanupProposalQuery): OutstandingCleanupProposalListResult {
    const request = this.request(input.requestId);
    if (!request) return { outcome: "not_found", requestId: input.requestId };
    const denied = this.denied(request.project_id);
    if (denied) return denied;
    const clause = input.reviewStatus ? "AND review_status = ?" : "";
    const parameters = [request.id, ...(input.reviewStatus ? [input.reviewStatus] : [])];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM outstanding_cleanup_proposals WHERE request_id = ? ${clause}`)
        .get(...parameters) as { count: number }
    ).count;
    const pageInfo = createPageInfo(input.page, input.pageSize ?? 10, total, 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM outstanding_cleanup_proposals WHERE request_id = ? ${clause} ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize) as ProposalRow[];
    return {
      outcome: "outstanding_cleanup_proposals",
      request: toRequest(request),
      proposals: this.proposals(rows, request),
      pageInfo,
    };
  }

  public create(input: CreateOutstandingCleanupRequestInput): CreateOutstandingCleanupRequestResult {
    const denied = this.denied(input.projectId);
    if (denied) return denied;
    return runImmediateTransaction(this.db, () => {
      const currentDenied = this.denied(input.projectId);
      if (currentDenied) return currentDenied;
      const previous = this.db
        .prepare("SELECT id, project_id FROM outstanding_cleanup_requests WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: string; project_id: string } | undefined;
      if (previous) {
        if (previous.project_id !== input.projectId) return { outcome: "rejected", reason: "idempotency_conflict" };
        const request = this.request(previous.id);
        if (request)
          return { outcome: "outstanding_cleanup_request_created", request: toRequest(request), duplicate: true };
      }
      const active = this.db
        .prepare(
          "SELECT id FROM outstanding_cleanup_requests WHERE project_id = ? AND status IN ('pending', 'awaiting_review')",
        )
        .get(input.projectId) as { id: string } | undefined;
      if (active) return { outcome: "rejected", reason: "active_request_exists", requestId: active.id };
      const pending = this.db
        .prepare(
          `SELECT i.id, i.source_session_id, i.text, i.updated_at FROM outstanding_items i
        JOIN sessions s ON s.id = i.source_session_id AND s.project_id = i.project_id
        WHERE i.project_id = ? AND i.status = 'pending' AND s.voided_at IS NULL
        ORDER BY s.completed_at, i.source_session_id, i.position, i.id LIMIT ?`,
        )
        .all(input.projectId, MAX_SNAPSHOT_ITEMS + 1) as Array<{
        id: string;
        source_session_id: string;
        text: string;
        updated_at: string;
      }>;
      if (!pending.length) return { outcome: "not_needed", projectId: input.projectId };
      if (pending.length > MAX_SNAPSHOT_ITEMS) return { outcome: "rejected", reason: "too_many_items" };
      const id = randomUUID();
      const at = nowIso();
      this.db
        .prepare(
          "INSERT INTO outstanding_cleanup_requests (id, project_id, idempotency_key, status, requested_at, item_count) VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .run(id, input.projectId, input.idempotencyKey, at, pending.length);
      const sources = this.sessions(
        pending.map((item) => item.source_session_id),
        input.projectId,
      );
      const insert = this.db.prepare(`INSERT INTO outstanding_cleanup_request_items
        (id, request_id, project_id, item_id, source_session_id, position, text, item_updated_at, source_updated_at, source_fingerprint, source_completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      pending.forEach((item, position) => {
        const source = sources.get(item.source_session_id);
        if (!source) throw new Error("Missing cleanup source");
        insert.run(
          randomUUID(),
          id,
          input.projectId,
          item.id,
          source.id,
          position,
          item.text,
          item.updated_at,
          sessionVersion(source),
          sessionFingerprint(source),
          source.completed_at,
        );
      });
      const request = this.request(id);
      if (!request) throw new Error("Missing cleanup request");
      return { outcome: "outstanding_cleanup_request_created", request: toRequest(request), duplicate: false };
    });
  }

  public submit(input: SubmitOutstandingCleanupProposalsInput): SubmitOutstandingCleanupProposalsResult {
    const request = this.request(input.requestId);
    if (!request) return { outcome: "not_found", requestId: input.requestId };
    const denied = this.denied(request.project_id);
    if (denied) return denied;
    if (
      !validIds(input.examinedItemIds) ||
      input.proposals.length > 100 ||
      new Set(input.proposals.map((proposal) => proposal.itemId)).size !== input.proposals.length ||
      input.proposals.some(
        (proposal) =>
          !input.examinedItemIds.includes(proposal.itemId) ||
          !validIds(proposal.evidenceSessionIds, 10) ||
          !proposal.reason.trim() ||
          proposal.reason.length > 2_000 ||
          (proposal.status !== "completed" && proposal.status !== "not_needed"),
      )
    ) {
      return { outcome: "rejected", reason: "invalid_proposals" };
    }
    // Sort identifiers and proposals before hashing so set ordering is not a new submission.
    const normalized = {
      examinedItemIds: [...input.examinedItemIds].sort(),
      proposals: input.proposals
        .map((proposal) => ({
          itemId: proposal.itemId,
          status: proposal.status,
          reason: proposal.reason.trim(),
          evidenceSessionIds: [...proposal.evidenceSessionIds].sort(),
        }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId)),
    };
    const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    return runImmediateTransaction(this.db, () => {
      const currentDenied = this.denied(request.project_id);
      if (currentDenied) return currentDenied;
      const previous = this.db
        .prepare(
          "SELECT id, payload_hash FROM outstanding_cleanup_submissions WHERE request_id = ? AND idempotency_key = ?",
        )
        .get(request.id, input.idempotencyKey) as { id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== hash) return { outcome: "rejected", reason: "idempotency_conflict" };
        return this.submissionResult(request.id, previous.id, true);
      }
      const current = this.request(request.id);
      if (!current || current.status !== "pending") return { outcome: "rejected", reason: "request_closed" };
      const snapshots = this.snapshotsByItem(request.id, input.examinedItemIds);
      const byItem = new Map(snapshots.map((row) => [row.item_id, row]));
      const invalid = input.examinedItemIds.filter((id) => !byItem.has(id));
      if (invalid.length) return { outcome: "rejected", reason: "invalid_items", itemIds: invalid };
      const examined = snapshots.filter((row) => row.examined_submission_id).map((row) => row.item_id);
      if (examined.length) return { outcome: "rejected", reason: "already_examined", itemIds: examined };
      const sourceIds = [
        ...snapshots.map((row) => row.source_session_id),
        ...normalized.proposals.flatMap((proposal) => proposal.evidenceSessionIds),
      ];
      const sources = this.sessions(sourceIds, current.project_id);
      const stale = normalized.proposals
        .filter((proposal) => {
          const snapshot = byItem.get(proposal.itemId);
          return !snapshot || snapshotIsStale(snapshot, sources.get(snapshot.source_session_id));
        })
        .map((proposal) => proposal.itemId);
      if (stale.length) return { outcome: "rejected", reason: "stale_proposal", itemIds: stale };
      const badEvidence = normalized.proposals
        .filter((proposal) => {
          const snapshot = byItem.get(proposal.itemId);
          return (
            !snapshot ||
            proposal.evidenceSessionIds.some(
              (id) => !evidenceIsEligible(sources.get(id), snapshot, current.requested_at),
            )
          );
        })
        .map((proposal) => proposal.itemId);
      if (badEvidence.length) return { outcome: "rejected", reason: "invalid_evidence", itemIds: badEvidence };
      const submissionId = randomUUID();
      const at = nowIso();
      this.db
        .prepare(
          "INSERT INTO outstanding_cleanup_submissions (id, request_id, project_id, idempotency_key, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(submissionId, current.id, current.project_id, input.idempotencyKey, hash, at);
      const insertProposal = this.db.prepare(`INSERT INTO outstanding_cleanup_proposals
        (id, request_id, project_id, request_item_id, submission_id, target_status, reason, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
      const insertEvidence = this.db.prepare(`INSERT INTO outstanding_cleanup_proposal_evidence
        (id, proposal_id, project_id, session_id, session_updated_at, session_fingerprint, session_completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const proposal of normalized.proposals) {
        const snapshot = byItem.get(proposal.itemId);
        if (!snapshot) throw new Error("Missing cleanup item");
        const proposalId = randomUUID();
        insertProposal.run(
          proposalId,
          current.id,
          current.project_id,
          snapshot.id,
          submissionId,
          proposal.status,
          redactText(proposal.reason).value,
          at,
        );
        for (const sessionId of proposal.evidenceSessionIds) {
          const source = sources.get(sessionId);
          if (!source) throw new Error("Missing cleanup evidence");
          insertEvidence.run(
            randomUUID(),
            proposalId,
            current.project_id,
            sessionId,
            sessionVersion(source),
            sessionFingerprint(source),
            source.completed_at,
          );
        }
      }
      this.db
        .prepare(
          "UPDATE outstanding_cleanup_request_items SET examined_submission_id = ? WHERE request_id = ? AND item_id IN (SELECT value FROM json_each(?))",
        )
        .run(submissionId, current.id, JSON.stringify(input.examinedItemIds));
      this.refreshStatus(current.id, at);
      return this.submissionResult(current.id, submissionId, false);
    });
  }

  public decide(input: DecideOutstandingCleanupProposalsInput): DecideOutstandingCleanupProposalsResult {
    const request = this.request(input.requestId);
    if (!request) return { outcome: "not_found", requestId: input.requestId };
    const denied = this.denied(request.project_id);
    if (denied) return denied;
    if (!validIds(input.proposalIds) || (input.decision !== "accept" && input.decision !== "reject"))
      return { outcome: "rejected", reason: "invalid_proposals" };
    return runImmediateTransaction(this.db, () => {
      const currentDenied = this.denied(request.project_id);
      if (currentDenied) return currentDenied;
      const current = this.request(request.id);
      if (!current || current.status === "cancelled") return { outcome: "rejected", reason: "request_closed" };
      const rows = this.db
        .prepare(
          "SELECT * FROM outstanding_cleanup_proposals WHERE request_id = ? AND id IN (SELECT value FROM json_each(?))",
        )
        .all(current.id, JSON.stringify(input.proposalIds)) as ProposalRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const invalid = input.proposalIds.filter((id) => !byId.has(id));
      if (invalid.length) return { outcome: "rejected", reason: "invalid_proposals", proposalIds: invalid };
      const target = input.decision === "accept" ? "accepted" : "rejected";
      const already = rows
        .filter((row) => row.review_status !== "pending" && row.review_status !== target)
        .map((row) => row.id);
      if (already.length) return { outcome: "rejected", reason: "already_decided", proposalIds: already };
      const pending = rows.filter((row) => row.review_status === "pending");
      const proposals = this.proposals(pending, current);
      if (input.decision === "accept") {
        const stale = proposals.filter((proposal) => proposal.stale).map((proposal) => proposal.id);
        if (stale.length) return { outcome: "rejected", reason: "stale_proposal", proposalIds: stale };
      }
      const at = nowIso();
      const update = this.db.prepare(
        "UPDATE outstanding_cleanup_proposals SET review_status = ?, decided_at = ? WHERE id = ? AND review_status = 'pending'",
      );
      const itemUpdate = this.db.prepare(
        "UPDATE outstanding_items SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      );
      const event = this.db.prepare(`INSERT INTO outstanding_item_events
        (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at, cleanup_request_id, cleanup_proposal_id)
        VALUES (?, ?, ?, 'pending', ?, 'web', NULL, ?, ?, ?)`);
      const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
      for (const row of pending) {
        update.run(target, at, row.id);
        if (input.decision === "accept") {
          const proposal = proposalById.get(row.id);
          if (!proposal) throw new Error("Missing cleanup proposal");
          itemUpdate.run(row.target_status, at, proposal.itemId);
          event.run(randomUUID(), proposal.itemId, current.project_id, row.target_status, at, current.id, row.id);
        }
      }
      this.refreshStatus(current.id, at);
      const updated = this.request(current.id);
      if (!updated) throw new Error("Missing cleanup request");
      return {
        outcome: "outstanding_cleanup_proposals_decided",
        request: toRequest(updated),
        proposalIds: [...input.proposalIds],
        decision: input.decision,
        duplicate: pending.length === 0,
      };
    });
  }

  public cancel(requestId: string): CancelOutstandingCleanupRequestResult {
    const request = this.request(requestId);
    if (!request) return { outcome: "not_found", requestId };
    const denied = this.denied(request.project_id);
    if (denied) return denied;
    return runImmediateTransaction(this.db, () => {
      const currentDenied = this.denied(request.project_id);
      if (currentDenied) return currentDenied;
      const current = this.request(request.id);
      if (!current) return { outcome: "not_found", requestId };
      if (current.status === "completed") return { outcome: "rejected", reason: "request_closed" };
      const duplicate = current.status === "cancelled";
      if (!duplicate)
        this.db
          .prepare("UPDATE outstanding_cleanup_requests SET status = 'cancelled', completed_at = ? WHERE id = ?")
          .run(nowIso(), request.id);
      const updated = this.request(request.id);
      if (!updated) throw new Error("Missing cleanup request");
      return { outcome: "outstanding_cleanup_request_cancelled", request: toRequest(updated), duplicate };
    });
  }

  private denied(projectId: string): ProjectIdSkippedResult | undefined {
    const policy = this.dependencies.checkProjectById(projectId);
    return policy.allowed && policy.project
      ? undefined
      : {
          outcome: "skipped",
          projectId,
          projectStatus: policy.projectStatus,
          reason: policy.reason ?? "Project recording is not enabled.",
        };
  }

  private request(id: string): RequestRow | undefined {
    return this.db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  }

  private sessions(ids: readonly string[], projectId: string): Map<string, SessionRow> {
    if (!ids.length) return new Map();
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))")
      .all(projectId, JSON.stringify([...new Set(ids)])) as SessionRow[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  private snapshotsByItem(requestId: string, ids: readonly string[]): SnapshotRow[] {
    return this.db
      .prepare(`${SNAPSHOT_SELECT} WHERE ci.request_id = ? AND ci.item_id IN (SELECT value FROM json_each(?))`)
      .all(requestId, JSON.stringify(ids)) as SnapshotRow[];
  }

  private proposals(rows: ProposalRow[], request: RequestRow): OutstandingCleanupProposal[] {
    if (!rows.length) return [];
    const snapshots = this.db
      .prepare(`${SNAPSHOT_SELECT} WHERE ci.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(rows.map((row) => row.request_item_id))) as SnapshotRow[];
    const snapshotsById = new Map(snapshots.map((row) => [row.id, row]));
    const evidence = this.db
      .prepare(
        "SELECT * FROM outstanding_cleanup_proposal_evidence WHERE proposal_id IN (SELECT value FROM json_each(?)) ORDER BY session_id",
      )
      .all(JSON.stringify(rows.map((row) => row.id))) as EvidenceRow[];
    const evidenceByProposal = new Map<string, EvidenceRow[]>();
    for (const row of evidence) {
      const group = evidenceByProposal.get(row.proposal_id) ?? [];
      group.push(row);
      evidenceByProposal.set(row.proposal_id, group);
    }
    const sessions = this.sessions(
      [...snapshots.map((row) => row.source_session_id), ...evidence.map((row) => row.session_id)],
      request.project_id,
    );
    return rows.map((row) => {
      const snapshot = snapshotsById.get(row.request_item_id);
      const cited = evidenceByProposal.get(row.id) ?? [];
      const stale =
        request.status === "cancelled" ||
        !snapshot ||
        snapshotIsStale(snapshot, sessions.get(snapshot.source_session_id)) ||
        !cited.length ||
        cited.some((proof) => {
          const source = sessions.get(proof.session_id);
          return (
            !snapshot ||
            !evidenceIsEligible(source, snapshot, request.requested_at) ||
            sessionVersion(source) !== proof.session_updated_at ||
            sessionFingerprint(source) !== proof.session_fingerprint ||
            source.completed_at !== proof.session_completed_at
          );
        });
      return {
        id: row.id,
        requestId: row.request_id,
        itemId: snapshot?.item_id ?? "",
        sourceSessionId: snapshot?.source_session_id ?? "",
        itemText: snapshot?.text ?? "",
        status: row.target_status,
        reason: row.reason,
        evidenceSessionIds: cited.map((proof) => proof.session_id),
        reviewStatus: row.review_status,
        createdAt: row.created_at,
        ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
        stale: row.review_status === "pending" && stale,
      };
    });
  }

  private submissionResult(
    requestId: string,
    submissionId: string,
    duplicate: boolean,
  ): SubmitOutstandingCleanupProposalsResult {
    const request = this.request(requestId);
    if (!request) return { outcome: "not_found", requestId };
    const examined = this.db
      .prepare(
        "SELECT item_id FROM outstanding_cleanup_request_items WHERE examined_submission_id = ? ORDER BY item_id",
      )
      .all(submissionId) as Array<{ item_id: string }>;
    const proposals = this.db
      .prepare("SELECT id FROM outstanding_cleanup_proposals WHERE submission_id = ? ORDER BY id")
      .all(submissionId) as Array<{ id: string }>;
    return {
      outcome: "outstanding_cleanup_proposals_submitted",
      request: toRequest(request),
      examinedItemIds: examined.map((row) => row.item_id),
      proposalIds: proposals.map((row) => row.id),
      duplicate,
    };
  }

  private refreshStatus(requestId: string, at: string): void {
    const request = this.request(requestId);
    if (!request || request.status === "cancelled") return;
    const allExamined = request.examined_count === request.item_count;
    const status = allExamined ? (request.pending_proposal_count > 0 ? "awaiting_review" : "completed") : "pending";
    this.db
      .prepare("UPDATE outstanding_cleanup_requests SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, status === "completed" ? at : null, requestId);
  }

  private pullRequests(sessionIds: string[]): Map<string, { values: string[]; total: number }> {
    if (!sessionIds.length) return new Map();
    const rows = this.db
      .prepare(
        `WITH links AS (
      SELECT session_id, reference, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY captured_at DESC, id) AS position,
        COUNT(*) OVER (PARTITION BY session_id) AS total
      FROM evidence WHERE session_id IN (SELECT value FROM json_each(?)) AND voided_at IS NULL AND reference LIKE 'https://%/pull/%'
    ) SELECT * FROM links WHERE position <= 4`,
      )
      .all(JSON.stringify(sessionIds)) as Array<{ session_id: string; reference: string; total: number }>;
    const result = new Map<string, { values: string[]; total: number }>();
    for (const row of rows) {
      const group = result.get(row.session_id) ?? { values: [], total: row.total };
      if (safePullRequest(row.reference) && row.reference.length <= 500 && group.values.length < 3)
        group.values.push(row.reference);
      result.set(row.session_id, group);
    }
    return result;
  }

  private fitContext(
    result: Extract<OutstandingCleanupContextResult, { outcome: "outstanding_cleanup_context" }>,
  ): void {
    if (result.request.projectName.length > 160) {
      result.request.projectName = result.request.projectName.slice(0, 160);
      result.request.projectNameTruncated = true;
      result.truncated = true;
    }
    // Shorten each field rather than skipping rows: a page must not silently lose examined item IDs.
    let limit = 200;
    while (JSON.stringify(result).length > CONTEXT_BUDGET && limit >= 25) {
      for (const item of result.items) {
        if (item.text.length > limit) {
          item.text = item.text.slice(0, limit);
          item.textTruncated = true;
        }
        if (item.sourceSessionTitle.length > limit) {
          item.sourceSessionTitle = item.sourceSessionTitle.slice(0, limit);
          item.sourceSessionTitleTruncated = true;
        }
      }
      for (const session of result.sessions) {
        if (session.summary.length > limit) {
          session.summary = session.summary.slice(0, limit);
          session.summaryTruncated = true;
        }
        if (session.title.length > limit) {
          session.title = session.title.slice(0, limit);
          session.titleTruncated = true;
        }
        session.outcomes = session.outcomes.map((outcome) => {
          if (outcome.length <= limit) return outcome;
          session.outcomesTruncated = true;
          return outcome.slice(0, limit);
        });
        if (session.pullRequests.length) {
          session.pullRequestsOmitted += session.pullRequests.length;
          session.pullRequests = [];
        }
      }
      result.truncated = true;
      limit = Math.floor(limit / 2);
    }
  }
}
