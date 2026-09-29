import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import type {
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
};

function buildListScope(
  projectId: string,
  status: OutstandingItemStatus,
  page: number,
  pageSize: ListPageSize,
): OutstandingListScope {
  return { projectId: projectId || undefined, status, page, pageSize };
}

/** Owns the URL-scoped, project-filtered nextSteps work queue and its audited status transitions. */
export const useOutstandingItemsStore = defineStore("outstanding-items", () => {
  const queryCache = useQueryCache();
  const listEnabled = ref(false);
  const projectId = ref("");
  const status = ref<OutstandingItemStatus>("pending");
  const page = ref(1);
  const pageSize = ref<ListPageSize>(10);

  const listQuery = useQuery<OutstandingItemListQueryResult>({
    key: () => [
      ...queryKeys.outstandingItems.list,
      buildListScope(projectId.value, status.value, page.value, pageSize.value),
    ],
    enabled: listEnabled,
    query: ({ signal }) => {
      const scope = buildListScope(projectId.value, status.value, page.value, pageSize.value);
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
    if (listQuery.error.value) return errorMessage(listQuery.error.value, "無法載入未結項。");
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? "此專案目前未啟用記錄。") : "";
  });

  const updateStatusMutation = useMutation({
    mutation: (input: UpdateOutstandingItemStatusInput) => useApi().client.updateOutstandingItemStatus(input),
    onSuccess: async (result: UpdateOutstandingItemStatusResult) => {
      if (result.outcome !== "outstanding_item_updated") return;
      await queryCache.invalidateQueries({ key: queryKeys.outstandingItems.list });
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
    if (result.outcome === "not_found") throw new Error("這筆未結項已不存在，請重新整理清單。");
    throw new Error(result.reason ?? "這筆未結項目前無法更新。");
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
    items,
    pageInfo,
    loading,
    loaded,
    error,
    setListActive,
    reload,
    updateStatus,
  };
});
