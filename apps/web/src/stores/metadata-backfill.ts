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
import { useProjectsStore } from "./projects";
import { useSessionsStore } from "./sessions";
import { t } from "../i18n";

/** The natural-language request the user pastes into their Agent conversation. */
export function metadataBackfillInstruction(): string {
  return t("projects.pleaseProcessTheMetadataGaps");
}

/** Owns metadata-gap scans and Agent requests while the Projects backfill tab is active. */
export const useMetadataBackfillStore = defineStore("metadata-backfill", () => {
  const queryCache = useQueryCache();
  const metadataBackfillActive = ref(false);
  const projectId = ref("");
  const requestId = ref("");
  const requestRefreshQuietly = ref(false);
  const metadataBackfillActionError = ref("");
  const metadataBackfillRequestActionError = ref("");

  const previewQuery = useQuery({
    key: () => [...queryKeys.projects.metadataBackfillPreview, projectId.value],
    enabled: false,
    query: ({ signal }): Promise<MetadataBackfillPreviewResult> => {
      const project = useProjectsStore().projects.find(
        (item) => item.id === projectId.value && item.status === "tracked",
      );
      if (projectId.value && !project) throw new Error(t("knowledge.knowledgeProjectNotFound"));
      return useApi().client.previewMetadataBackfill(50, signal, project?.rootPath);
    },
  });
  const requestQuery = useQuery({
    key: () => [...queryKeys.projects.metadataBackfillView, projectId.value, requestId.value],
    enabled: metadataBackfillActive,
    query: ({ signal }): Promise<MetadataBackfillRequestListQueryResult> =>
      useApi().client.listMetadataBackfillRequests(signal, {
        projectId: projectId.value || undefined,
        requestId: requestId.value || undefined,
      }),
  });

  async function invalidateRequestQueries(): Promise<void> {
    await Promise.all([
      queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView }),
      queryCache.invalidateQueries({ key: queryKeys.attention.list }),
    ]);
  }

  function setRequestQueryData(requests: MetadataBackfillRequest[]): void {
    if (requests.length && (requests[0]!.projectId ?? "") !== projectId.value) return;
    if (requests.length && requestId.value && requests[0]!.id !== requestId.value) return;
    queryCache.setQueryData([...queryKeys.projects.metadataBackfillView, projectId.value, requestId.value], {
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
    if (previewQuery.error.value) return errorMessage(previewQuery.error.value, t("projects.couldNotScanMetadataGaps"));
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
      return errorMessage(requestQuery.error.value, t("projects.couldNotLoadTheMetadata"));
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
      void queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView }, false);
      metadataBackfillActive.value = true;
      return;
    }

    metadataBackfillActive.value = false;
    queryCache.cancelQueries({ key: queryKeys.projects.metadataBackfillView });
  }

  async function fetchMetadataBackfillRequest(quiet: boolean): Promise<void> {
    requestRefreshQuietly.value = quiet;
    metadataBackfillRequestActionError.value = "";
    try {
      await requestQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        metadataBackfillRequestActionError.value = errorMessage(error, t("projects.couldNotLoadTheMetadata"));
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
    if (projectId.value && preview?.project?.id !== projectId.value) return;
    if (!preview?.items.length || createRequestMutation.isLoading.value) return;

    metadataBackfillRequestActionError.value = "";
    try {
      const result = await createRequestMutation.mutateAsync(preview.project?.id);
      if (result.outcome === "metadata_backfill_request") {
        useToast().showToast(
          result.duplicate
            ? t("projects.aMetadataBackfillRequestIs")
            : t("projects.metadataBackfillRequestCreatedIn", {
                metadataBackfillInstruction: metadataBackfillInstruction(),
              }),
        );
      } else if (result.outcome === "metadata_backfill_not_needed") {
        useToast().showToast(result.reason);
      } else {
        metadataBackfillRequestActionError.value = result.reason;
      }
    } catch (error) {
      metadataBackfillRequestActionError.value = errorMessage(error, t("projects.couldNotCreateTheMetadata"));
    }
  }

  async function cancelMetadataBackfillRequest(): Promise<void> {
    const request = metadataBackfillRequest.value;
    if (!request || !metadataBackfillRequestIsActive.value || metadataBackfillRequestLoading.value) return;
    if (
      !(await confirmAction({
        title: t("projects.cancelThisMetadataBackfill"),
        message: t("projects.existingSessionDataIsNot"),
        confirmLabel: t("projects.cancelBackfill"),
        cancelLabel: t("common.keepWaiting"),
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
          "reason" in result ? result.reason : t("projects.thisMetadataBackfillCannotBe");
        return;
      }
      useToast().showToast(t("projects.metadataBackfillCancelledExistingSession"));
    } catch (error) {
      metadataBackfillRequestActionError.value = errorMessage(error, t("projects.couldNotCancelTheMetadata"));
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
        metadataBackfillActionError.value = errorMessage(error, t("projects.couldNotScanMetadataGaps"));
      }
    }
  }

  function openMetadataBackfillSession(item: MetadataBackfillItem): Promise<void> {
    return useSessionsStore().openSessionDetail(item.sessionId, t("projects.couldNotLoadTheSession"));
  }

  return {
    projectId,
    requestId,
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
