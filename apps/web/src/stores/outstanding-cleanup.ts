import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import type {
  CreateOutstandingCleanupRequestInput,
  DecideOutstandingCleanupProposalsInput,
  OutstandingCleanupProposalListResult,
  OutstandingCleanupProposalStatus,
  OutstandingCleanupRequestListResult,
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

/** Owns request/proposal queries and invalidates item/source views after a human decision. */
export const useOutstandingCleanupStore = defineStore("outstanding-cleanup", () => {
  const outstandingItemsStore = useOutstandingItemsStore();
  const queryCache = useQueryCache();
  const active = ref(false);
  const requestId = ref("");
  const requestPage = ref(1);
  const requestPageSize = ref<ListPageSize>(10);
  const reviewStatus = ref<OutstandingCleanupProposalStatus>("pending");
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
        reviewStatus: reviewStatus.value,
        page: proposalPage.value,
        pageSize: proposalPageSize.value,
      },
    ],
    enabled: () => active.value && Boolean(projectId.value && requestId.value),
    query: ({ signal }) =>
      useApi().client.listOutstandingCleanupProposals(
        {
          requestId: requestId.value,
          reviewStatus: reviewStatus.value,
          page: proposalPage.value,
          pageSize: pageSizeToQuery(proposalPageSize.value) || 100,
        },
        signal,
      ),
  });

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
  const hasActiveRequest = computed(() =>
    requests.value.some((request) => request.status === "pending" || request.status === "awaiting_review"),
  );
  const loading = computed(() => requestsQuery.isLoading.value);
  const proposalsLoading = computed(() => proposalsQuery.isLoading.value);
  const skipped = computed(
    () => requestsQuery.data.value?.outcome === "skipped" || proposalsQuery.data.value?.outcome === "skipped",
  );
  const error = computed(() => {
    if (requestsQuery.error.value) return errorMessage(requestsQuery.error.value, t("無法載入整理請求。"));
    return "";
  });
  const proposalError = computed(() => {
    if (proposalsQuery.error.value) return errorMessage(proposalsQuery.error.value, t("無法載入整理建議。"));
    const result = proposalsQuery.data.value;
    if (result?.outcome === "not_found") return t("這份整理請求已不存在。");

    if (result?.outcome === "outstanding_cleanup_proposals" && result.request.projectId !== projectId.value)
      return t("這份整理請求屬於其他專案，請切換專案後查看。");
    return "";
  });

  const createMutation = useMutation({
    mutation: (input: CreateOutstandingCleanupRequestInput) => useApi().client.createOutstandingCleanupRequest(input),
    onSuccess: () => Promise.allSettled([queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.requests })]),
  });
  const decideMutation = useMutation({
    mutation: (input: DecideOutstandingCleanupProposalsInput) =>
      useApi().client.decideOutstandingCleanupProposals(input),
    onSuccess: async () => {
      // An SSE refetch can supersede these reads after the review write already committed.
      await Promise.allSettled([
        queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.requests }),
        queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.proposals }),
        queryCache.invalidateQueries({ key: queryKeys.outstandingItems.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.list }),
        queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.summary }),
      ]);
    },
    onError: () => Promise.allSettled([queryCache.invalidateQueries({ key: queryKeys.outstandingCleanup.proposals })]),
  });
  const cancelMutation = useMutation({
    mutation: (id: string) => useApi().client.cancelOutstandingCleanupRequest(id),
    onSuccess: async () => {
      await Promise.allSettled([
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
        reviewStatus.value = "pending";
        return;
      }
      if (result.outcome === "not_needed") throw new Error(t("此專案目前沒有待處理未結項。"));
      throw new Error(t("此專案目前無法建立整理請求。"));
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict")
        throw new Error(t("此專案已有整理請求，請先查看現有請求。"), { cause: error });
      throw error;
    }
  }

  async function decide(proposalIds: string[], decision: "accept" | "reject"): Promise<void> {
    try {
      const result = await decideMutation.mutateAsync({ requestId: requestId.value, proposalIds, decision });
      if (result.outcome !== "outstanding_cleanup_proposals_decided") throw new Error(t("目前無法審核這些建議。"));
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict")
        throw new Error(t("項目、來源或建議已變更，整批未套用。請重新整理後核對。"), { cause: error });
      throw error;
    }
  }

  async function cancelRequest(): Promise<void> {
    const result = await cancelMutation.mutateAsync(requestId.value);
    if (result.outcome !== "outstanding_cleanup_request_cancelled") throw new Error(t("目前無法取消這份請求。"));
  }

  return {
    active,
    requestId,
    requestPage,
    requestPageSize,
    reviewStatus,
    proposalPage,
    proposalPageSize,
    projectId,
    requests,
    requestPageInfo,
    proposals,
    proposalPageInfo,
    selectedRequest,
    hasActiveRequest,
    loading,
    proposalsLoading,
    error,
    proposalError,
    skipped,
    setActive,
    reload,
    createRequest,
    decide,
    cancelRequest,
  };
});
