import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type {
  CancelMetadataBackfillRequestResult,
  CreateMetadataBackfillRequestResult,
  MetadataBackfillItem,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequest,
  MetadataBackfillRequestListQueryResult,
} from "@work-intelligence/core";
import { confirmAction } from "../composables/useConfirm";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { useSessionsStore } from "./sessions";

export const metadataBackfillInstruction = "請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。";

/** Owns metadata-gap scans and Agent requests while the Projects backfill tab is active. */
export const useMetadataBackfillStore = defineStore("metadata-backfill", () => {
  const queryCache = useQueryCache();
  const metadataBackfillActive = ref(false);
  const requestRefreshQuietly = ref(false);
  const metadataBackfillActionError = ref("");
  const metadataBackfillRequestActionError = ref("");

  const previewQuery = useQuery({
    key: queryKeys.projects.metadataBackfillPreview,
    enabled: false,
    query: ({ signal }): Promise<MetadataBackfillPreviewResult> => useApi().client.previewMetadataBackfill(50, signal),
  });
  const requestQuery = useQuery({
    key: queryKeys.projects.metadataBackfillView,
    enabled: metadataBackfillActive,
    query: ({ signal }): Promise<MetadataBackfillRequestListQueryResult> =>
      useApi().client.listMetadataBackfillRequests(signal),
  });

  async function invalidateRequestQueries(): Promise<void> {
    await Promise.all([
      queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
    ]);
  }

  function setRequestQueryData(requests: MetadataBackfillRequest[]): void {
    queryCache.setQueryData(queryKeys.projects.metadataBackfillView, {
      outcome: "metadata_backfill_requests",
      requests,
    } satisfies MetadataBackfillRequestListQueryResult);
  }

  const createRequestMutation = useMutation({
    mutation: (projectId?: string): Promise<CreateMetadataBackfillRequestResult> =>
      useApi().client.createMetadataBackfillRequest(projectId),
    onSuccess: (result) => {
      if (result.outcome === "metadata_backfill_request") {
        setRequestQueryData([result.request]);
        void invalidateRequestQueries().catch(() => undefined);
      } else if (result.outcome === "metadata_backfill_not_needed") {
        setRequestQueryData([]);
      }
    },
  });
  const cancelRequestMutation = useMutation({
    mutation: (requestId: string): Promise<CancelMetadataBackfillRequestResult> =>
      useApi().client.cancelMetadataBackfillRequest(requestId),
    onSuccess: (result) => {
      if (result.outcome !== "metadata_backfill_request_cancelled") return;
      setRequestQueryData([result.request]);
      void invalidateRequestQueries().catch(() => undefined);
    },
  });

  const metadataBackfillPreview = computed(() => {
    const result = previewQuery.data.value;
    return result?.outcome === "backfill_preview" ? result : null;
  });
  const metadataBackfillLoading = computed(() => previewQuery.isLoading.value);
  const metadataBackfillError = computed(() => {
    if (metadataBackfillActionError.value) return metadataBackfillActionError.value;
    if (previewQuery.error.value) return errorMessage(previewQuery.error.value, "無法掃描 metadata 缺口。");
    const result = previewQuery.data.value;
    return result && result.outcome !== "backfill_preview" ? result.reason : "";
  });
  const metadataBackfillRequest = computed(() => {
    if (requestQuery.error.value) return null;
    const result = requestQuery.data.value;
    return result?.outcome === "metadata_backfill_requests" ? (result.requests[0] ?? null) : null;
  });
  const metadataBackfillRequestIsActive = computed(() => {
    const status = metadataBackfillRequest.value?.status;
    return status === "pending" || status === "processing";
  });
  const metadataBackfillRequestLoading = computed(
    () => (requestQuery.isLoading.value && !requestRefreshQuietly.value) || cancelRequestMutation.isLoading.value,
  );
  const metadataBackfillRequestCreating = computed(() => createRequestMutation.isLoading.value);
  const metadataBackfillRequestError = computed(() => {
    if (metadataBackfillRequestActionError.value) return metadataBackfillRequestActionError.value;
    if (requestQuery.error.value) {
      return errorMessage(requestQuery.error.value, "無法載入 metadata 回補請求狀態。");
    }
    const result = requestQuery.data.value;
    return result && result.outcome !== "metadata_backfill_requests" ? result.reason : "";
  });

  watch(
    () => requestQuery.data.value,
    (data) => {
      if (data) metadataBackfillRequestActionError.value = "";
    },
  );

  function setMetadataBackfillActive(active: boolean): void {
    if (active) {
      void queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView, exact: true }, false);
      metadataBackfillActive.value = true;
      return;
    }

    metadataBackfillActive.value = false;
    queryCache.cancelQueries({ key: queryKeys.projects.metadataBackfillView, exact: true });
  }

  async function fetchMetadataBackfillRequest(quiet: boolean): Promise<void> {
    requestRefreshQuietly.value = quiet;
    metadataBackfillRequestActionError.value = "";
    try {
      await requestQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        metadataBackfillRequestActionError.value = errorMessage(error, "無法載入 metadata 回補請求狀態。");
      }
    } finally {
      requestRefreshQuietly.value = false;
    }
  }

  function loadMetadataBackfillRequest(): Promise<void> {
    return fetchMetadataBackfillRequest(false);
  }

  /** Re-checks without the loading indicator while an Agent is working on a request. */
  function refreshMetadataBackfillRequest(): Promise<void> {
    return fetchMetadataBackfillRequest(true);
  }

  async function createMetadataBackfillRequest(): Promise<void> {
    const preview = metadataBackfillPreview.value;
    if (!preview?.items.length || createRequestMutation.isLoading.value) return;

    metadataBackfillRequestActionError.value = "";
    try {
      const result = await createRequestMutation.mutateAsync(preview.project?.id);
      if (result.outcome === "metadata_backfill_request") {
        useToast().showToast(
          result.duplicate
            ? "已有待處理的 metadata 回補請求；請在目前的 Agent 對話中處理。"
            : `已建立 metadata 回補請求；請在目前的 Agent 對話中說：「${metadataBackfillInstruction}」`,
        );
      } else if (result.outcome === "metadata_backfill_not_needed") {
        useToast().showToast(result.reason);
      } else {
        metadataBackfillRequestActionError.value = result.reason;
      }
    } catch (error) {
      metadataBackfillRequestActionError.value = errorMessage(error, "建立 metadata 回補請求失敗。");
    }
  }

  async function cancelMetadataBackfillRequest(): Promise<void> {
    const request = metadataBackfillRequest.value;
    if (!request || !metadataBackfillRequestIsActive.value || metadataBackfillRequestLoading.value) return;
    if (
      !(await confirmAction({
        title: "取消這批 metadata 回補？",
        message: "既有 Session 資料不會被刪除。",
        confirmLabel: "取消回補",
        cancelLabel: "繼續等待",
        danger: true,
      }))
    ) {
      return;
    }

    metadataBackfillRequestActionError.value = "";
    try {
      const result = await cancelRequestMutation.mutateAsync(request.id);
      if (result.outcome !== "metadata_backfill_request_cancelled") {
        metadataBackfillRequestActionError.value =
          "reason" in result ? result.reason : "這批 metadata 回補目前無法取消。";
        return;
      }
      useToast().showToast("已取消這批 metadata 回補；既有 Session 資料仍然保留。");
    } catch (error) {
      metadataBackfillRequestActionError.value = errorMessage(error, "取消 metadata 回補失敗。");
    }
  }

  async function previewMetadataBackfill(): Promise<void> {
    metadataBackfillActionError.value = "";
    metadataBackfillRequestActionError.value = "";
    try {
      const result = await previewQuery.refetch(true);
      if (result.status !== "success" || result.data.outcome !== "backfill_preview") return;
      if (result.data.items.length > 0) {
        await createMetadataBackfillRequest();
      } else {
        await loadMetadataBackfillRequest();
      }
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        metadataBackfillActionError.value = errorMessage(error, "無法掃描 metadata 缺口。");
      }
    }
  }

  function openMetadataBackfillSession(item: MetadataBackfillItem): Promise<void> {
    return useSessionsStore().openSessionDetail(item.sessionId, "無法載入待回補的 Session。");
  }

  return {
    metadataBackfillPreview,
    metadataBackfillLoading,
    metadataBackfillError,
    metadataBackfillRequest,
    metadataBackfillRequestIsActive,
    metadataBackfillRequestLoading,
    metadataBackfillRequestCreating,
    metadataBackfillRequestError,
    setMetadataBackfillActive,
    loadMetadataBackfillRequest,
    refreshMetadataBackfillRequest,
    createMetadataBackfillRequest,
    cancelMetadataBackfillRequest,
    previewMetadataBackfill,
    openMetadataBackfillSession,
  };
});
