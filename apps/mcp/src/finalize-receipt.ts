import type { WorkIntelligenceStore } from "@work-intelligence/storage";
import { compactChangeStatusFollowUp } from "./change-status-follow-up.js";

type FinalizeResult = ReturnType<WorkIntelligenceStore["finalizeSession"]>;
type FinalizedResult = Extract<FinalizeResult, { outcome: "finalized" }>;
type WorkSessionRecord = FinalizedResult["session"];
type RelatedOutstandingItems = NonNullable<FinalizedResult["relatedOutstandingItems"]>;
type UnreportedKnowledge = NonNullable<FinalizedResult["unreportedKnowledge"]>;

interface FinalizeReceiptRequest {
  changedFiles?: readonly string[];
  changedFileChanges?: readonly unknown[];
  git?: unknown;
  startedAt?: string;
  completedAt?: string;
  resolvedOutstandingItemIds?: readonly string[];
  supersededOutstandingItemIds?: readonly string[];
}

export interface FinalizeReceiptSession {
  id: string;
  /** Omitted while verification is in_progress: the stored value is always "completed" and would read as finished. */
  executionStatus?: WorkSessionRecord["executionStatus"];
  completedAt: string;
  updatedAt: string;
  startedAt?: string;
  startedAtSource?: "events" | "server_observed";
  verificationStatus?: NonNullable<WorkSessionRecord["verification"]>["status"];
  changedFilesCount: number;
  changedFiles?: string[];
  commitSha?: string;
  gitBranch?: string;
  voided?: WorkSessionRecord["voided"];
}

export const IN_PROGRESS_HINT = "Start record: finalize again with the same idempotencyKey to complete it.";

const STARTED_AT_FOLLOW_UP =
  'startedAt is missing. If you have evidence of when this segment began (the hook message "這段工作的開始時間…", transcript timestamps, a handoff), call work_update_session_metadata with { sessionId, startedAt } now. Never estimate; otherwise leave it empty.';

const UNREPORTED_KNOWLEDGE_HINT =
  "這段工作讀過、本筆尚未回報的知識點。確實用上且仍正確的，以 work_update_session_metadata { sessionId, appliedKnowledgeIds } 補報；發現已不正確的放 contradictedKnowledgeIds；沒用上就不必回報。";

const KNOWLEDGE_TO_REVIEW_HINT =
  "Holds: work_update_knowledge confirm: true. Now wrong: tell the user. Unsure: leave it.";

const PENDING_ITEMS_AFTER_SAVE_HINT =
  "逐項讀來源核對；本次已直接驗證完成或被 nextSteps 取代的，用 work_resolve_outstanding_items 結案；無法確認就保留。";

function compactUnreportedKnowledge(unreported: UnreportedKnowledge): unknown {
  return {
    items: unreported.items,
    ...(unreported.total > unreported.items.length ? { total: unreported.total } : {}),
    hint: UNREPORTED_KNOWLEDGE_HINT,
  };
}

function compactRelatedItems(related: RelatedOutstandingItems): unknown {
  return {
    ...related,
    ...(related.hint ? { hint: PENDING_ITEMS_AFTER_SAVE_HINT } : {}),
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

/** A rejected request is a domain outcome, not a transport error: nothing was written and the body names the fix. */
export function toFinalizeReceipt(input: FinalizeReceiptRequest, result: FinalizeResult): unknown {
  if (result.outcome !== "finalized") return result;
  const {
    session,
    startedAtSource,
    redactions,
    resolvedOutstandingItemIds,
    supersededOutstandingItemIds,
    relatedOutstandingItems,
    continuedOutstandingItems,
    outcome,
    duplicate,
    changedFileChangesFollowUp,
    unreportedKnowledge,
    ...reminders
  } = result;
  const inProgress = session.verification?.status === "in_progress";
  const receipt: FinalizeReceiptSession = {
    id: session.id,
    ...(inProgress ? {} : { executionStatus: session.executionStatus }),
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
  const startedAtMissing = !session.startedAt && !input.completedAt;
  return {
    outcome,
    duplicate,
    session: receipt,
    ...(inProgress ? { hint: IN_PROGRESS_HINT } : {}),
    ...(redactions && redactions.total > 0 ? { redactions } : {}),
    ...(resolvedOutstandingItemIds?.length || input.resolvedOutstandingItemIds?.length
      ? { resolvedOutstandingItemIds: resolvedOutstandingItemIds ?? [] }
      : {}),
    ...(supersededOutstandingItemIds?.length || input.supersededOutstandingItemIds?.length
      ? { supersededOutstandingItemIds: supersededOutstandingItemIds ?? [] }
      : {}),
    ...(startedAtMissing ? { startedAtFollowUp: STARTED_AT_FOLLOW_UP } : {}),
    ...(startedAtMissing || changedFileChangesFollowUp
      ? {
          suggestedCall: {
            tool: "work_update_session_metadata",
            arguments: {
              sessionId: session.id,
              ...(changedFileChangesFollowUp ? { changedFilesMode: "merge" } : {}),
            },
          },
        }
      : {}),
    ...(changedFileChangesFollowUp
      ? {
          changedFileChangesFollowUp: compactChangeStatusFollowUp(
            changedFileChangesFollowUp,
            input,
            !!reminders.changedFileChangesSource,
          ),
        }
      : {}),
    ...reminders,
    ...(reminders.knowledgeToReview?.length ? { knowledgeToReviewHint: KNOWLEDGE_TO_REVIEW_HINT } : {}),
    ...(unreportedKnowledge ? { unreportedKnowledge: compactUnreportedKnowledge(unreportedKnowledge) } : {}),
    ...(continuedOutstandingItems ? { continuedOutstandingItems: compactRelatedItems(continuedOutstandingItems) } : {}),
    ...(relatedOutstandingItems ? { relatedOutstandingItems: compactRelatedItems(relatedOutstandingItems) } : {}),
  };
}
