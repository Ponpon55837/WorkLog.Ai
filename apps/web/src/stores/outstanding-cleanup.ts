import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import type {
  CreateOutstandingCleanupRequestInput,
  OutstandingCleanupProposalListResult,
  OutstandingCleanupRequestListResult,
  OutstandingItemStatus,
  PageInfo,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { ApiError } from "../api/client";
import { errorMessage } from "../utils/format";
import { pageSizeToQuery, type ListPageSize } from "../utils/labels";
import { useOutstandingItemsStore } from "./outstanding-items";
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

export const useOutstandingCleanupStore = defineStore("outstanding-cleanup", () => {
  const outstandingItemsStore = useOutstandingItemsStore();
  const queryCache = useQueryCache();
  const active = ref(false);
  const requestId = ref("");
  const requestPage = ref(1);
  const requestPageSize = ref<ListPageSize>(10);
  const proposalPage = ref(1);
  const proposalPageSize = ref<ListPageSize>(10);
  const projectId = computed(() => outstandingItemsStore.projectId);

  const requestsQuery = useQuery<OutstandingCleanupRequestListResult>({
    key: () => [
      ...queryKeys.outstandingCleanup.requests,
      { projectId: projectId.value, page: requestPage.value, pageSize: requestPageSize.value },
    ],
    enabled: () => active.value && Boolean(projectId.value),
    query: ({ signal }) =>
      useApi().client.listOutstandingCleanupRequests(
        {
          projectId: projectId.value,
          page: requestPage.value,
          pageSize: pageSizeToQuery(requestPageSize.value) || 100,
        },
        signal,
      ),
  });
  const proposalsQuery = useQuery<OutstandingCleanupProposalListResult>({
    key: () => [
      ...queryKeys.outstandingCleanup.proposals,
      {
        projectId: projectId.value,
        requestId: requestId.value,
        page: proposalPage.value,
        pageSize: proposalPageSize.value,
      },
    ],
    enabled: () => active.value && Boolean(projectId.value && requestId.value),
    query: ({ signal }) =>
      useApi().client.listOutstandingCleanupProposals(
        {
          requestId: requestId.value,
          reviewStatus: "accepted",
          page: proposalPage.value,
          pageSize: pageSizeToQuery(proposalPageSize.value) || 100,
        },
        signal,
      ),
  });

  const requestsLoaded = computed(() => requestsQuery.data.value?.outcome === "outstanding_cleanup_requests");
  const requests = computed(() =>
    requestsQuery.data.value?.outcome === "outstanding_cleanup_requests" ? requestsQuery.data.value.requests : [],
  );
  const requestPageInfo = computed(() =>
    requestsQuery.data.value?.outcome === "outstanding_cleanup_requests"
      ? {
          ...requestsQuery.data.value.pageInfo,
          truncated: requestPageSize.value === "all" && requestsQuery.data.value.pageInfo.total > 100,
        }
      : emptyPageInfo,
  );
  const proposalResult = computed(() =>
    proposalsQuery.data.value?.outcome === "outstanding_cleanup_proposals" &&
    proposalsQuery.data.value.request.projectId === projectId.value
      ? proposalsQuery.data.value
      : undefined,
  );
  const proposals = computed(() => proposalResult.value?.proposals ?? []);
  const proposalPageInfo = computed(() =>
    proposalResult.value
      ? {
          ...proposalResult.value.pageInfo,
          truncated: proposalPageSize.value === "all" && proposalResult.value.pageInfo.total > 100,
        }
      : emptyPageInfo,
  );
  const selectedRequest = computed(
    () => proposalResult.value?.request ?? requests.value.find((request) => request.id === requestId.value),
  );
  const activeRequest = computed(() => requests.value.find((request) => request.status === "pending"));
  const loading = computed(() => requestsQuery.isLoading.value);
  const proposalsLoading = computed(() => proposalsQuery.isLoading.value);
  const skipped = computed(
    () => requestsQuery.data.value?.outcome === "skipped" || proposalsQuery.data.value?.outcome === "skipped",
  );
  const error = computed(() => {
    if (requestsQuery.error.value)
      return errorMessage(requestsQuery.error.value, t("outstanding.couldNotLoadRequests"));
    return "";
  });
  const proposalError = computed(() => {
    if (proposalsQuery.error.value)
      return errorMessage(proposalsQuery.error.value, t("outstanding.couldNotLoadSuggestions"));
    const result = proposalsQuery.data.value;
    if (result?.outcome === "not_found") return t("outstanding.thisRequestNoLongerExists");
    if (result?.outcome === "outstanding_cleanup_proposals" && result.request.projectId !== projectId.value)
      return t("outstanding.thisRequestBelongsToAnother");
    return "";
  });

  const createMutation = useMutation({
    mutation: (input: CreateOutstandingCleanupRequestInput) => useApi().client.createOutstandingCleanupRequest(input),
    onSuccess: () =>
      Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.requests }),
      ]),
  });
  const cancelMutation = useMutation({
    mutation: (id: string) => useApi().client.cancelOutstandingCleanupRequest(id),
    onSuccess: async () => {
      await Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.attention.list }),
        queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.requests }),
        queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.proposals }),
      ]);
    },
  });

  function setActive(value: boolean): void {
    active.value = value;
  }

  async function reload(): Promise<void> {
    await requestsQuery.refetch(true);
    if (requestId.value) await proposalsQuery.refetch(true);
  }

  async function createRequest(idempotencyKey: string): Promise<void> {
    try {
      const result = await createMutation.mutateAsync({ projectId: projectId.value, idempotencyKey });
      if (result.outcome === "outstanding_cleanup_request_created") {
        requestId.value = result.request.id;
        return;
      }
      if (result.outcome === "not_needed") throw new Error(t("outstanding.thisProjectHasNoPending"));
      throw new Error(t("outstanding.aRequestCannotBeCreated"));
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict")
        throw new Error(t("outstanding.thisProjectAlreadyHasA"), { cause: error });
      throw error;
    }
  }

  /** Each group names the status the item was closed with, so an item changed elsewhere meanwhile is not overwritten. */
  async function reopen(items: Array<{ itemId: string; status: OutstandingItemStatus }>): Promise<number> {
    let reopened = 0;
    try {
      for (const expectedStatus of new Set(items.map((item) => item.status))) {
        const result = await outstandingItemsStore.batchUpdateStatus({
          itemIds: items.filter((item) => item.status === expectedStatus).map((item) => item.itemId),
          status: "pending",
          expectedStatus,
        });
        reopened += result.updatedItemIds.length;
      }
      return reopened;
    } finally {
      await Promise.allSettled([queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.proposals })]);
    }
  }

  async function cancelRequest(id: string): Promise<void> {
    const result = await cancelMutation.mutateAsync(id);
    if (result.outcome !== "outstanding_cleanup_request_cancelled")
      throw new Error(t("outstanding.thisRequestCannotBeCancelled"));
  }

  return {
    active,
    requestId,
    requestPage,
    requestPageSize,
    proposalPage,
    proposalPageSize,
    projectId,
    requestsLoaded,
    requests,
    requestPageInfo,
    proposals,
    proposalPageInfo,
    selectedRequest,
    activeRequest,
    loading,
    proposalsLoading,
    error,
    proposalError,
    skipped,
    setActive,
    reload,
    createRequest,
    reopen,
    cancelRequest,
  };
});
