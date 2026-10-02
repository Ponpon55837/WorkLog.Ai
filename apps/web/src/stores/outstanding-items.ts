import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import type {
  BatchUpdateOutstandingItemStatusInput,
  BatchUpdateOutstandingItemStatusResult,
  OutstandingItem,
  OutstandingItemListQueryResult,
  OutstandingItemStatus,
  PageInfo,
  UpdateOutstandingItemStatusInput,
  UpdateOutstandingItemStatusResult,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { pageSizeToQuery, type ListPageSize } from "../utils/labels";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

const emptyPageInfo: PageInfo = {
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
  truncated: false,
};

type OutstandingListScope = {
  projectId?: string;
  status: OutstandingItemStatus;
  page: number;
  pageSize: ListPageSize;
  from?: string;
  to?: string;
};

function buildListScope(
  projectId: string,
  status: OutstandingItemStatus,
  page: number,
  pageSize: ListPageSize,
  from: string,
  to: string,
): OutstandingListScope {
  return { projectId: projectId || undefined, status, page, pageSize, from: from || undefined, to: to || undefined };
}

/** Owns the URL-scoped, project-filtered nextSteps work queue and its audited status transitions. */
export const useOutstandingItemsStore = defineStore("outstanding-items", () => {
  const queryCache = useQueryCache();
  const listEnabled = ref(false);
  const projectId = ref("");
  const status = ref<OutstandingItemStatus>("pending");
  const page = ref(1);
  const pageSize = ref<ListPageSize>(10);
  const from = ref("");
  const to = ref("");

  const listQuery = useQuery<OutstandingItemListQueryResult>({
    key: () => [
      ...queryKeys.outstandingItems.list,
      buildListScope(projectId.value, status.value, page.value, pageSize.value, from.value, to.value),
    ],
    enabled: listEnabled,
    query: ({ signal }) => {
      const scope = buildListScope(projectId.value, status.value, page.value, pageSize.value, from.value, to.value);
      return useApi().client.listOutstandingItems({ ...scope, pageSize: pageSizeToQuery(pageSize.value) }, signal);
    },
  });

  const items = computed<OutstandingItem[]>(() =>
    listQuery.data.value?.outcome === "outstanding_items" ? listQuery.data.value.items : [],
  );
  const pageInfo = computed(() =>
    listQuery.data.value?.outcome === "outstanding_items"
      ? listQuery.data.value.pageInfo
      : { ...emptyPageInfo, pageSize: pageSizeToQuery(pageSize.value) || 10 },
  );

  const loading = computed(() => listQuery.isLoading.value);
  const loaded = computed(() => listQuery.data.value !== undefined);
  const error = computed(() => {
    if (listQuery.error.value) return errorMessage(listQuery.error.value, t("無法載入未結項。"));
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? t("此專案目前未啟用記錄。")) : "";
  });

  const updateStatusMutation = useMutation({
    mutation: (input: UpdateOutstandingItemStatusInput) => useApi().client.updateOutstandingItemStatus(input),
    onSuccess: async (result: UpdateOutstandingItemStatusResult) => {
      if (result.outcome !== "outstanding_item_updated") return;
      // A later SSE refresh may cancel this read after the write already succeeded.
      await Promise.allSettled([queryCache.invalidateQueries({ key: queryKeys.outstandingItems.list })]);
    },
  });

  const batchStatusMutation = useMutation({
    mutation: (input: BatchUpdateOutstandingItemStatusInput) => useApi().client.batchUpdateOutstandingItemStatus(input),
    onSuccess: async (result: BatchUpdateOutstandingItemStatusResult) => {
      if (result.outcome !== "outstanding_items_updated") return;
      // Refresh errors belong to the queries and must not turn a committed write into a failure.
      await Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.outstandingItems.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary }),
      ]);
    },
  });

  function setListActive(active: boolean): void {
    listEnabled.value = active;
  }

  async function reload(): Promise<void> {
    listEnabled.value = true;
    await listQuery.refetch(true);
  }

  async function updateStatus(input: UpdateOutstandingItemStatusInput): Promise<OutstandingItem> {
    const result: UpdateOutstandingItemStatusResult = await updateStatusMutation.mutateAsync(input);
    if (result.outcome === "outstanding_item_updated") return result.item;
    if (result.outcome === "not_found") throw new Error(t("這筆未結項已不存在，請重新整理清單。"));
    throw new Error(result.reason ?? t("這筆未結項目前無法更新。"));
  }

  async function batchUpdateStatus(
    input: BatchUpdateOutstandingItemStatusInput,
  ): Promise<Extract<BatchUpdateOutstandingItemStatusResult, { outcome: "outstanding_items_updated" }>> {
    const result = await batchStatusMutation.mutateAsync(input);
    if (result.outcome === "outstanding_items_updated") return result;
    if (result.outcome === "rejected")
      throw new Error(
        result.reason === "status_conflict"
          ? t("未結項狀態已變更，請重新整理後再操作。")
          : t("部分未結項已不存在，請重新整理清單。"),
      );
    throw new Error(t("此批次包含目前未啟用記錄的專案，整批未更新。"));
  }

  watch(
    () =>
      listQuery.isPlaceholderData.value
        ? undefined
        : listQuery.data.value?.outcome === "outstanding_items"
          ? listQuery.data.value.pageInfo.page
          : undefined,
    (loadedPage) => {
      if (loadedPage !== undefined && page.value !== loadedPage) page.value = loadedPage;
    },
  );

  return {
    listEnabled,
    projectId,
    status,
    page,
    pageSize,
    from,
    to,
    items,
    pageInfo,
    loading,
    loaded,
    error,
    setListActive,
    reload,
    updateStatus,
    batchUpdateStatus,
  };
});
