import { computed, ref, watch } from "vue";
import type {
  ProjectDataExport,
  ProjectDataExportScope,
  ProjectDataImportInput,
  ProjectDataImportPreview,
  ProjectPathRemap,
} from "@work-intelligence/core";
import { projectDataExportSchema } from "@work-intelligence/schema";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;
const importBundle = ref<ProjectDataExport | null>(null);
const importFileName = ref("");
const importProjectId = ref("");
const importRemapFrom = ref("");
const importRemapTo = ref("");
const importLoading = ref(false);
const portableExporting = ref(false);
const importPreview = ref<ProjectDataImportPreview | null>(null);
const importError = ref("");
const importProjects = computed(() =>
  (importBundle.value?.tables.projects ?? []).map((project) => ({
    id: String(project.id),
    name: String(project.name),
  })),
);

watch([importProjectId, importRemapFrom, importRemapTo], () => {
  importPreview.value = null;
});

function currentRemaps(): ProjectPathRemap[] {
  if (!importRemapFrom.value && !importRemapTo.value) {
    return [];
  }
  if (!importRemapFrom.value || !importRemapTo.value) {
    throw new Error("請同時填寫舊路徑前綴與新路徑前綴。");
  }
  return [{ from: importRemapFrom.value.trim(), to: importRemapTo.value.trim() }];
}

function currentInput(): ProjectDataImportInput {
  if (!importBundle.value) {
    throw new Error("請先選擇 Work Intelligence 匯出檔。");
  }
  const remap = currentRemaps();
  return {
    bundle: importBundle.value,
    ...(importProjectId.value ? { projectId: importProjectId.value } : {}),
    ...(remap.length > 0 ? { remap } : {}),
  };
}

/** Reads and validates a portable project export without sending its contents to the API. */
async function loadImportFile(file: File | undefined): Promise<void> {
  importPreview.value = null;
  importError.value = "";
  importBundle.value = null;
  importFileName.value = "";
  importProjectId.value = "";
  if (!file) {
    return;
  }
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
    importBundle.value = parsed.data as unknown as ProjectDataExport;
    importFileName.value = file.name;
    if (parsed.data.scope.type === "project") {
      importProjectId.value = parsed.data.scope.projectId;
    }
  } catch (error) {
    importError.value = errorMessage(error, "無法讀取匯入檔。");
  }
}

/** Previews the selected scope and path changes without writing to SQLite. */
async function previewProjectDataImport(): Promise<void> {
  importError.value = "";
  importPreview.value = null;
  try {
    const input = currentInput();
    importLoading.value = true;
    await runKeyed(
      "project-data-import-preview",
      async () => {
        importPreview.value = await useApi().client.previewProjectDataImport(input);
      },
      { onError: (error) => (importError.value = errorMessage(error, "無法預覽匯入資料。")) },
    );
  } catch (error) {
    importError.value = errorMessage(error, "無法預覽匯入資料。");
  } finally {
    importLoading.value = false;
  }
}

function countItems(counts: ProjectDataImportPreview["additions"]): number {
  return Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
}

/** Confirms the preview and applies the merge; the server recalculates it inside its transaction. */
async function applyProjectDataImport(): Promise<void> {
  const preview = importPreview.value;
  if (!preview) {
    return;
  }
  const additions = countItems(preview.additions);
  const skipped = countItems(preview.skipped);
  const conflicts = countItems(preview.conflicts);
  const confirmed = await confirmAction({
    title: "確認匯入專案資料",
    message: `即將新增 ${additions} 筆、略過 ${skipped} 筆、保留衝突 ${conflicts} 筆既有資料不變。新匯入的專案會先暫停記錄。`,
    confirmLabel: "匯入",
  });
  if (!confirmed) {
    return;
  }

  importLoading.value = true;
  importError.value = "";
  try {
    const result = await useApi().client.importProjectData(currentInput());
    useToast().showToast(
      `匯入完成：新增 ${countItems(result.additions)} 筆、略過 ${countItems(result.skipped)} 筆，衝突 ${countItems(result.conflicts)} 筆。`,
      "success",
    );
    importPreview.value = null;
    importBundle.value = null;
    importFileName.value = "";
    importProjectId.value = "";
    importRemapFrom.value = "";
    importRemapTo.value = "";
  } catch (error) {
    importError.value = errorMessage(error, "匯入專案資料失敗。");
  } finally {
    importLoading.value = false;
  }
}

/** Downloads portable exports and keeps the preview / merge state for the backup screen. */
export function useProjectDataTransfer() {
  const transferError = ref("");

  async function exportProjectData(scope: ProjectDataExportScope): Promise<void> {
    const { showToast } = useToast();
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
      showToast("已匯出專案資料。檔案沒有加密，請妥善保管。", "success");
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
}
