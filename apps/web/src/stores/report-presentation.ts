import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  emptyReportPresentation,
  type ReportPresentation,
  type ReportPresentationState,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

export const useReportPresentationStore = defineStore("report-presentation", () => {
  const cache = useQueryCache();
  const summaryId = ref("");
  const query = useQuery<ReportPresentation>({
    key: () => [...queryKeys.reportPresentation, summaryId.value],
    enabled: computed(() => Boolean(summaryId.value)),
    query: ({ signal }) => useApi().client.getReportPresentation(summaryId.value, signal),
  });
  const mutation = useMutation({
    mutation: (input: { summaryId: string; expectedRevision: number; state: ReportPresentationState }) =>
      useApi().client.updateReportPresentation(input),
    onSuccess: async (_result, input) => {
      await Promise.allSettled([
        cache.invalidateQueries({ key: [...queryKeys.reportPresentation, input.summaryId], exact: true }),
      ]);
    },
  });
  const data = computed(() =>
    !query.error.value && query.data.value?.summaryId === summaryId.value ? query.data.value : null,
  );
  const state = computed(() => data.value?.state ?? emptyReportPresentation());
  const loading = computed(() => query.isLoading.value);
  const saving = computed(() => mutation.isLoading.value);
  const error = computed(() => (query.error.value ? errorMessage(query.error.value, t("presentation.failed")) : ""));
  function setSummary(id: string): void {
    summaryId.value = id;
  }
  async function reload(): Promise<void> {
    try {
      await query.refetch(true);
    } catch {
      /* Reading view owns this error. */
    }
  }
  async function read(id: string): Promise<ReportPresentation> {
    return useApi().client.getReportPresentation(id);
  }
  async function save(input: {
    summaryId: string;
    expectedRevision: number;
    state: ReportPresentationState;
  }): Promise<ReportPresentation> {
    return mutation.mutateAsync(input);
  }
  function exportMarkdown(id: string, revision: number, locale: "zh-TW" | "en-US", signal?: AbortSignal) {
    return useApi().client.exportReportPresentation({ summaryId: id, revision, locale }, signal);
  }
  return { exportMarkdown, data, state, loading, saving, error, setSummary, reload, read, save };
});
