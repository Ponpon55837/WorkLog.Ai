import { storeToRefs } from "pinia";
import type {
  KnowledgeAuditRecord,
  KnowledgeRecord,
  KnowledgeStatus,
  ProjectRecord,
  SessionDecisionRecord,
} from "@work-intelligence/core";
import { useKnowledgeStore, type KnowledgeChanges } from "../stores/knowledge";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { useKnowledgeEditorStore } from "../stores/knowledge-editor";
import { errorMessage } from "../utils/format";
import { useToast } from "./useToast";
import { t } from "../i18n";

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
    showToast(t("找不到這筆 Knowledge 所屬的 tracked project。"));
    return false;
  }
  try {
    const result = await useKnowledgeStore().updateKnowledge({
      knowledgeId: item.id,
      projectRoot: project.rootPath,
      ...changes,
    });
    if (result.outcome !== "knowledge_updated") {
      showToast(result.outcome === "skipped" ? result.reason : t("Knowledge 已不存在。"));
      return false;
    }
    return true;
  } catch (error) {
    showToast(errorMessage(error, t("更新 Knowledge 失敗。")));
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
  useKnowledgeEditorStore().knowledgeEditor = item;
  useKnowledgeEditorStore().knowledgeEditorProject = knowledgeProject(item) ?? null;
  useKnowledgeEditorStore().knowledgeEditorCreating = false;
  useKnowledgeEditorStore().agentDecisionDraft = null;
  useKnowledgeEditorStore().knowledgeEditorForm = {
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags.join(", "),
    references: item.references.join("\n"),
    appliesTo: item.appliesTo.join("\n"),
    status: item.status,
  };
  useKnowledgeEditorStore().knowledgeEditorError = "";
}

function openAgentDecisionEditor(item: SessionDecisionRecord, project: ProjectRecord): void {
  useKnowledgeEditorStore().knowledgeEditor = null;
  useKnowledgeEditorStore().knowledgeEditorProject = project;
  useKnowledgeEditorStore().knowledgeEditorCreating = true;
  useKnowledgeEditorStore().agentDecisionDraft = { decision: item, project, idempotencyKey: crypto.randomUUID() };
  useKnowledgeEditorStore().knowledgeEditorForm = {
    kind: "decision",
    title: t("決策：{value}", { value: item.text.slice(0, 72) }),
    body: item.text,
    tags: "agent-decision",
    references: "",
    appliesTo: "",
    status: "active",
  };
  useKnowledgeEditorStore().knowledgeEditorError = "";
}

function closeKnowledgeEditor(): void {
  if (useKnowledgeEditorStore().knowledgeEditorSaving) return;
  useKnowledgeEditorStore().knowledgeEditor = null;
  useKnowledgeEditorStore().knowledgeEditorProject = null;
  useKnowledgeEditorStore().knowledgeEditorCreating = false;
  useKnowledgeEditorStore().agentDecisionDraft = null;
  useKnowledgeEditorStore().knowledgeEditorError = "";
}

async function saveKnowledge(): Promise<void> {
  const item = useKnowledgeEditorStore().knowledgeEditor;
  const creating = useKnowledgeEditorStore().knowledgeEditorCreating;
  const draft = useKnowledgeEditorStore().agentDecisionDraft;
  if (!item && !creating) return;
  const form = useKnowledgeEditorStore().knowledgeEditorForm;
  if (!form.title.trim() || !form.body.trim()) {
    useKnowledgeEditorStore().knowledgeEditorError = t("標題與內容不能留白。");
    return;
  }
  useKnowledgeEditorStore().knowledgeEditorSaving = true;
  useKnowledgeEditorStore().knowledgeEditorError = "";
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
          useKnowledgeEditorStore().knowledgeEditorError =
            recorded.outcome === "skipped" ? recorded.reason : t("來源 Session 已不存在。");
          return;
        }
        knowledgeId = recorded.knowledge.id;
        useKnowledgeEditorStore().agentDecisionDraft = { ...draft, knowledgeId };
      }
      const reviewed = await useSessionDecisionsStore().reviewDecision({
        decisionId: draft.decision.id,
        projectRoot: draft.project.rootPath,
        reviewStatus: "promoted",
        knowledgeId,
      });
      if (reviewed.outcome !== "session_decision_reviewed") {
        useKnowledgeEditorStore().knowledgeEditorError = t("Knowledge 已建立，但決策連結未完成；請重試以完成連結。");
        return;
      }
      useToast().showToast(t("已建立 Knowledge 並連結來源 Session。"));
      useKnowledgeEditorStore().knowledgeEditorSaving = false;
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
      useToast().showToast(form.status === "archived" ? t("Knowledge 已更新並封存。") : t("Knowledge 已更新。"));
      useKnowledgeEditorStore().knowledgeEditorSaving = false;
      closeKnowledgeEditor();
    }
  } catch (error) {
    useKnowledgeEditorStore().knowledgeEditorError = errorMessage(
      error,
      creating ? t("建立 Knowledge 失敗。") : t("更新 Knowledge 失敗。"),
    );
  } finally {
    useKnowledgeEditorStore().knowledgeEditorSaving = false;
  }
}

async function setKnowledgeStatus(item: KnowledgeRecord, status: KnowledgeStatus): Promise<void> {
  if (!(await patchKnowledge(item, { status }))) return;
  useToast().showToast(status === "archived" ? t("Knowledge 已封存。") : t("Knowledge 已恢復使用。"));
}

async function confirmKnowledge(item: KnowledgeRecord): Promise<void> {
  if (!(await patchKnowledge(item, { confirm: true }))) return;
  useToast().showToast(t("已確認這筆 Knowledge 仍然有效。"));
}

async function openKnowledgeHistory(item: KnowledgeRecord): Promise<void> {
  const project = knowledgeProject(item);
  if (!project) {
    useToast().showToast(t("找不到這筆 Knowledge 所屬的 tracked project。"));
    return;
  }
  useKnowledgeEditorStore().knowledgeHistoryItem = item;
  await useKnowledgeStore().loadKnowledgeHistory(item.id, project.rootPath);
}

function closeKnowledgeHistory(): void {
  useKnowledgeEditorStore().knowledgeHistoryItem = null;
  useKnowledgeStore().closeKnowledgeHistory();
}

function knowledgeAuditFields(entry: KnowledgeAuditRecord): string {
  const labels: Record<string, string> = {
    kind: t("類型"),
    title: t("標題"),
    body: t("內容"),
    tags: t("標籤"),
    references: t("參考資料"),
    status: t("狀態"),
    appliesTo: t("適用路徑"),
    lastConfirmedAt: t("確認有效"),
    review: t("檢視標記"),
    supersedesId: t("取代的 Knowledge"),
  };
  const fields = entry.changedFields.map((field) => labels[field] ?? field);
  return fields.length ? fields.join(t("、")) : t("狀態快照");
}

function openKnowledgeSession(item: KnowledgeRecord): Promise<void> {
  return useSessionsStore().openSessionDetail(item.sessionId, t("無法載入 Knowledge 的來源 Session。"));
}

function openKnowledgeStaleSession(item: KnowledgeRecord): Promise<void> {
  return useSessionsStore().openSessionDetail(item.possiblyStale?.sessionId, t("無法載入改動檔案的 Session。"));
}

/** Owns Knowledge UI workflows that span stores, dialogs, and Session navigation. */
export function useKnowledgeActions() {
  const {
    knowledgeEditor,
    knowledgeEditorForm,
    knowledgeEditorSaving,
    knowledgeEditorError,
    knowledgeEditorProject,
    knowledgeEditorCreating,
    agentDecisionDraft,
    knowledgeEditorOpen,
    knowledgeHistoryItem,
  } = storeToRefs(useKnowledgeEditorStore());
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
