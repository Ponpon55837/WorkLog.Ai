import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  ListSessionDecisionsInput,
  ReviewSessionDecisionInput,
  SessionDecisionListQueryResult,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { useAgentReviewStore } from "./agent-review";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

const MAX_LISTED_DECISIONS = 200;
const DECISION_REVIEW_CONCURRENCY = 4;

type DecisionBatchResult = {
  reviewedIds: string[];
  /** Ids the API no longer knows or that moved out of tracking. */
  skippedIds: string[];
  failedIds: string[];
  failure?: Error;
};

export const useSessionDecisionsStore = defineStore("session-decisions", () => {
  const queryCache = useQueryCache();
  const agentReviewStore = useAgentReviewStore();
  const listEnabled = ref(false);
  const projectRoot = ref<string | undefined>();
  const status = computed<ListSessionDecisionsInput["status"]>(() =>
    agentReviewStore.filter === "agent" ? "agent_reviewed" : "pending",
  );
  const limit = ref(MAX_LISTED_DECISIONS);

  function listScope(): ListSessionDecisionsInput {
    return { projectRoot: projectRoot.value, status: status.value, limit: limit.value };
  }

  const listQuery = useQuery<SessionDecisionListQueryResult>({
    key: () => [...queryKeys.sessionDecisions.list, listScope()],
    enabled: listEnabled,
    query: ({ signal }) => useApi().client.listSessionDecisions(listScope(), signal),
  });
  const reviewMutation = useMutation({
    mutation: (input: ReviewSessionDecisionInput) => useApi().client.reviewSessionDecision(input),
    onSuccess: async (result) => {
      if (result.outcome === "session_decision_reviewed")
        await refreshAfterReview(result.decision.reviewStatus === "promoted");
    },
  });

  const batchMutation = useMutation({
    mutation: (inputs: ReviewSessionDecisionInput[]) => runDecisionBatch(inputs),
    onSuccess: async (result) => {
      if (result.reviewedIds.length > 0 || result.skippedIds.length > 0) await refreshAfterReview(false);
    },
  });

  async function refreshAfterReview(promoted: boolean): Promise<void> {
    const invalidations = [
      queryCache.invalidateQueries({ key: queryKeys.attention.list }),
      queryCache.invalidateQueries({ key: queryKeys.agentReview.root }),
      queryCache.invalidateQueries({ key: queryKeys.sessionDecisions.list }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
      queryCache.invalidateQueries({ key: queryKeys.reports.report }),
    ];
    if (promoted) {
      invalidations.push(
        queryCache.invalidateQueries({ key: queryKeys.knowledge.list }),
        queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
        queryCache.invalidateQueries({ key: queryKeys.views.graph }),
      );
    }
    // Refreshes can be superseded by SSE; their errors do not undo the committed review.
    await Promise.allSettled(invalidations);
  }

  const decisions = computed(() =>
    listQuery.data.value?.outcome === "session_decisions" ? listQuery.data.value.items : [],
  );
  const pendingCount = computed(() =>
    listQuery.data.value?.outcome === "session_decisions" ? listQuery.data.value.pendingCount : 0,
  );
  const decisionsLoading = computed(() => listQuery.isLoading.value);
  const decisionsLoaded = computed(() => listQuery.data.value !== undefined);
  const decisionsError = computed(() => {
    if (listQuery.error.value) return errorMessage(listQuery.error.value, t("knowledge.couldNotLoadAgentAutonomous"));
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? t("common.trackingIsNotEnabledFor")) : "";
  });

  function setListActive(active: boolean, root?: string): void {
    listEnabled.value = active;
    projectRoot.value = root;
  }

  async function reload(): Promise<void> {
    listEnabled.value = true;
    await listQuery.refetch(true);
  }

  async function reviewDecision(input: ReviewSessionDecisionInput) {
    return reviewMutation.mutateAsync(input);
  }

  /** Reviews with bounded concurrency, since the API has no batch endpoint; one refresh covers the whole run. */
  async function runDecisionBatch(inputs: ReviewSessionDecisionInput[]): Promise<DecisionBatchResult> {
    const { client } = useApi();
    const result: DecisionBatchResult = { reviewedIds: [], skippedIds: [], failedIds: [] };
    let next = 0;
    async function work(): Promise<void> {
      for (let input = inputs[next++]; input && !result.failure; input = inputs[next++]) {
        try {
          const reviewed = await client.reviewSessionDecision(input);
          if (reviewed.outcome === "session_decision_reviewed") result.reviewedIds.push(input.decisionId);
          else result.skippedIds.push(input.decisionId);
        } catch (error) {
          result.failedIds.push(input.decisionId);
          result.failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(DECISION_REVIEW_CONCURRENCY, inputs.length) }, work));
    return result;
  }

  async function reviewDecisions(inputs: ReviewSessionDecisionInput[]): Promise<DecisionBatchResult> {
    return batchMutation.mutateAsync(inputs);
  }

  return {
    decisions,
    pendingCount,
    decisionsLoading,
    decisionsLoaded,
    decisionsError,
    listEnabled,
    setListActive,
    reload,
    reviewDecision,
    reviewDecisions,
  };
});
