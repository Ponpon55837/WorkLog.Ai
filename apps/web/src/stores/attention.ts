import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AttentionKind, AttentionResult, UpdateAttentionPreference } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import type { ListPageSize } from "../utils/labels";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns scoped attention reads; all source actions remain in their domain workflows. */
export const useAttentionStore = defineStore("attention", () => {
  const cache = useQueryCache();
  const active = ref(false);
  const projectId = ref("");
  const kind = ref<AttentionKind | "">("");
  const view = ref<"visible" | "suppressed">("visible");
  const page = ref(1);
  const pageSize = ref<ListPageSize>(20);
  const query = useQuery<AttentionResult>({
    key: () => [
      ...queryKeys.attention.list,
      {
        projectId: projectId.value,
        kind: kind.value,
        page: page.value,
        pageSize: pageSize.value,
        ...(view.value === "suppressed" ? { view: view.value } : {}),
      },
    ],
    enabled: active,
    query: ({ signal }) =>
      useApi().client.getAttention(
        {
          projectId: projectId.value || undefined,
          kind: kind.value || undefined,
          view: view.value === "suppressed" ? view.value : undefined,
          page: page.value,
          pageSize: Number(pageSize.value),
        },
        signal,
      ),
  });
  const result = computed(() => (query.data.value?.outcome === "attention" ? query.data.value : null));
  const items = computed(() => result.value?.items ?? []);
  const groups = computed(() => result.value?.groups ?? []);
  const loaded = computed(() => query.data.value !== undefined);
  const loading = computed(() => query.isLoading.value);
  const error = computed(() => (query.error.value ? errorMessage(query.error.value, t("attention.loadFailed")) : ""));
  const skipped = computed(() => query.data.value?.outcome === "skipped");
  const hasIncomplete = computed(
    () => Boolean(error.value) || groups.value.some((group) => group.state !== "complete"),
  );

  const preferenceMutation = useMutation({
    mutation: async (input: UpdateAttentionPreference) => {
      const result = await useApi().client.updateAttentionPreference(input);
      if (result.outcome === "skipped") throw new Error(t("attention.scopeSkipped"));
      return result;
    },
    onSuccess: async () => {
      await Promise.allSettled([cache.invalidateQueries({ key: queryKeys.attention.list })]);
    },
  });
  const saving = computed(() => preferenceMutation.isLoading.value);

  async function setPreference(input: UpdateAttentionPreference): Promise<void> {
    await preferenceMutation.mutateAsync(input);
  }
  function setActive(value: boolean): void {
    active.value = value;
  }
  async function reload(): Promise<void> {
    try {
      await query.refetch(true);
    } catch {
      /* Query owns the visible error. */
    }
  }
  return {
    projectId,
    kind,
    view,
    saving,
    setPreference,
    page,
    pageSize,
    result,
    items,
    groups,
    loaded,
    loading,
    error,
    skipped,
    hasIncomplete,
    setActive,
    reload,
  };
});
