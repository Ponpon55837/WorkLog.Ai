import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed } from "vue";
import type { KnowledgeCandidateListResult, SessionDecisionListQueryResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

/** What waits for review in 工作知識 across all projects: pending Agent decisions plus proposed candidates. */
export const useWorkKnowledgePendingStore = defineStore("work-knowledge-pending", () => {
  const decisionsQuery = useQuery<SessionDecisionListQueryResult>({
    key: () => [...queryKeys.sessionDecisions.pendingTotal],
    query: ({ signal }) => useApi().client.listSessionDecisions({ status: "pending", limit: 1 }, signal),
  });
  // Its own entry under the candidates prefix: every candidate decision refreshes it, yet the candidates list keeps its own loading timing.
  const candidatesQuery = useQuery<KnowledgeCandidateListResult>({
    key: () => [...queryKeys.knowledge.candidatesPendingTotal],
    query: ({ signal }) => useApi().client.listKnowledgeCandidates(undefined, signal),
  });

  const pendingTotal = computed(() => {
    const decisions = decisionsQuery.data.value;
    const candidates = candidatesQuery.data.value;
    if (decisions === undefined || candidates === undefined) return undefined;
    return (
      (decisions.outcome === "session_decisions" ? decisions.pendingCount : 0) +
      (candidates.outcome === "knowledge_candidates" ? candidates.items.length : 0)
    );
  });

  return { pendingTotal };
});
