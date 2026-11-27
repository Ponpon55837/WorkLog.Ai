import type { FinalizeRejectedResult, FinalizeSessionInput } from "@work-intelligence/core";

type CheckedFields = Pick<
  FinalizeSessionInput,
  | "resolvedOutstandingItemIds"
  | "supersededOutstandingItemIds"
  | "appliedKnowledgeIds"
  | "contradictedKnowledgeIds"
  | "startedAt"
  | "completedAt"
>;

function sharedIds(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] {
  const secondIds = new Set(second ?? []);
  return [...new Set((first ?? []).filter((id) => secondIds.has(id)))];
}

export function findFinalizeRequestContradiction(
  input: CheckedFields,
  hasNextSteps: boolean,
): FinalizeRejectedResult | undefined {
  const inBothOutstandingLists = sharedIds(input.resolvedOutstandingItemIds, input.supersededOutstandingItemIds);
  if (inBothOutstandingLists.length > 0) {
    return {
      outcome: "rejected",
      code: "both_lists",
      field: "supersededOutstandingItemIds",
      ids: inBothOutstandingLists,
      reason: "An outstanding item cannot be both resolved and superseded in one request.",
      fix: "Remove each listed id from resolvedOutstandingItemIds or from supersededOutstandingItemIds, then send the request again.",
    };
  }

  if (input.supersededOutstandingItemIds?.length && !hasNextSteps) {
    return {
      outcome: "rejected",
      code: "superseded_without_next_steps",
      field: "supersededOutstandingItemIds",
      ids: [...new Set(input.supersededOutstandingItemIds)],
      reason: "Superseded items need nextSteps that replace them, and workSummary.nextSteps is empty.",
      fix: "Write the replacing steps in workSummary.nextSteps, or remove supersededOutstandingItemIds, then send the request again.",
    };
  }

  const appliedAndContradicted = sharedIds(input.appliedKnowledgeIds, input.contradictedKnowledgeIds);
  if (appliedAndContradicted.length > 0) {
    return {
      outcome: "rejected",
      code: "knowledge_applied_and_contradicted",
      field: "contradictedKnowledgeIds",
      ids: appliedAndContradicted,
      reason: "A Knowledge item cannot be both applied and contradicted in one request.",
      fix: "Remove each listed id from appliedKnowledgeIds or from contradictedKnowledgeIds, then send the request again.",
    };
  }

  if (input.startedAt && input.completedAt && input.startedAt > input.completedAt) {
    return {
      outcome: "rejected",
      code: "started_after_completed",
      field: "startedAt",
      reason: `startedAt ${input.startedAt} is after completedAt ${input.completedAt}.`,
      fix: "Send a startedAt that is not after completedAt, or omit startedAt, then send the request again.",
    };
  }

  return undefined;
}
