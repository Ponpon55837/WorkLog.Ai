import { ref } from "vue";
import { storeToRefs } from "pinia";
import type { KnowledgeAuditRecord, KnowledgeKind, KnowledgeRecord, KnowledgeStatus } from "@work-intelligence/core";
import { useKnowledgeStore, type KnowledgeChanges } from "../stores/knowledge";
import { errorMessage } from "../utils/format";
import { useProjects } from "./useProjects";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

const knowledgeEditor = ref<KnowledgeRecord | null>(null);
const knowledgeEditorForm = ref({
  kind: "pattern" as KnowledgeKind,
  title: "",
  body: "",
  tags: "",
  references: "",
  appliesTo: "",
  status: "active" as KnowledgeStatus,
});
const knowledgeEditorSaving = ref(false);
const knowledgeEditorError = ref("");
const knowledgeHistoryItem = ref<KnowledgeRecord | null>(null);

function knowledgeProject(
  item: KnowledgeRecord,
): ReturnType<typeof useProjects>["projects"]["value"][number] | undefined {
  return (
    useProjects().projects.value.find((project) => project.id === item.projectId) ??
    useKnowledgeStore().knowledgeProjects.find((project) => project.id === item.projectId)
  );
}

async function patchKnowledge(item: KnowledgeRecord, changes: KnowledgeChanges): Promise<boolean> {
  const { showToast } = useToast();
  const project = knowledgeProject(item);
  if (!project) {
    showToast("找不到這筆 Knowledge 所屬的 tracked project。");
    return false;
  }
  try {
    const result = await useKnowledgeStore().updateKnowledge({
      knowledgeId: item.id,
      projectRoot: project.rootPath,
      ...changes,
    });
    if (result.outcome !== "knowledge_updated") {
      showToast(result.outcome === "skipped" ? result.reason : "Knowledge 已不存在。");
      return false;
    }
    return true;
  } catch (error) {
    showToast(errorMessage(error, "更新 Knowledge 失敗。"));
    return false;
  }
}

function splitKnowledgeValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function openKnowledgeEditor(item: KnowledgeRecord): void {
  knowledgeEditor.value = item;
  knowledgeEditorForm.value = {
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags.join(", "),
    references: item.references.join("\n"),
    appliesTo: item.appliesTo.join("\n"),
    status: item.status,
  };
  knowledgeEditorError.value = "";
}

function closeKnowledgeEditor(): void {
  if (knowledgeEditorSaving.value) return;
  knowledgeEditor.value = null;
  knowledgeEditorError.value = "";
}

async function saveKnowledge(): Promise<void> {
  const item = knowledgeEditor.value;
  if (!item) return;
  const form = knowledgeEditorForm.value;
  if (!form.title.trim() || !form.body.trim()) {
    knowledgeEditorError.value = "標題與內容不能留白。";
    return;
  }
  knowledgeEditorSaving.value = true;
  knowledgeEditorError.value = "";
  const saved = await patchKnowledge(item, {
    kind: form.kind,
    title: form.title.trim(),
    body: form.body.trim(),
    tags: splitKnowledgeValues(form.tags),
    references: splitKnowledgeValues(form.references),
    appliesTo: splitKnowledgeValues(form.appliesTo),
    status: form.status,
  });
  knowledgeEditorSaving.value = false;
  if (saved) {
    useToast().showToast(form.status === "archived" ? "Knowledge 已更新並封存。" : "Knowledge 已更新。");
    closeKnowledgeEditor();
  }
}

async function setKnowledgeStatus(item: KnowledgeRecord, status: KnowledgeStatus): Promise<void> {
  if (!(await patchKnowledge(item, { status }))) return;
  useToast().showToast(status === "archived" ? "Knowledge 已封存。" : "Knowledge 已恢復使用。");
}

async function confirmKnowledge(item: KnowledgeRecord): Promise<void> {
  if (!(await patchKnowledge(item, { confirm: true }))) return;
  useToast().showToast("已確認這筆 Knowledge 仍然有效。");
}

async function openKnowledgeHistory(item: KnowledgeRecord): Promise<void> {
  const project = knowledgeProject(item);
  if (!project) {
    useToast().showToast("找不到這筆 Knowledge 所屬的 tracked project。");
    return;
  }
  knowledgeHistoryItem.value = item;
  await useKnowledgeStore().loadKnowledgeHistory(item.id, project.rootPath);
}

function closeKnowledgeHistory(): void {
  knowledgeHistoryItem.value = null;
  useKnowledgeStore().closeKnowledgeHistory();
}

function knowledgeAuditFields(entry: KnowledgeAuditRecord): string {
  const labels: Record<string, string> = {
    kind: "類型",
    title: "標題",
    body: "內容",
    tags: "標籤",
    references: "參考資料",
    status: "狀態",
    appliesTo: "適用路徑",
    lastConfirmedAt: "確認有效",
    review: "檢視標記",
    supersedesId: "取代的 Knowledge",
  };
  const fields = entry.changedFields.map((field) => labels[field] ?? field);
  return fields.length ? fields.join("、") : "狀態快照";
}

function openKnowledgeSession(item: KnowledgeRecord): Promise<void> {
  return useSessionDetail().openSessionDetail(item.sessionId, "無法載入 Knowledge 的來源 Session。");
}

function openKnowledgeStaleSession(item: KnowledgeRecord): Promise<void> {
  return useSessionDetail().openSessionDetail(item.possiblyStale?.sessionId, "無法載入改動檔案的 Session。");
}

export function useKnowledge() {
  const store = useKnowledgeStore();
  const {
    knowledgeItems,
    knowledgeProjects,
    knowledgePage,
    knowledgePageSize,
    knowledgePageInfo,
    knowledgeQuery,
    knowledgeKind,
    knowledgeProjectId,
    knowledgeStatus,
    knowledgeLoading,
    knowledgeError,
    knowledgeHistory,
    knowledgeHistoryLoading,
    knowledgeHistoryError,
  } = storeToRefs(store);

  return {
    knowledgeItems,
    knowledgeProjects,
    knowledgePage,
    knowledgePageSize,
    knowledgePageInfo,
    knowledgeQuery,
    knowledgeKind,
    knowledgeProjectId,
    knowledgeStatus,
    knowledgeLoading,
    knowledgeError,
    loadKnowledge: store.loadKnowledge,
    setKnowledgeStatus,
    openKnowledgeSession,
    knowledgeEditor,
    knowledgeEditorForm,
    knowledgeEditorSaving,
    knowledgeEditorError,
    openKnowledgeEditor,
    closeKnowledgeEditor,
    saveKnowledge,
    knowledgeHistoryItem,
    knowledgeHistory,
    knowledgeHistoryLoading,
    knowledgeHistoryError,
    openKnowledgeHistory,
    confirmKnowledge,
    openKnowledgeStaleSession,
    closeKnowledgeHistory,
    knowledgeAuditFields,
  };
}
