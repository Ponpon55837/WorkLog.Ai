import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { UsageProjectsResponse, UsageScanRequest, UsageScanResponse } from "@work-intelligence/core";
import { ApiError } from "../api/client";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { fillDailyRange, usageErrorMessage, usageSharedRows } from "../utils/usage";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the usage page's tracked-project list and its on-demand scan; the scan result is never cached across visits. */
export const useUsageStore = defineStore("usage", () => {
  const queryCache = useQueryCache();
  const usageActive = ref(false);
  const scanResult = ref<UsageScanResponse | null>(null);
  const scanErrorCode = ref("");
  const scanFailed = ref(false);
  const scanSequence = ref(0);
  const scanController = ref<AbortController | null>(null);

  const projectsQuery = useQuery({
    key: queryKeys.usage.projects,
    enabled: usageActive,
    query: ({ signal }): Promise<UsageProjectsResponse> => useApi().client.getUsageProjects(signal),
  });

  const scanMutation = useMutation({
    mutation: ({ request, signal }: { request: UsageScanRequest; signal: AbortSignal }): Promise<UsageScanResponse> =>
      useApi().client.scanUsage(request, signal),
  });

  const projects = computed(() => projectsQuery.data.value?.items ?? []);
  const projectGroups = computed(() => projectsQuery.data.value?.groups ?? []);
  const projectById = computed(() => new Map(projects.value.map((project) => [project.id, project])));
  const projectsLoaded = computed(() => projectsQuery.data.value !== undefined);
  const projectsLoading = computed(() => projectsQuery.isLoading.value);
  const projectsError = computed(() => (projectsQuery.error.value ? usageErrorMessage(undefined) : ""));
  const scanning = computed(() => scanMutation.isLoading.value);
  const scanError = computed(() => (scanFailed.value ? usageErrorMessage(scanErrorCode.value) : ""));
  const sharedRows = computed(() =>
    scanResult.value ? usageSharedRows(scanResult.value.allocation, projects.value) : [],
  );
  const dailyPoints = computed(() =>
    scanResult.value ? fillDailyRange(scanResult.value.daily, scanResult.value.range) : [],
  );

  /** Runs one scan; a newer scan aborts the previous one, and an aborted scan never overwrites the newer result. */
  async function runScan(request: UsageScanRequest): Promise<void> {
    scanController.value?.abort();
    const controller = new AbortController();
    scanController.value = controller;
    const sequence = scanSequence.value + 1;
    scanSequence.value = sequence;
    scanFailed.value = false;
    scanErrorCode.value = "";
    try {
      const result = await scanMutation.mutateAsync({ request, signal: controller.signal });
      if (sequence === scanSequence.value) scanResult.value = result;
    } catch (error) {
      if (sequence !== scanSequence.value || controller.signal.aborted) return;
      scanResult.value = null;
      scanFailed.value = true;
      scanErrorCode.value = error instanceof ApiError ? error.code : "";
    }
  }

  /** Copies the server-built Agent text verbatim; folder names the user typed are never part of it. */
  async function copyForAgent(): Promise<boolean> {
    if (!scanResult.value) return false;
    return useToast().copyWithToast(scanResult.value.forAgentText, t("usage.copied"));
  }

  async function refreshProjects(): Promise<void> {
    try {
      await projectsQuery.refetch(true);
    } catch {
      // Query errors are exposed through projectsError for the page to render.
    }
  }

  function setUsageActive(active: boolean): void {
    if (active) {
      void queryCache.invalidateQueries({ key: queryKeys.usage.projects, exact: true }, false);
      usageActive.value = true;
      return;
    }

    usageActive.value = false;
    queryCache.cancelQueries({ key: queryKeys.usage.projects, exact: true });
    // Closing the page cancels a running scan so the server stops reading logs.
    scanSequence.value += 1;
    scanController.value?.abort();
    scanController.value = null;
  }

  return {
    projects,
    projectById,
    projectGroups,
    projectsLoaded,
    projectsLoading,
    projectsError,
    scanResult,
    scanning,
    scanError,
    sharedRows,
    dailyPoints,
    refreshProjects,
    runScan,
    copyForAgent,
    setUsageActive,
  };
});
