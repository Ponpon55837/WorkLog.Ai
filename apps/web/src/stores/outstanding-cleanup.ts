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
import { useProjectsStore } from "./projects";
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

/** `pendingCount` stays undefined when that project's count could not be loaded. */
export type OutstandingPendingProject = { projectId: string; projectName: string; pendingCount?: number };

const PENDING_COUNT_CONCURRENCY = 4;
const PENDING_COUNT_STALE_MS = 30_000;

export const useOutstandingCleanupStore = defineStore("outstanding-cleanup", () => {
  const outstandingItemsStore = useOutstandingItemsStore();
  const projectsStore = useProjectsStore();
  const queryCache = useQueryCache();
  const active = ref(false);
  const requestId = ref("");
  const requestPage = ref(1);
  const requestPageSize = ref<ListPageSize>(10);
  const proposalPage = ref(1);
  const proposalPageSize = ref<ListPageSize>(10);
  const panelProjectId = ref("");
  const projectId = computed(() => outstandingItemsStore.projectId);
  const canChangeProject = computed(() => panelProjectId.value !== "" && panelProjectId.value === projectId.value);

  const pendingProjectsQuery = useQuery<OutstandingPendingProject[]>({
    key: () => [
      ...queryKeys.outstandingItems.pendingByProject,
      projectsStore.trackedProjects.map((project) => project.id),
    ],
    enabled: () => active.value && !projectId.value && projectsStore.projectsLoaded,
    staleTime: PENDING_COUNT_STALE_MS,
    query: async ({ signal }) => {
      const { client } = useApi();
      const tracked = [...projectsStore.trackedProjects];
      const counts: OutstandingPendingProject[] = [];
      let failures = 0;
      const entries = tracked.entries();
      async function worker(): Promise<void> {
        // The workers share one iterator, so each project is taken by exactly one of them.
        for (const [index, { id, name }] of entries) {
          const [settled] = await Promise.allSettled([
            client.listOutstandingItems({ projectId: id, status: "pending", page: 1, pageSize: 1 }, signal),
          ]);
          if (settled.status === "fulfilled") {
            const { value } = settled;
            counts[index] = {
              projectId: id,
              projectName: name,
              pendingCount: value.outcome === "outstanding_items" ? value.pageInfo.total : 0,
            };
          } else {
            signal.throwIfAborted();
            failures += 1;
            counts[index] = { projectId: id, projectName: name };
          }
        }
      }
      await Promise.all(Array.from({ length: PENDING_COUNT_CONCURRENCY }, worker));
      if (tracked.length > 0 && failures === tracked.length)
        throw new Error(t("outstanding.cleanupCouldNotLoadProjects"));
      return counts.filter((project) => project.pendingCount !== 0);
    },
  });
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
  const activeRequestQuery = useQuery<OutstandingCleanupRequestListResult>({
    key: () => [...queryKeys.outstandingCleanup.requests, "active", { projectId: projectId.value }],
    enabled: () => active.value && Boolean(projectId.value),
    query: ({ signal }) =>
      useApi().client.listOutstandingCleanupRequests(
        { projectId: projectId.value, status: "pending", page: 1, pageSize: 1 },
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

  const pendingProjects = computed(() => pendingProjectsQuery.data.value ?? []);
  const pendingProjectsLoaded = computed(() => pendingProjectsQuery.data.value !== undefined);
  const pendingProjectsError = computed(() =>
    pendingProjectsQuery.error.value
      ? errorMessage(pendingProjectsQuery.error.value, t("outstanding.cleanupCouldNotLoadProjects"))
      : "",
  );
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
  const activeRequest = computed(() =>
    activeRequestQuery.data.value?.outcome === "outstanding_cleanup_requests"
      ? activeRequestQuery.data.value.requests.find(
          (request) => request.projectId === projectId.value && request.status === "pending",
        )
      : undefined,
  );
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

  /** The panel only resets a project it chose itself, never one the list was already filtered to. */
  function chooseProject(id: string): void {
    panelProjectId.value = id;
    outstandingItemsStore.projectId = id;
  }

  function changeProject(): void {
    if (canChangeProject.value) chooseProject("");
  }

  async function reloadPendingProjects(): Promise<void> {
    await pendingProjectsQuery.refetch(true);
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
  async function reopen(
    items: Array<{ itemId: string; status: OutstandingItemStatus }>,
  ): Promise<{ reopened: number; skipped: number; failure?: Error }> {
    let reopened = 0;
    let skipped = 0;
    try {
      for (const expectedStatus of new Set(items.map((item) => item.status))) {
        const result = await outstandingItemsStore.batchUpdateStatusInChunks({
          itemIds: items.filter((item) => item.status === expectedStatus).map((item) => item.itemId),
          status: "pending",
          expectedStatus,
        });
        reopened += result.updatedItemIds.length;
        skipped += result.skippedItemIds.length;
        if (result.failure) return { reopened, skipped, failure: result.failure };
      }
      return { reopened, skipped };
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
    pendingProjects,
    pendingProjectsLoaded,
    pendingProjectsError,
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
    canChangeProject,
    chooseProject,
    changeProject,
    reloadPendingProjects,
    reload,
    createRequest,
    reopen,
    cancelRequest,
  };
});
