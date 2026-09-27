import { computed, ref } from "vue";
import type {
  KnowledgeAuditRecord,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeStatus,
  ProjectRecord,
  SessionDecisionRecord,
} from "@work-intelligence/core";
import { useKnowledgeStore, type KnowledgeChanges } from "../stores/knowledge";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { errorMessage } from "../utils/format";
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
const knowledgeEditorProject = ref<ProjectRecord | null>(null);
const knowledgeEditorCreating = ref(false);
const agentDecisionDraft = ref<{
  decision: SessionDecisionRecord;
  project: ProjectRecord;
  idempotencyKey: string;
  knowledgeId?: string;
} | null>(null);
const knowledgeEditorOpen = computed(() => Boolean(knowledgeEditor.value || knowledgeEditorCreating.value));
const knowledgeHistoryItem = ref<KnowledgeRecord | null>(null);

function knowledgeProject(item: KnowledgeRecord): ProjectRecord | undefined {
  return (
    useProjectsStore().projects.find((project) => project.id === item.projectId) ??
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
  knowledgeEditorProject.value = knowledgeProject(item) ?? null;
  knowledgeEditorCreating.value = false;
  agentDecisionDraft.value = null;
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

function openAgentDecisionEditor(item: SessionDecisionRecord, project: ProjectRecord): void {
  knowledgeEditor.value = null;
  knowledgeEditorProject.value = project;
  knowledgeEditorCreating.value = true;
  agentDecisionDraft.value = { decision: item, project, idempotencyKey: crypto.randomUUID() };
  knowledgeEditorForm.value = {
    kind: "decision",
    title: `決策：${item.text.slice(0, 72)}`,
    body: item.text,
    tags: "agent-decision",
    references: "",
    appliesTo: "",
    status: "active",
  };
  knowledgeEditorError.value = "";
}

function closeKnowledgeEditor(): void {
  if (knowledgeEditorSaving.value) return;
  knowledgeEditor.value = null;
  knowledgeEditorProject.value = null;
  knowledgeEditorCreating.value = false;
  agentDecisionDraft.value = null;
  knowledgeEditorError.value = "";
}

async function saveKnowledge(): Promise<void> {
  const item = knowledgeEditor.value;
  const creating = knowledgeEditorCreating.value;
  const draft = agentDecisionDraft.value;
  if (!item && !creating) return;
  const form = knowledgeEditorForm.value;
  if (!form.title.trim() || !form.body.trim()) {
    knowledgeEditorError.value = "標題與內容不能留白。";
    return;
  }
  knowledgeEditorSaving.value = true;
  knowledgeEditorError.value = "";
  try {
    if (creating && draft) {
      let knowledgeId = draft.knowledgeId;
      if (!knowledgeId) {
        const recorded = await useKnowledgeStore().recordKnowledge({
          projectRoot: draft.project.rootPath,
          idempotencyKey: draft.idempotencyKey,
          sessionId: draft.decision.sessionId,
          kind: form.kind,
          title: form.title.trim(),
          body: form.body.trim(),
          tags: splitKnowledgeValues(form.tags),
          references: splitKnowledgeValues(form.references),
          appliesTo: splitKnowledgeValues(form.appliesTo),
        });
        if (recorded.outcome !== "knowledge_recorded") {
          knowledgeEditorError.value = recorded.outcome === "skipped" ? recorded.reason : "來源 Session 已不存在。";
          return;
        }
        knowledgeId = recorded.knowledge.id;
        agentDecisionDraft.value = { ...draft, knowledgeId };
      }
      const reviewed = await useSessionDecisionsStore().reviewDecision({
        decisionId: draft.decision.id,
        projectRoot: draft.project.rootPath,
        reviewStatus: "promoted",
        knowledgeId,
      });
      if (reviewed.outcome !== "session_decision_reviewed") {
        knowledgeEditorError.value = "Knowledge 已建立，但決策連結未完成；請重試以完成連結。";
        return;
      }
      useToast().showToast("已建立 Knowledge 並連結來源 Session。");
      knowledgeEditorSaving.value = false;
      closeKnowledgeEditor();
      return;
    }

    if (!item) return;
    const saved = await patchKnowledge(item, {
      kind: form.kind,
      title: form.title.trim(),
      body: form.body.trim(),
      tags: splitKnowledgeValues(form.tags),
      references: splitKnowledgeValues(form.references),
      appliesTo: splitKnowledgeValues(form.appliesTo),
      status: form.status,
    });
    if (saved) {
      useToast().showToast(form.status === "archived" ? "Knowledge 已更新並封存。" : "Knowledge 已更新。");
      knowledgeEditorSaving.value = false;
      closeKnowledgeEditor();
    }
  } catch (error) {
    knowledgeEditorError.value = errorMessage(error, creating ? "建立 Knowledge 失敗。" : "更新 Knowledge 失敗。");
  } finally {
    knowledgeEditorSaving.value = false;
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
  return useSessionsStore().openSessionDetail(item.sessionId, "無法載入 Knowledge 的來源 Session。");
}

function openKnowledgeStaleSession(item: KnowledgeRecord): Promise<void> {
  return useSessionsStore().openSessionDetail(item.possiblyStale?.sessionId, "無法載入改動檔案的 Session。");
}

/** Owns Knowledge UI workflows that span stores, dialogs, and Session navigation. */
export function useKnowledgeActions() {
  return {
    setKnowledgeStatus,
    openKnowledgeSession,
    knowledgeEditor,
    knowledgeEditorOpen,
    knowledgeEditorCreating,
    knowledgeEditorProject,
    agentDecisionDraft,
    knowledgeEditorForm,
    knowledgeEditorSaving,
    knowledgeEditorError,
    openKnowledgeEditor,
    openAgentDecisionEditor,
    closeKnowledgeEditor,
    saveKnowledge,
    knowledgeHistoryItem,
    openKnowledgeHistory,
    confirmKnowledge,
    openKnowledgeStaleSession,
    closeKnowledgeHistory,
    knowledgeAuditFields,
  };
}
