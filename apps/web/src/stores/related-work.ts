import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useQuery } from "@pinia/colada";
import type { RelatedWorkResult } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

export const useRelatedWorkStore = defineStore("related-work", () => {
  const sourceId = ref("");
  const query = useQuery<RelatedWorkResult>({
    key: () => [...queryKeys.sessions.related, sourceId.value],
    enabled: computed(() => Boolean(sourceId.value)),
    query: ({ signal }) => useApi().client.getRelatedWork(sourceId.value, signal),
  });
  const data = computed(() => (query.data.value?.sessionId === sourceId.value ? query.data.value : undefined));
  const error = computed(() => Boolean(query.error.value));
  function setSource(id: string): void {
    sourceId.value = id;
  }
  async function reload(): Promise<void> {
    await query.refetch(true).catch(() => undefined);
  }
  return { data, error, setSource, reload };
});
