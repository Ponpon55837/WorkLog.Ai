import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, nextTick, ref } from "vue";
import type {
  HandoffImportApplyInput,
  HandoffImportPreview,
  HandoffImportPreviewItem,
  HandoffImportPreviewResult,
  ProjectRecord,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

function previewKey(project: ProjectRecord): readonly string[] {
  return [...queryKeys.projects.handoffImportPreview, project.id, project.rootPath];
}

/** Owns the handoff preview workflow and imports selected completed handoffs as Sessions. */
export const useHandoffImportStore = defineStore("handoff-import", () => {
  const queryCache = useQueryCache();
  const previewProject = ref<ProjectRecord | null>(null);
  const previewVisible = ref(false);
  const previewRequestId = ref(0);
  const handoffImportProjectId = ref("");
  const handoffImportSelection = ref<string[]>([]);
  const handoffImportLoading = ref(false);
  const handoffImportApplying = ref(false);
  const handoffImportError = ref("");
  let importRefreshPromise: Promise<void> = Promise.resolve();

  const previewQuery = useQuery({
    key: () =>
      previewProject.value ? previewKey(previewProject.value) : [...queryKeys.projects.handoffImportPreview, ""],
    enabled: false,
    query: ({ signal }): Promise<HandoffImportPreviewResult> => {
      const project = previewProject.value;
      if (!project) throw new Error(t("projects.chooseAProjectToPreview"));
      return useApi().client.previewHandoffs(project.rootPath, undefined, signal);
    },
  });

  const handoffImportPreview = computed<HandoffImportPreview | null>(() => {
    const data = previewQuery.data.value;
    return previewVisible.value && data?.outcome === "preview" ? data : null;
  });
  const importableHandoffs = computed(
    () => handoffImportPreview.value?.items.filter((item) => item.decision === "eligible") ?? [],
  );
  const selectedHandoffCount = computed(() => handoffImportSelection.value.length);

  async function invalidateImportedHandoffQueries(): Promise<void> {
    await Promise.all([
      queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.list }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.linkCandidates }),
      queryCache.invalidateQueries({ key: queryKeys.commandPalette.search, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.views.reports }),
      queryCache.invalidateQueries({ key: queryKeys.views.graph }),
    ]);
  }

  const applyHandoffImportMutation = useMutation({
    mutation: (input: HandoffImportApplyInput) => useApi().client.importHandoffs(input),
    onSuccess: (result) => {
      if (result.outcome === "imported") {
        // Start refreshes before returning from the mutation; the dialog closes before they finish.
        importRefreshPromise = invalidateImportedHandoffQueries();
      }
    },
  });

  function isHandoffSelected(sourcePath: string): boolean {
    return handoffImportSelection.value.includes(sourcePath);
  }

  function toggleHandoffSelection(item: HandoffImportPreviewItem): void {
    if (item.decision !== "eligible") return;
    handoffImportSelection.value = isHandoffSelected(item.sourcePath)
      ? handoffImportSelection.value.filter((path) => path !== item.sourcePath)
      : [...handoffImportSelection.value, item.sourcePath];
  }

  function selectAllHandoffs(): void {
    handoffImportSelection.value = importableHandoffs.value.map((item) => item.sourcePath);
  }

  function clearHandoffSelection(): void {
    handoffImportSelection.value = [];
  }

  function handoffDecisionLabel(item: HandoffImportPreviewItem): string {
    if (item.decision === "eligible") return t("projects.importable");
    if (item.decision === "already_imported") return t("projects.imported");
    if (item.reason === "excluded_by_user") return t("projects.excludedByYou");
    if (item.reason === "blocked") return t("projects.blockedSkipped");
    if (item.reason === "pending") return t("projects.pendingSkipped");
    if (item.reason === "planning_only") return t("projects.planningOnlySkipped");
    if (item.decision === "error") return t("projects.readFailed");
    return t("projects.completionStatusMissing");
  }

  async function previewHandoffs(project: ProjectRecord): Promise<void> {
    const requestId = ++previewRequestId.value;
    handoffImportLoading.value = true;
    handoffImportError.value = "";
    handoffImportProjectId.value = project.id;
    handoffImportSelection.value = [];
    previewVisible.value = false;
    await queryCache.cancelQueries({ key: queryKeys.projects.handoffImportPreview });
    previewProject.value = project;

    try {
      await nextTick();
      const result = await previewQuery.refetch(true);
      if (requestId !== previewRequestId.value) return;
      if (result.status !== "success") {
        const error = result.error;
        handoffImportError.value = errorMessage(error, t("projects.couldNotBuildTheHandoff"));
        useToast().showToast(handoffImportError.value);
        return;
      }
      if (result.data.outcome !== "preview") {
        useToast().showToast(result.data.reason);
        return;
      }
      previewVisible.value = true;
    } catch (error) {
      if (requestId !== previewRequestId.value || useApi().isAbortError(error)) return;
      handoffImportError.value = errorMessage(error, t("projects.couldNotBuildTheHandoff"));
      useToast().showToast(handoffImportError.value);
    } finally {
      if (requestId === previewRequestId.value) handoffImportLoading.value = false;
    }
  }

  function closeHandoffImport(): void {
    previewRequestId.value += 1;
    void queryCache.cancelQueries({ key: queryKeys.projects.handoffImportPreview });
    previewVisible.value = false;
    previewProject.value = null;
    handoffImportProjectId.value = "";
    handoffImportSelection.value = [];
    handoffImportLoading.value = false;
    handoffImportError.value = "";
  }

  async function applyHandoffImport(): Promise<void> {
    const preview = handoffImportPreview.value;
    const sourcePaths = [...handoffImportSelection.value];
    if (!preview || sourcePaths.length === 0) return;

    handoffImportApplying.value = true;
    handoffImportError.value = "";
    try {
      const result = await applyHandoffImportMutation.mutateAsync({
        projectRoot: preview.project.rootPath,
        handoffDirectory: preview.handoffDirectory,
        sourcePaths,
      });
      if (result.outcome !== "imported") {
        handoffImportError.value = result.reason;
        return;
      }

      useToast().showToast(
        t("projects.importedHandoffsSkippedFailed", {
          length: result.imported.length,
          length2: result.skipped.length,
          length3: result.failures.length,
        }),
      );
      closeHandoffImport();
      await importRefreshPromise;
    } catch (error) {
      handoffImportError.value = errorMessage(error, t("projects.couldNotApplyTheHandoff"));
    } finally {
      handoffImportApplying.value = false;
    }
  }

  return {
    handoffImportPreview,
    handoffImportProjectId,
    handoffImportLoading,
    handoffImportApplying,
    handoffImportError,
    importableHandoffs,
    selectedHandoffCount,
    isHandoffSelected,
    toggleHandoffSelection,
    selectAllHandoffs,
    clearHandoffSelection,
    handoffDecisionLabel,
    previewHandoffs,
    closeHandoffImport,
    applyHandoffImport,
  };
});
