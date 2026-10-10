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
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the tracked-project inbox for Agent-autonomous decisions and its Web-only review action. */
export const useSessionDecisionsStore = defineStore("session-decisions", () => {
  const queryCache = useQueryCache();
  const listEnabled = ref(false);
  const projectRoot = ref<string | undefined>();
  const status = ref<ListSessionDecisionsInput["status"]>("pending");
  const limit = ref(50);

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
      if (result.outcome !== "session_decision_reviewed") return;
      const invalidations = [
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessionDecisions.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
        queryCache.invalidateQueries({ key: queryKeys.reports.report }),
      ];
      if (result.decision.reviewStatus === "promoted") {
        invalidations.push(
          queryCache.invalidateQueries({ key: queryKeys.knowledge.list }),
          queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
          queryCache.invalidateQueries({ key: queryKeys.views.graph }),
        );
      }
      // Refreshes can be superseded by SSE; their errors do not undo the committed review.
      await Promise.allSettled(invalidations);
    },
  });

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
  };
});
