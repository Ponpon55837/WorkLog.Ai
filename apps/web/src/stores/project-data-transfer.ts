import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, nextTick, ref, watch } from "vue";
import type {
  ProjectDataExportScope,
  ProjectDataImportPreview,
  ProjectDataImportStagedHeader,
  ProjectDataImportStrategy,
  ProjectDataStagedImportOptions,
  ProjectPathRemap,
} from "@work-intelligence/core";
import { ApiError } from "../api/client";
import { useApi } from "../composables/useApi";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { useProjectsStore } from "./projects";
import { t } from "../i18n";

const MAX_PROJECT_IMPORT_MIB = 256;
const MAX_PROJECT_IMPORT_BYTES = MAX_PROJECT_IMPORT_MIB * 1024 * 1024;

function countItems(counts: ProjectDataImportPreview["additions"]): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/** The API answers 404 for a staged file that expired (30 minutes) or was already removed. */
function isStagedImportGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === "not_found";
}

function stagedImportErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status > 0 && error.code !== "malformed_response") return error.message;
  return errorMessage(error, fallback);
}

export const useProjectDataTransferStore = defineStore("project-data-transfer", () => {
  const queryCache = useQueryCache();
  const importStagingId = ref("");
  const importHeader = ref<ProjectDataImportStagedHeader | null>(null);
  const importFileName = ref("");
  const importProjectId = ref("");
  const importRemaps = ref<ProjectPathRemap[]>([]);
  // Importing between two computers that both keep working is the common case, so newer copies win by default.
  const importStrategy = ref<ProjectDataImportStrategy>("newer-wins");
  const importPreviewInput = ref<{ stagingId: string; options: ProjectDataStagedImportOptions } | null>(null);
  const importPreviewVisible = ref(false);
  const importPreviewRequestId = ref(0);
  const importPreviewLoading = ref(false);
  const importUploading = ref(false);
  const importApplying = ref(false);
  const portableExporting = ref(false);
  const importError = ref("");
  const transferError = ref("");
  let uploadRequestId = 0;
  let uploadAbort: AbortController | null = null;
  let previewedChoices = "";

  const importPreviewQuery = useQuery({
    key: queryKeys.projects.projectDataImportPreview,
    enabled: false,
    query: ({ signal }) => {
      const input = importPreviewInput.value;
      if (!input) throw new Error(t("projects.chooseAWorkIntelligenceExport"));
      return useApi().client.previewStagedProjectDataImport(input.stagingId, input.options, signal);
    },
  });

  const importProjects = computed(() => importHeader.value?.projects ?? []);
  const importPreview = computed(() => (importPreviewVisible.value ? (importPreviewQuery.data.value ?? null) : null));
  const importLoading = computed(() => importPreviewLoading.value || importApplying.value || importUploading.value);

  function cancelImportPreview(): void {
    importPreviewRequestId.value += 1;
    importPreviewVisible.value = false;
    importPreviewLoading.value = false;
    void queryCache.cancelQueries({ key: queryKeys.projects.projectDataImportPreview, exact: true });
  }

  function choicesKey(): string {
    return JSON.stringify([importProjectId.value, importStrategy.value, importRemaps.value]);
  }

  watch([importProjectId, importStrategy], () => {
    if (!importStagingId.value || choicesKey() === previewedChoices) return;
    cancelImportPreview();
    void previewProjectDataImport();
  });

  function currentRemaps(): ProjectPathRemap[] {
    return importRemaps.value.map((mapping) => ({ ...mapping }));
  }

  function currentOptions(): ProjectDataStagedImportOptions {
    const remap = currentRemaps();
    return {
      ...(importProjectId.value ? { projectId: importProjectId.value } : {}),
      ...(remap.length > 0 ? { remap } : {}),
      strategy: importStrategy.value,
    };
  }

  /** Cancels the staged file on the API; a failure only means it expires on its own. */
  function discardStaging(stagingId: string, keepalive = false): void {
    if (!stagingId) return;
    void useApi()
      .client.discardStagedProjectDataImport(stagingId, keepalive ? { keepalive } : undefined)
      .catch(() => undefined);
  }

  function resetImportFile(discard: boolean, keepalive = false): void {
    uploadRequestId += 1;
    uploadAbort?.abort();
    uploadAbort = null;
    cancelImportPreview();
    if (discard) discardStaging(importStagingId.value, keepalive);
    importStagingId.value = "";
    importHeader.value = null;
    importFileName.value = "";
    importProjectId.value = "";
    importRemaps.value = [];
    importUploading.value = false;
    previewedChoices = "";
  }

  function handleStagedImportError(error: unknown, fallback: string): void {
    if (isStagedImportGone(error)) resetImportFile(false);
    importError.value = stagedImportErrorMessage(error, fallback);
  }

  /**
   * Route leave or pagehide with a file staged: remove it on the API and forget it locally. `keepalive` is for
   * pagehide, where an ordinary request would be cancelled with the page. A running import is left alone so a failed
   * one can retry with the same file.
   */
  function discardImportFile(keepalive = false): void {
    if (importApplying.value) return;
    if (!importStagingId.value && !importUploading.value) return;
    resetImportFile(true, keepalive);
  }

  async function loadImportFile(file: File | undefined): Promise<void> {
    resetImportFile(true);
    importError.value = "";
    if (!file) return;
    if (file.size > MAX_PROJECT_IMPORT_BYTES) {
      importError.value = t("projects.importFilesCannotExceedLimit", { value: MAX_PROJECT_IMPORT_MIB });
      return;
    }
    const requestId = uploadRequestId;
    const controller = new AbortController();
    uploadAbort = controller;
    const strategy = importStrategy.value;
    importFileName.value = file.name;
    importUploading.value = true;
    try {
      const staged = await useApi().client.stageProjectDataImport(file, strategy, controller.signal);
      if (requestId !== uploadRequestId) {
        // A newer file replaced this one while it uploaded; the abandoned staging is not needed.
        discardStaging(staged.stagingId);
        return;
      }
      importStagingId.value = staged.stagingId;
      importHeader.value = staged.header;
      if (staged.header.scope.type === "project") importProjectId.value = staged.header.scope.projectId;
      previewedChoices = JSON.stringify([importProjectId.value, strategy, []]);
      queryCache.setQueryData(queryKeys.projects.projectDataImportPreview, staged.preview);
      importPreviewVisible.value = true;
      importUploading.value = false;
      // The user may have changed the strategy while the file uploaded.
      if (choicesKey() !== previewedChoices) await previewProjectDataImport();
    } catch (error) {
      if (requestId !== uploadRequestId || useApi().isAbortError(error)) return;
      importFileName.value = "";
      importError.value = stagedImportErrorMessage(error, t("projects.couldNotReadTheImport"));
    } finally {
      if (requestId === uploadRequestId) {
        importUploading.value = false;
        uploadAbort = null;
      }
    }
  }

  async function previewProjectDataImport(): Promise<void> {
    importError.value = "";
    importPreviewVisible.value = false;
    const stagingId = importStagingId.value;
    if (!stagingId) return;
    let requestId = importPreviewRequestId.value;
    try {
      requestId = ++importPreviewRequestId.value;
      importPreviewInput.value = { stagingId, options: currentOptions() };
      previewedChoices = choicesKey();
      importPreviewLoading.value = true;
      await queryCache.cancelQueries({ key: queryKeys.projects.projectDataImportPreview, exact: true });
      await nextTick();
      const result = await importPreviewQuery.refetch(true);
      if (requestId !== importPreviewRequestId.value) return;
      if (result.status !== "success") {
        throw result.error ?? new Error(t("projects.couldNotPreviewTheImport"));
      }
      importPreviewVisible.value = true;
    } catch (error) {
      if (requestId === importPreviewRequestId.value && !useApi().isAbortError(error)) {
        handleStagedImportError(error, t("projects.couldNotPreviewTheImport"));
      }
    } finally {
      if (requestId === importPreviewRequestId.value) importPreviewLoading.value = false;
    }
  }

  async function invalidateImportedProjectDataQueries(): Promise<void> {
    await Promise.all([
      queryCache.invalidateQueries({ key: queryKeys.dashboard.summary, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.list, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillView, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.metadataBackfillPreview, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.projects.handoffImportPreview }),
      queryCache.invalidateQueries({ key: queryKeys.projects.projectDataImportPreview, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.list }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.linkCandidates }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.list }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.history }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.candidates }),
      queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
      queryCache.invalidateQueries({ key: queryKeys.views.reports }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.list }),
      queryCache.invalidateQueries({ key: queryKeys.views.graph }),
      queryCache.invalidateQueries({ key: queryKeys.views.systemStatus, exact: true }),
      // The import wrote a pre-import snapshot, which the backup list shows.
      queryCache.invalidateQueries({ key: queryKeys.projects.backups, exact: true }),
    ]);
  }

  const importProjectDataMutation = useMutation({
    mutation: (input: { stagingId: string; options: ProjectDataStagedImportOptions }) =>
      useApi().client.importStagedProjectDataImport(input.stagingId, input.options),
    onSuccess: () => {
      void invalidateImportedProjectDataQueries().catch(() => undefined);
    },
  });

  async function applyProjectDataImport(): Promise<void> {
    const preview = importPreview.value;
    if (!preview) return;
    const stagingId = importStagingId.value;
    const additions = countItems(preview.additions);
    const updates = countItems(preview.updates);
    const keptLocal = countItems(preview.keptLocal);
    const skipped = countItems(preview.skipped);
    const conflicts = countItems(preview.conflicts);
    const confirmed = await confirmAction({
      title: t("projects.confirmProjectDataImport"),
      message: t("projects.recordsWillBeAddedAnd", { additions, updates, keptLocal, skipped, conflicts }),
      confirmLabel: t("projects.import"),
    });
    // The page was left while the dialog was open: the staged file is gone, so there is nothing to import.
    if (!confirmed || !stagingId || importStagingId.value !== stagingId) return;

    importApplying.value = true;
    importError.value = "";
    try {
      const result = await importProjectDataMutation.mutateAsync({
        stagingId,
        options: currentOptions(),
      });
      useToast().showToast(
        result.changed
          ? t("projects.importFinishedAddedSkippedIn", {
              value: countItems(result.additions),
              updates: countItems(result.updates),
              value2: countItems(result.skipped),
              value3: countItems(result.conflicts),
            })
          : t("projects.importFinishedNothingChanged"),
        "success",
      );
      // The API removes the staged file after a successful import, so nothing is left to discard.
      resetImportFile(false);
    } catch (error) {
      handleStagedImportError(error, t("projects.couldNotImportProjectData"));
    } finally {
      importApplying.value = false;
    }
  }

  function replaceImportRemaps(mappings: readonly ProjectPathRemap[]): void {
    const bySource = new Map(importRemaps.value.map((mapping) => [mapping.from, mapping]));
    for (const mapping of mappings) bySource.set(mapping.from, { ...mapping });
    importRemaps.value = [...bySource.values()];
  }

  function pathBasename(value: string): string {
    const normalized = value.replace(/[\\/]+$/, "");
    const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    return normalized.slice(separator + 1);
  }

  function siblingPath(parent: string, name: string): string {
    const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    const trimmedParent = parent.replace(/[\\/]+$/, "");
    return `${trimmedParent || separator}${trimmedParent ? separator : ""}${name}`;
  }

  /** Picks a replacement folder, then offers matching sibling folders without applying them automatically. */
  async function chooseImportProjectLocation(projectId: string): Promise<void> {
    const project = importPreview.value?.selectedProjects.find((item) => item.id === projectId);
    if (!project) return;
    const selected = await useProjectsStore().pickProjectFolder();
    if (!selected) return;

    const mapping = { from: project.sourceRootPath, to: selected.path };
    replaceImportRemaps([mapping]);
    await previewProjectDataImport();

    const updatedPreview = importPreview.value;
    if (!updatedPreview) return;
    const separator = Math.max(selected.path.lastIndexOf("/"), selected.path.lastIndexOf("\\"));
    const parent = separator > 0 ? selected.path.slice(0, separator) : selected.path.slice(0, separator + 1);
    const candidateLimit = Math.max(0, 20 - currentRemaps().length);
    const candidates = updatedPreview.selectedProjects
      .filter((item) => item.id !== projectId && item.folderStatus !== "found" && item.resolution === "new")
      .map((item) => ({
        id: item.id,
        name: item.name,
        mapping: { from: item.sourceRootPath, to: siblingPath(parent, pathBasename(item.sourceRootPath)) },
      }))
      .filter((item) => pathBasename(item.mapping.to).length > 0)
      .slice(0, candidateLimit);
    if (candidates.length === 0) return;

    const suggestedRemaps = new Map(currentRemaps().map((item) => [item.from, item]));
    for (const candidate of candidates) suggestedRemaps.set(candidate.mapping.from, candidate.mapping);
    const suggestedOptions: ProjectDataStagedImportOptions = {
      ...currentOptions(),
      remap: [...suggestedRemaps.values()],
    };
    let suggestedPreview: ProjectDataImportPreview;
    try {
      suggestedPreview = await useApi().client.previewStagedProjectDataImport(importStagingId.value, suggestedOptions);
    } catch (error) {
      if (isStagedImportGone(error)) handleStagedImportError(error, t("projects.couldNotPreviewTheImport"));
      return;
    }
    const foundIds = new Set(
      suggestedPreview.selectedProjects
        .filter((item) => item.folderStatus === "found" && item.resolution !== "conflict")
        .map((item) => item.id),
    );
    const foundCandidates = candidates.filter((item) => foundIds.has(item.id));
    if (foundCandidates.length === 0) return;

    const confirmed = await confirmAction({
      title: t("projects.applyOtherProjectsLocations"),
      message: t("projects.otherProjectsAlsoHaveA", {
        length: foundCandidates.length,
      }),
      confirmLabel: t("projects.applyToAll"),
    });
    if (!confirmed) return;

    replaceImportRemaps(foundCandidates.map((item) => item.mapping));
    await previewProjectDataImport();
  }

  async function exportProjectData(scope: ProjectDataExportScope): Promise<void> {
    transferError.value = "";
    portableExporting.value = true;
    try {
      const { blob, fileName } = await useApi().client.exportProjectData(scope);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      useToast().showToast(t("projects.projectDataExportedTheFile"), "success");
    } catch (error) {
      transferError.value = errorMessage(error, t("projects.couldNotExportProjectData"));
    } finally {
      portableExporting.value = false;
    }
  }

  return {
    transferError,
    portableExporting,
    importProjects,
    importFileName,
    importUploading,
    importProjectId,
    importRemaps,
    importStrategy,
    importLoading,
    importPreview,
    importError,
    loadImportFile,
    discardImportFile,
    previewProjectDataImport,
    chooseImportProjectLocation,
    applyProjectDataImport,
    exportProjectData,
  };
});
