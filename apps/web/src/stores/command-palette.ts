import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { KnowledgeRecord, WorkSessionRecord } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { queryKeys } from "./query-keys";

type PaletteSearchResults = { sessions: WorkSessionRecord[]; knowledge: KnowledgeRecord[] };

/** Owns the command palette's server-backed Session and Knowledge search results. */
export const useCommandPaletteStore = defineStore("command-palette", () => {
  const isOpen = ref(false);
  const searchTerm = ref("");
  const enabled = computed(() => isOpen.value && searchTerm.value.length >= 2);
  const searchQuery = useQuery({
    key: () => [...queryKeys.commandPalette.search, searchTerm.value],
    enabled,
    query: async ({ signal }): Promise<PaletteSearchResults> => {
      const client = useApi().client;
      const [sessionResult, knowledgeResult] = await Promise.all([
        client
          .listSessions({ q: searchTerm.value, pageSize: 5 }, signal)
          .then((result) => result.items)
          .catch((error: unknown) => {
            if (useApi().isAbortError(error)) throw error;
            return [];
          }),
        client
          .searchKnowledge({ q: searchTerm.value, pageSize: 5 }, signal)
          .then((result) => (result.outcome === "knowledge" ? result.items : []))
          .catch((error: unknown) => {
            if (useApi().isAbortError(error)) throw error;
            return [];
          }),
      ]);
      return { sessions: sessionResult, knowledge: knowledgeResult };
    },
  });

  const sessions = computed(() => (enabled.value ? (searchQuery.data.value?.sessions ?? []) : []));
  const knowledge = computed(() => (enabled.value ? (searchQuery.data.value?.knowledge ?? []) : []));

  function setOpen(value: boolean): void {
    isOpen.value = value;
    if (!value) searchTerm.value = "";
  }

  function setSearchTerm(value: string): void {
    searchTerm.value = value.trim();
  }

  return { sessions, knowledge, setOpen, setSearchTerm };
});
