import { computed, ref, watch } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import {
  MAX_OUTSTANDING_ITEM_BATCH_SIZE,
  type BatchUpdateOutstandingItemStatusInput,
  type OutstandingItem,
  type OutstandingItemClosedBy,
  type OutstandingItemListQueryResult,
  type OutstandingItemStatus,
  type PageInfo,
} from "@work-intelligence/core";
import { ApiError } from "../api/client";
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

export type OutstandingClosedFilter = "all" | "hide_source_session";

type OutstandingChunkedResult = {
  updatedItemIds: string[];
  /** Ids the API refused because they were gone or no longer in the expected status. */
  skippedItemIds: string[];
  failure?: Error;
};

const NON_SOURCE_CLOSERS: OutstandingItemClosedBy[] = ["later_session", "user", "cleanup_review", "migration"];

type OutstandingListScope = {
  projectId?: string;
  status: OutstandingItemStatus;
  closedBy?: OutstandingItemClosedBy[];
  page: number;
  pageSize: ListPageSize;
  from?: string;
  to?: string;
};

/** The API names the offending ids when it rejects a whole batch for invalid or conflicting items. */
function rejectedItemIds(error: unknown): string[] {
  if (!(error instanceof ApiError) || (error.code !== "conflict" && error.code !== "invalid_input")) return [];
  const details = error.details;
  if (typeof details !== "object" || details === null || !("invalidItemIds" in details)) return [];
  const ids = details.invalidItemIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function buildListScope(
  projectId: string,
  status: OutstandingItemStatus,
  page: number,
  pageSize: ListPageSize,
  from: string,
  to: string,
  closedFilter: OutstandingClosedFilter,
): OutstandingListScope {
  return {
    projectId: projectId || undefined,
    status,
    // Pending items have no closer, and the API rejects the filter for them.
    closedBy: closedFilter === "hide_source_session" && status !== "pending" ? NON_SOURCE_CLOSERS : undefined,
    page,
    pageSize,
    from: from || undefined,
    to: to || undefined,
  };
}

export const useOutstandingItemsStore = defineStore("outstanding-items", () => {
  const queryCache = useQueryCache();
  const listEnabled = ref(false);
  const projectId = ref("");
  const status = ref<OutstandingItemStatus>("pending");
  const page = ref(1);
  const pageSize = ref<ListPageSize>(10);
  const from = ref("");
  const to = ref("");
  const closedFilter = ref<OutstandingClosedFilter>("all");

  const listQuery = useQuery<OutstandingItemListQueryResult>({
    key: () => [
      ...queryKeys.outstandingItems.list,
      buildListScope(
        projectId.value,
        status.value,
        page.value,
        pageSize.value,
        from.value,
        to.value,
        closedFilter.value,
      ),
    ],
    enabled: listEnabled,
    query: ({ signal }) => {
      const scope = buildListScope(
        projectId.value,
        status.value,
        page.value,
        pageSize.value,
        from.value,
        to.value,
        closedFilter.value,
      );
      return useApi().client.listOutstandingItems({ ...scope, pageSize: pageSizeToQuery(pageSize.value) }, signal);
    },
  });

  const pendingTotalQuery = useQuery<OutstandingItemListQueryResult>({
    key: () => [...queryKeys.outstandingItems.pendingTotal],
    query: ({ signal }) => useApi().client.listOutstandingItems({ status: "pending", page: 1, pageSize: 1 }, signal),
  });

  const items = computed<OutstandingItem[]>(() =>
    listQuery.data.value?.outcome === "outstanding_items" ? listQuery.data.value.items : [],
  );
  const pageInfo = computed(() =>
    listQuery.data.value?.outcome === "outstanding_items"
      ? listQuery.data.value.pageInfo
      : { ...emptyPageInfo, pageSize: pageSizeToQuery(pageSize.value) || 10 },
  );

  const pendingTotal = computed(() =>
    pendingTotalQuery.data.value?.outcome === "outstanding_items"
      ? pendingTotalQuery.data.value.pageInfo.total
      : undefined,
  );
  const loading = computed(() => listQuery.isLoading.value);
  const loaded = computed(() => listQuery.data.value !== undefined);
  const error = computed(() => {
    if (listQuery.error.value) return errorMessage(listQuery.error.value, t("outstanding.couldNotLoadOpenItems"));
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? t("common.trackingIsNotEnabledFor")) : "";
  });

  function setListActive(active: boolean): void {
    listEnabled.value = active;
  }

  async function reload(): Promise<void> {
    listEnabled.value = true;
    await listQuery.refetch(true);
  }

  /**
   * The API rejects a whole chunk when one id is stale, so a rejected chunk is retried once without the ids it names.
   * Each chunk commits on its own, so a failure keeps what earlier chunks already changed.
   */
  async function batchUpdateStatusInChunks(
    input: BatchUpdateOutstandingItemStatusInput,
  ): Promise<OutstandingChunkedResult> {
    const { client } = useApi();
    const updatedItemIds: string[] = [];
    const skippedItemIds: string[] = [];
    try {
      for (let start = 0; start < input.itemIds.length; start += MAX_OUTSTANDING_ITEM_BATCH_SIZE) {
        let itemIds = input.itemIds.slice(start, start + MAX_OUTSTANDING_ITEM_BATCH_SIZE);
        for (let attempt = 0; itemIds.length > 0; attempt += 1) {
          try {
            const result = await client.batchUpdateOutstandingItemStatus({ ...input, itemIds });
            if (result.outcome !== "outstanding_items_updated")
              throw new Error(t("outstanding.thisBatchIncludesProjectsWithout"));
            updatedItemIds.push(...result.updatedItemIds);
            break;
          } catch (error) {
            const rejected = new Set(rejectedItemIds(error));
            if (attempt > 0 || rejected.size === 0) throw error;
            skippedItemIds.push(...itemIds.filter((id) => rejected.has(id)));
            itemIds = itemIds.filter((id) => !rejected.has(id));
          }
        }
      }
      return { updatedItemIds, skippedItemIds };
    } catch (error) {
      return { updatedItemIds, skippedItemIds, failure: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      // One refresh for the whole run; refresh errors belong to the queries and must not fail a committed write.
      if (updatedItemIds.length > 0 || skippedItemIds.length > 0) {
        await Promise.allSettled([
          queryCache.invalidateQueries({ key: queryKeys.outstandingItems.list }),
          queryCache.invalidateQueries({ key: queryKeys.outstandingItems.pendingByProject }),
          queryCache.invalidateQueries({ key: queryKeys.sessions.list }),
          queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
          queryCache.invalidateQueries({ key: queryKeys.attention.list }),
          queryCache.invalidateQueries({ key: queryKeys.dashboard.summary }),
        ]);
      }
    }
  }

  /** Ids of every pending item matching the current filters, across all pages. */
  async function listAllPendingIds(signal?: AbortSignal): Promise<string[]> {
    const scope = buildListScope(
      projectId.value,
      "pending",
      1,
      pageSize.value,
      from.value,
      to.value,
      closedFilter.value,
    );
    const ids = new Set<string>();
    for (let current = 1; ; current += 1) {
      const result = await useApi().client.listOutstandingItems(
        { ...scope, page: current, pageSize: MAX_OUTSTANDING_ITEM_BATCH_SIZE },
        signal,
      );
      if (result.outcome !== "outstanding_items") throw new Error(t("outstanding.couldNotLoadOpenItems"));
      for (const item of result.items) if (item.status === "pending") ids.add(item.id);
      if (!result.pageInfo.hasNext) return [...ids];
    }
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
    closedFilter,
    items,
    pageInfo,
    pendingTotal,
    loading,
    loaded,
    error,
    setListActive,
    reload,
    batchUpdateStatusInChunks,
    listAllPendingIds,
  };
});
