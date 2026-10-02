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
    showToast(t("knowledge.knowledgeProjectNotFound"));
    return false;
  }
  try {
    const result = await useKnowledgeStore().updateKnowledge({
      knowledgeId: item.id,
      projectRoot: project.rootPath,
      ...changes,
    });
    if (result.outcome !== "knowledge_updated") {
      showToast(result.outcome === "skipped" ? result.reason : t("knowledge.thisKnowledgeNoLongerExists"));
      return false;
    }
    return true;
  } catch (error) {
    showToast(errorMessage(error, t("knowledge.couldNotUpdateKnowledge")));
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
    title: t("knowledge.decision", { value: item.text.slice(0, 72) }),
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
    useKnowledgeEditorStore().knowledgeEditorError = t("knowledge.titleAndBodyCannotBe");
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
            recorded.outcome === "skipped" ? recorded.reason : t("knowledge.theSourceSessionNoLonger");
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
        useKnowledgeEditorStore().knowledgeEditorError = t("knowledge.knowledgeWasCreatedButThe");
        return;
      }
      useToast().showToast(t("knowledge.knowledgeCreatedAndLinkedTo"));
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
      useToast().showToast(
        form.status === "archived" ? t("knowledge.knowledgeUpdatedAndArchived") : t("knowledge.knowledgeUpdated"),
      );
      useKnowledgeEditorStore().knowledgeEditorSaving = false;
      closeKnowledgeEditor();
    }
  } catch (error) {
    useKnowledgeEditorStore().knowledgeEditorError = errorMessage(
      error,
      creating ? t("knowledge.couldNotCreateKnowledge") : t("knowledge.couldNotUpdateKnowledge"),
    );
  } finally {
    useKnowledgeEditorStore().knowledgeEditorSaving = false;
  }
}

async function setKnowledgeStatus(item: KnowledgeRecord, status: KnowledgeStatus): Promise<void> {
  if (!(await patchKnowledge(item, { status }))) return;
  useToast().showToast(status === "archived" ? t("knowledge.knowledgeArchived") : t("knowledge.knowledgeRestored"));
}

async function confirmKnowledge(item: KnowledgeRecord): Promise<void> {
  if (!(await patchKnowledge(item, { confirm: true }))) return;
  useToast().showToast(t("knowledge.confirmedThatThisKnowledgeStill"));
}

async function openKnowledgeHistory(item: KnowledgeRecord): Promise<void> {
  const project = knowledgeProject(item);
  if (!project) {
    useToast().showToast(t("knowledge.knowledgeProjectNotFound"));
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
    kind: t("common.kind"),
    title: t("knowledge.title"),
    body: t("common.body"),
    tags: t("knowledge.tags"),
    references: t("knowledge.references"),
    status: t("common.status"),
    appliesTo: t("knowledge.appliesToPaths"),
    lastConfirmedAt: t("knowledge.confirmedValid"),
    review: t("knowledge.reviewMarker"),
    supersedesId: t("knowledge.supersededKnowledge"),
  };
  const fields = entry.changedFields.map((field) => labels[field] ?? field);
  return fields.length ? fields.join(t("common.listSeparator")) : t("knowledge.statusSnapshot");
}

function openKnowledgeSession(item: KnowledgeRecord): Promise<void> {
  return useSessionsStore().openSessionDetail(item.sessionId, t("knowledge.couldNotLoadTheSource"));
}

function openKnowledgeStaleSession(item: KnowledgeRecord): Promise<void> {
  return useSessionsStore().openSessionDetail(item.possiblyStale?.sessionId, t("knowledge.couldNotLoadTheSession"));
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
