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
  const importRemapFrom = ref("");
  const importRemapTo = ref("");
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
      if (!input) throw new Error("請先選擇 Work Intelligence 匯出檔。");
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

  watch([importProjectId, importRemapFrom, importRemapTo], cancelImportPreview);

  function currentRemaps(): ProjectPathRemap[] {
    if (!importRemapFrom.value && !importRemapTo.value) return [];
    if (!importRemapFrom.value || !importRemapTo.value) {
      throw new Error("請同時填寫舊路徑前綴與新路徑前綴。");
    }
    return [{ from: importRemapFrom.value.trim(), to: importRemapTo.value.trim() }];
  }

  function currentInput(): ProjectDataImportInput {
    if (!importBundle.value) throw new Error("請先選擇 Work Intelligence 匯出檔。");
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
    if (!file) return;
    if (file.size > MAX_PROJECT_IMPORT_BYTES) {
      importError.value = "匯入檔不可超過 50 MiB。";
      return;
    }
    try {
      const parsedJson: unknown = JSON.parse(await file.text());
      const parsed = projectDataExportSchema.safeParse(parsedJson);
      if (!parsed.success) {
        importError.value = `匯出檔格式錯誤：${parsed.error.issues[0]?.message ?? "欄位驗證失敗。"}`;
        return;
      }
      importBundle.value = parsed.data satisfies ProjectDataExport;
      importFileName.value = file.name;
      if (parsed.data.scope.type === "project") importProjectId.value = parsed.data.scope.projectId;
    } catch (error) {
      importError.value = errorMessage(error, "無法讀取匯入檔。");
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
        throw result.error ?? new Error("無法預覽匯入資料。");
      }
      importPreviewVisible.value = true;
    } catch (error) {
      if (requestId === importPreviewRequestId.value && !useApi().isAbortError(error)) {
        importError.value = errorMessage(error, "無法預覽匯入資料。");
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
      queryCache.invalidateQueries({ key: queryKeys.sessions.list, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.detail }),
      queryCache.invalidateQueries({ key: queryKeys.sessions.linkCandidates }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.list, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.history }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.candidates }),
      queryCache.invalidateQueries({ key: queryKeys.commandPalette.search }),
      queryCache.invalidateQueries({ key: queryKeys.views.reports }),
      queryCache.invalidateQueries({ key: queryKeys.views.knowledge, exact: true }),
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
      title: "確認匯入專案資料",
      message: `即將新增 ${additions} 筆、略過 ${skipped} 筆、保留衝突 ${conflicts} 筆既有資料不變。新匯入的專案會先暫停記錄。`,
      confirmLabel: "匯入",
    });
    if (!confirmed) return;

    importApplying.value = true;
    importError.value = "";
    try {
      const result = await importProjectDataMutation.mutateAsync(currentInput());
      useToast().showToast(
        `匯入完成：新增 ${countItems(result.additions)} 筆、略過 ${countItems(result.skipped)} 筆，衝突 ${countItems(result.conflicts)} 筆。`,
        "success",
      );
      cancelImportPreview();
      importBundle.value = null;
      importFileName.value = "";
      importProjectId.value = "";
      importRemapFrom.value = "";
      importRemapTo.value = "";
    } catch (error) {
      importError.value = errorMessage(error, "匯入專案資料失敗。");
    } finally {
      importApplying.value = false;
    }
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
      useToast().showToast("已匯出專案資料。檔案沒有加密，請妥善保管。", "success");
    } catch (error) {
      transferError.value = errorMessage(error, "匯出專案資料失敗。");
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
    importRemapFrom,
    importRemapTo,
    importLoading,
    importPreview,
    importError,
    loadImportFile,
    previewProjectDataImport,
    applyProjectDataImport,
    exportProjectData,
  };
});
