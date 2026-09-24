import { computed, ref } from "vue";
import type { HandoffImportPreview, HandoffImportPreviewItem, ProjectRecord } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useProjects } from "./useProjects";
import { useReports } from "./useReports";
import { useSessions } from "./useSessions";
import { useToast } from "./useToast";

const handoffImportPreview = ref<HandoffImportPreview | null>(null);
const handoffImportProjectId = ref("");
const handoffImportSelection = ref<string[]>([]);
const handoffImportLoading = ref(false);
const handoffImportApplying = ref(false);
const handoffImportError = ref("");

const importableHandoffs = computed(
  () => handoffImportPreview.value?.items.filter((item) => item.decision === "eligible") ?? [],
);
const selectedHandoffCount = computed(() => handoffImportSelection.value.length);

function isHandoffSelected(sourcePath: string): boolean {
  return handoffImportSelection.value.includes(sourcePath);
}

function toggleHandoffSelection(item: HandoffImportPreviewItem): void {
  if (item.decision !== "eligible") {
    return;
  }
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
  if (item.decision === "eligible") {
    return "可匯入";
  }
  if (item.decision === "already_imported") {
    return "已匯入";
  }
  if (item.reason === "excluded_by_user") {
    return "使用者排除";
  }
  if (item.reason === "blocked") {
    return "Blocked，略過";
  }
  if (item.reason === "pending") {
    return "Pending，略過";
  }
  if (item.reason === "planning_only") {
    return "僅規劃，略過";
  }
  if (item.decision === "error") {
    return "讀取失敗";
  }
  return "缺少完成狀態";
}

async function previewHandoffs(project: ProjectRecord): Promise<void> {
  handoffImportLoading.value = true;
  handoffImportError.value = "";
  handoffImportProjectId.value = project.id;
  await runKeyed(
    "handoff-preview",
    async (signal) => {
      const result = await useApi().client.previewHandoffs(project.rootPath, undefined, signal);
      if (result.outcome !== "preview") {
        useToast().showToast(result.reason);
        return;
      }
      handoffImportPreview.value = result;
      handoffImportSelection.value = [];
    },
    {
      onError: (error) => {
        handoffImportError.value = errorMessage(error, "無法建立 handoff 匯入預覽。");
        useToast().showToast(handoffImportError.value);
      },
      onSettled: () => {
        handoffImportLoading.value = false;
      },
    },
  );
}

function closeHandoffImport(): void {
  handoffImportPreview.value = null;
  handoffImportProjectId.value = "";
  handoffImportSelection.value = [];
  handoffImportError.value = "";
}

async function applyHandoffImport(): Promise<void> {
  const preview = handoffImportPreview.value;
  if (!preview || handoffImportSelection.value.length === 0) {
    return;
  }
  handoffImportApplying.value = true;
  handoffImportError.value = "";
  try {
    const result = await useApi().client.importHandoffs({
      projectRoot: preview.project.rootPath,
      handoffDirectory: preview.handoffDirectory,
      sourcePaths: handoffImportSelection.value,
    });
    if (result.outcome !== "imported") {
      handoffImportError.value = result.reason;
      return;
    }
    useToast().showToast(
      `已匯入 ${result.imported.length} 個 handoff；略過 ${result.skipped.length} 個，失敗 ${result.failures.length} 個。`,
    );
    closeHandoffImport();
    const { loadDashboard, loadProjects } = useProjects();
    await Promise.all([loadDashboard(), loadProjects(), useSessions().loadSessions()]);
    const reports = useReports();
    if (reports.report.value) {
      await reports.loadReport();
    }
  } catch (error) {
    handoffImportError.value = errorMessage(error, "套用 handoff 匯入失敗。");
  } finally {
    handoffImportApplying.value = false;
  }
}

export function useHandoffImport() {
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
}
