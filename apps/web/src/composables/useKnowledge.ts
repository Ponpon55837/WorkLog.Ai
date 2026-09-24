import { ref } from "vue";
import type {
  KnowledgeAuditRecord,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeStatus,
  PageInfo,
  ProjectRecord,
} from "@work-intelligence/core";
import { pageSizeToQuery, type ListPageSize } from "../utils/labels";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useProjects } from "./useProjects";
import { emptyPageInfo } from "./useSessions";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

type KnowledgeChanges = Partial<Pick<KnowledgeRecord, "kind" | "title" | "body" | "tags" | "references" | "status">>;

const knowledgeItems = ref<KnowledgeRecord[]>([]);
const knowledgeProjects = ref<ProjectRecord[]>([]);
const knowledgePage = ref(1);
const knowledgePageSize = ref<ListPageSize>(10);
const knowledgePageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const knowledgeQuery = ref("");
const knowledgeKind = ref<KnowledgeKind | "">("");
const knowledgeProjectId = ref("");
const knowledgeStatus = ref<KnowledgeStatus>("active");
const knowledgeLoading = ref(false);
const knowledgeError = ref("");

const knowledgeEditor = ref<KnowledgeRecord | null>(null);
const knowledgeEditorForm = ref({
  kind: "pattern" as KnowledgeKind,
  title: "",
  body: "",
  tags: "",
  references: "",
  status: "active" as KnowledgeStatus,
});
const knowledgeEditorSaving = ref(false);
const knowledgeEditorError = ref("");

const knowledgeHistoryItem = ref<KnowledgeRecord | null>(null);
const knowledgeHistory = ref<KnowledgeAuditRecord[]>([]);
const knowledgeHistoryLoading = ref(false);
const knowledgeHistoryError = ref("");

function resetKnowledgeList(): void {
  knowledgeItems.value = [];
  knowledgeProjects.value = [];
  knowledgePageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(knowledgePageSize.value) };
}

async function loadKnowledge(): Promise<void> {
  knowledgeLoading.value = true;
  knowledgeError.value = "";
  await runKeyed(
    "knowledge",
    async (signal) => {
      const result = await useApi().client.searchKnowledge(
        {
          q: knowledgeQuery.value.trim() || undefined,
          kind: knowledgeKind.value || undefined,
          projectId: knowledgeProjectId.value || undefined,
          status: knowledgeStatus.value,
          page: knowledgePage.value,
          pageSize: knowledgePageSize.value,
        },
        signal,
      );
      if (result.outcome === "knowledge") {
        knowledgeItems.value = result.items;
        knowledgeProjects.value = result.projects;
        if (knowledgePage.value !== result.pageInfo.page) {
          knowledgePage.value = result.pageInfo.page;
        }
        knowledgePageInfo.value = result.pageInfo;
      } else {
        resetKnowledgeList();
        knowledgeError.value = result.reason;
      }
    },
    {
      onError: (error) => {
        resetKnowledgeList();
        knowledgeError.value = errorMessage(error, "無法載入 Knowledge。");
      },
      onSettled: () => {
        knowledgeLoading.value = false;
      },
    },
  );
}

function knowledgeProject(item: KnowledgeRecord): ProjectRecord | undefined {
  return (
    useProjects().projects.value.find((project) => project.id === item.projectId) ??
    knowledgeProjects.value.find((project) => project.id === item.projectId)
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
    const result = await useApi().client.updateKnowledge(item.id, { projectRoot: project.rootPath, ...changes });
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
    status: item.status,
  };
  knowledgeEditorError.value = "";
}

function closeKnowledgeEditor(): void {
  if (knowledgeEditorSaving.value) {
    return;
  }
  knowledgeEditor.value = null;
  knowledgeEditorError.value = "";
}

async function saveKnowledge(): Promise<void> {
  const item = knowledgeEditor.value;
  if (!item) {
    return;
  }
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
    status: form.status,
  });
  knowledgeEditorSaving.value = false;
  if (saved) {
    useToast().showToast(form.status === "archived" ? "Knowledge 已更新並封存。" : "Knowledge 已更新。");
    closeKnowledgeEditor();
    await loadKnowledge();
  }
}

async function setKnowledgeStatus(item: KnowledgeRecord, status: KnowledgeStatus): Promise<void> {
  if (!(await patchKnowledge(item, { status }))) {
    return;
  }
  useToast().showToast(status === "archived" ? "Knowledge 已封存。" : "Knowledge 已恢復使用。");
  await loadKnowledge();
}

async function openKnowledgeHistory(item: KnowledgeRecord): Promise<void> {
  const project = knowledgeProject(item);
  if (!project) {
    useToast().showToast("找不到這筆 Knowledge 所屬的 tracked project。");
    return;
  }
  knowledgeHistoryItem.value = item;
  knowledgeHistory.value = [];
  knowledgeHistoryError.value = "";
  knowledgeHistoryLoading.value = true;
  await runKeyed(
    "knowledge-history",
    async (signal) => {
      const result = await useApi().client.getKnowledgeHistory(
        item.id,
        { projectRoot: project.rootPath, limit: 100 },
        signal,
      );
      if (result.outcome === "knowledge_history") {
        knowledgeHistory.value = result.history;
      } else if (result.outcome === "skipped") {
        knowledgeHistoryError.value = result.reason;
      } else {
        knowledgeHistoryError.value = "這筆 Knowledge 已不存在。";
      }
    },
    {
      onError: (error) => {
        knowledgeHistoryError.value = errorMessage(error, "無法載入 Knowledge 變更紀錄。");
      },
      onSettled: () => {
        knowledgeHistoryLoading.value = false;
      },
    },
  );
}

function closeKnowledgeHistory(): void {
  knowledgeHistoryItem.value = null;
  knowledgeHistory.value = [];
  knowledgeHistoryError.value = "";
}

function knowledgeAuditFields(entry: KnowledgeAuditRecord): string {
  const labels: Record<string, string> = {
    kind: "類型",
    title: "標題",
    body: "內容",
    tags: "標籤",
    references: "參考資料",
    status: "狀態",
  };
  const fields = entry.changedFields.map((field) => labels[field] ?? field);
  return fields.length ? fields.join("、") : "狀態快照";
}

function openKnowledgeSession(item: KnowledgeRecord): Promise<void> {
  return useSessionDetail().openSessionDetail(item.sessionId, "無法載入 Knowledge 的來源 Session。");
}

export function useKnowledge() {
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
    loadKnowledge,
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
    closeKnowledgeHistory,
    knowledgeAuditFields,
  };
}
