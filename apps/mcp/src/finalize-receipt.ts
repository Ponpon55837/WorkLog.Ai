import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type FinalizeResult = ReturnType<WorkIntelligenceStore["finalizeSession"]>;
type FinalizedResult = Extract<FinalizeResult, { outcome: "finalized" }>;
type WorkSessionRecord = FinalizedResult["session"];
type RelatedOutstandingItems = NonNullable<FinalizedResult["relatedOutstandingItems"]>;

/** The request fields a receipt compares with what was stored. */
interface FinalizeReceiptRequest {
  changedFiles?: readonly string[];
  git?: unknown;
  startedAt?: string;
  completedAt?: string;
  resolvedOutstandingItemIds?: readonly string[];
  supersededOutstandingItemIds?: readonly string[];
}

/** What the Agent learns about its own saved Session: identity, times, and only the facts the server derived. */
export interface FinalizeReceiptSession {
  id: string;
  executionStatus: WorkSessionRecord["executionStatus"];
  completedAt: string;
  updatedAt: string;
  /** Present when the server derived it (from events) or changed the submitted value. */
  startedAt?: string;
  /** Present with a startedAt the server filled in: the earliest recorded event, or the first call it observed. */
  startedAtSource?: "events" | "server_observed";
  verificationStatus?: NonNullable<WorkSessionRecord["verification"]>["status"];
  changedFilesCount: number;
  /** The stored list, only when it differs from the submitted changedFiles (normalized, excluded, or added). */
  changedFiles?: string[];
  /** Git metadata the server read itself because the request carried none. */
  commitSha?: string;
  gitBranch?: string;
  voided?: WorkSessionRecord["voided"];
}

/** Asked when a just-finished save has no start: only evidence may fill it, never an estimate. */
const STARTED_AT_FOLLOW_UP =
  'startedAt is missing. If you have evidence of when this segment began (the hook message "這段工作的開始時間…", transcript timestamps, a handoff), call work_update_session_metadata with { sessionId, startedAt } now. Never estimate; otherwise leave it empty.';

/** Pointers in the same shape as work_get_context: the source title and date are one read away. */
function compactRelatedItems(related: RelatedOutstandingItems): unknown {
  return {
    ...related,
    items: related.items.map((item) => ({
      id: item.id,
      sourceSessionId: item.sourceSessionId,
      text: item.text,
      ...(item.textTruncated ? { textTruncated: true } : {}),
    })),
  };
}

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The Agent-facing finalize result is a receipt: the Session id and times, what the server changed or derived
 * (redaction counts, a stored changed-file list that differs from the request, Git metadata it filled in), the
 * follow-ups, warnings, reminders, and hints. It does not echo the title, summary, workSummary, or changedFiles the
 * Agent just sent. Other outcomes (skipped, idempotency conflict) pass through unchanged, and so does the storage
 * result for every other caller.
 */
export function toFinalizeReceipt(input: FinalizeReceiptRequest, result: FinalizeResult): unknown {
  if (result.outcome !== "finalized") return result;
  const {
    session,
    startedAtSource,
    redactions,
    resolvedOutstandingItemIds,
    supersededOutstandingItemIds,
    relatedOutstandingItems,
    outcome,
    duplicate,
    ...reminders
  } = result;
  const receipt: FinalizeReceiptSession = {
    id: session.id,
    executionStatus: session.executionStatus,
    completedAt: session.completedAt,
    updatedAt: session.updatedAt,
    ...(session.startedAt && session.startedAt !== input.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.startedAt && !input.startedAt && (startedAtSource === "events" || startedAtSource === "server_observed")
      ? { startedAtSource }
      : {}),
    ...(session.verification ? { verificationStatus: session.verification.status } : {}),
    changedFilesCount: session.changedFiles.length,
    ...(sameList(input.changedFiles, session.changedFiles) ? {} : { changedFiles: session.changedFiles }),
    ...(!input.git && session.commitSha ? { commitSha: session.commitSha } : {}),
    ...(!input.git && session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    ...(session.voided ? { voided: session.voided } : {}),
  };
  return {
    outcome,
    duplicate,
    session: receipt,
    ...(redactions && redactions.total > 0 ? { redactions } : {}),
    // Transition results answer a request (empty when nothing applied) or a retry's recovered audit.
    ...(resolvedOutstandingItemIds?.length || input.resolvedOutstandingItemIds?.length
      ? { resolvedOutstandingItemIds: resolvedOutstandingItemIds ?? [] }
      : {}),
    ...(supersededOutstandingItemIds?.length || input.supersededOutstandingItemIds?.length
      ? { supersededOutstandingItemIds: supersededOutstandingItemIds ?? [] }
      : {}),
    ...(!session.startedAt && !input.completedAt
      ? {
          startedAtFollowUp: STARTED_AT_FOLLOW_UP,
          suggestedCall: { tool: "work_update_session_metadata", arguments: { sessionId: session.id } },
        }
      : {}),
    ...reminders,
    ...(relatedOutstandingItems ? { relatedOutstandingItems: compactRelatedItems(relatedOutstandingItems) } : {}),
  };
}
