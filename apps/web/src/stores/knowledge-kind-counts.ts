import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeStatus } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

export type KnowledgeKindCountsScope = { projectId: string; status: KnowledgeStatus };

/**
 * How many Knowledge records of each kind a project and status hold, for the Knowledge page's side card.
 * One page-size-1 request per kind (five in all) reads each total; nothing is scanned or estimated.
 */
export const useKnowledgeKindCountsStore = defineStore("knowledge-kind-counts", () => {
  const scope = ref<KnowledgeKindCountsScope | null>(null);

  const query = useQuery<Record<KnowledgeKind, number>>({
    // Under the list prefix, so every Knowledge write refreshes the counts with the list.
    key: () => [...queryKeys.knowledge.list, "kind-counts", scope.value],
    enabled: computed(() => scope.value !== null),
    query: async ({ signal }) => {
      const current = scope.value;
      if (!current) throw new Error("A scope must be set before counting Knowledge kinds.");
      const { client } = useApi();
      const totals = await Promise.all(
        KNOWLEDGE_KINDS.map((kind) =>
          client.searchKnowledge(
            { kind, projectId: current.projectId || undefined, status: current.status, page: 1, pageSize: 1 },
            signal,
          ),
        ),
      );
      const counts = {} as Record<KnowledgeKind, number>;
      KNOWLEDGE_KINDS.forEach((kind, index) => {
        const result = totals[index]!;
        // A skipped result means the scope is not tracked; the card then stays hidden.
        if (result.outcome !== "knowledge") throw new Error("Knowledge counts are not available for this scope.");
        counts[kind] = result.pageInfo.total;
      });
      return counts;
    },
  });

  const counts = computed(() => (scope.value ? (query.data.value ?? null) : null));

  return { scope, counts };
});
