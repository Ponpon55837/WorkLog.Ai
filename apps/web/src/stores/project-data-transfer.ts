import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, nextTick, ref, watch } from "vue";
import type {
  ProjectDataExport,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectPathRemap,
} from "@work-intelligence/core";
import { projectDataExportSchema } from "@work-intelligence/schema";
import { useApi } from "../composables/useApi";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { useProjectsStore } from "./projects";
import { t } from "../i18n";

const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;

function countItems(counts: ProjectDataImportPreview["additions"]): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/** Owns portable project file state, import preview/apply operations, and exports. */
export const useProjectDataTransferStore = defineStore("project-data-transfer", () => {
  const queryCache = useQueryCache();
  const importBundle = ref<ProjectDataExport | null>(null);
  const importFileName = ref("");
  const importProjectId = ref("");
  const importRemaps = ref<ProjectPathRemap[]>([]);
  const importPreviewInput = ref<ProjectDataImportInput | null>(null);
  const importPreviewVisible = ref(false);
  const importPreviewRequestId = ref(0);
  const importPreviewLoading = ref(false);
  const importApplying = ref(false);
  const portableExporting = ref(false);
  const importError = ref("");
  const transferError = ref("");

  const importPreviewQuery = useQuery({
    key: queryKeys.projects.projectDataImportPreview,
    enabled: false,
    query: () => {
      const input = importPreviewInput.value;
      if (!input) throw new Error(t("projects.chooseAWorkIntelligenceExport"));
      return useApi().client.previewProjectDataImport(input);
    },
  });

  const importProjects = computed(() =>
    (importBundle.value?.tables.projects ?? []).map((project) => ({
      id: String(project.id),
      name: String(project.name),
    })),
  );
  const importPreview = computed(() => (importPreviewVisible.value ? (importPreviewQuery.data.value ?? null) : null));
  const importLoading = computed(() => importPreviewLoading.value || importApplying.value);

  function cancelImportPreview(): void {
    importPreviewRequestId.value += 1;
    importPreviewVisible.value = false;
    importPreviewLoading.value = false;
    void queryCache.cancelQueries({ key: queryKeys.projects.projectDataImportPreview, exact: true });
  }

  watch(importProjectId, () => {
    cancelImportPreview();
    if (importBundle.value) void previewProjectDataImport();
  });

  function currentRemaps(): ProjectPathRemap[] {
    return importRemaps.value.map((mapping) => ({ ...mapping }));
  }

  function currentInput(): ProjectDataImportInput {
    if (!importBundle.value) throw new Error(t("projects.chooseAWorkIntelligenceExport"));
    const remap = currentRemaps();
    return {
      bundle: importBundle.value,
      ...(importProjectId.value ? { projectId: importProjectId.value } : {}),
      ...(remap.length > 0 ? { remap } : {}),
    };
  }

  /** Reads and validates a portable project export without sending its contents to the API. */
  async function loadImportFile(file: File | undefined): Promise<void> {
    cancelImportPreview();
    importError.value = "";
    importBundle.value = null;
    importFileName.value = "";
    importProjectId.value = "";
    importRemaps.value = [];
    if (!file) return;
    if (file.size > MAX_PROJECT_IMPORT_BYTES) {
      importError.value = t("projects.importFilesCannotExceed50");
      return;
    }
    try {
      const parsedJson: unknown = JSON.parse(await file.text());
      const parsed = projectDataExportSchema.safeParse(parsedJson);
      if (!parsed.success) {
        importError.value = t("projects.theExportFileIsMalformed", {
          value: parsed.error.issues[0]?.message ?? t("projects.fieldValidationFailed"),
        });
        return;
      }
      if (parsed.data.scope.type === "project") importProjectId.value = parsed.data.scope.projectId;
      importBundle.value = parsed.data satisfies ProjectDataExport;
      importFileName.value = file.name;
      await previewProjectDataImport();
    } catch (error) {
      importError.value = errorMessage(error, t("projects.couldNotReadTheImport"));
    }
  }

  /** Previews the selected scope and path changes without writing to SQLite. */
  async function previewProjectDataImport(): Promise<void> {
    importError.value = "";
    importPreviewVisible.value = false;
    let requestId = importPreviewRequestId.value;
    try {
      const input = currentInput();
      requestId = ++importPreviewRequestId.value;
      importPreviewInput.value = input;
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
        importError.value = errorMessage(error, t("projects.couldNotPreviewTheImport"));
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
    ]);
  }

  const importProjectDataMutation = useMutation({
    mutation: (input: ProjectDataImportInput) => useApi().client.importProjectData(input),
    onSuccess: () => {
      void invalidateImportedProjectDataQueries().catch(() => undefined);
    },
  });

  async function applyProjectDataImport(): Promise<void> {
    const preview = importPreview.value;
    if (!preview) return;
    const additions = countItems(preview.additions);
    const skipped = countItems(preview.skipped);
    const conflicts = countItems(preview.conflicts);
    const confirmed = await confirmAction({
      title: t("projects.confirmProjectDataImport"),
      message: t("projects.recordsWillBeAddedAnd", { additions, skipped, conflicts }),
      confirmLabel: t("projects.import"),
    });
    if (!confirmed) return;

    importApplying.value = true;
    importError.value = "";
    try {
      const result = await importProjectDataMutation.mutateAsync(currentInput());
      useToast().showToast(
        t("projects.importFinishedAddedSkippedIn", {
          value: countItems(result.additions),
          value2: countItems(result.skipped),
          value3: countItems(result.conflicts),
        }),
        "success",
      );
      cancelImportPreview();
      importBundle.value = null;
      importFileName.value = "";
      importProjectId.value = "";
      importRemaps.value = [];
    } catch (error) {
      importError.value = errorMessage(error, t("projects.couldNotImportProjectData"));
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
    const suggestedInput: ProjectDataImportInput = {
      ...currentInput(),
      remap: [...suggestedRemaps.values()],
    };
    let suggestedPreview: ProjectDataImportPreview;
    try {
      suggestedPreview = await useApi().client.previewProjectDataImport(suggestedInput);
    } catch {
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
    importProjectId,
    importRemaps,
    importLoading,
    importPreview,
    importError,
    loadImportFile,
    previewProjectDataImport,
    chooseImportProjectLocation,
    applyProjectDataImport,
    exportProjectData,
  };
});
