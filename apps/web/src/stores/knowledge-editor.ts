import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeStatus,
  ProjectRecord,
  SessionDecisionRecord,
} from "@work-intelligence/core";

export interface KnowledgeEditorForm {
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string;
  references: string;
  appliesTo: string;
  status: KnowledgeStatus;
}

export interface AgentDecisionDraft {
  decision: SessionDecisionRecord;
  project: ProjectRecord;
  idempotencyKey: string;
  knowledgeId?: string;
}

function emptyForm(): KnowledgeEditorForm {
  return { kind: "pattern", title: "", body: "", tags: "", references: "", appliesTo: "", status: "active" };
}

/** The Knowledge editor and history dialogs: which record is open and the form being edited. */
export const useKnowledgeEditorStore = defineStore("knowledge-editor", () => {
  const knowledgeEditor = ref<KnowledgeRecord | null>(null);
  const knowledgeEditorForm = ref<KnowledgeEditorForm>(emptyForm());
  const knowledgeEditorSaving = ref(false);
  const knowledgeEditorError = ref("");
  const knowledgeEditorProject = ref<ProjectRecord | null>(null);
  const knowledgeEditorCreating = ref(false);
  const agentDecisionDraft = ref<AgentDecisionDraft | null>(null);
  const knowledgeHistoryItem = ref<KnowledgeRecord | null>(null);

  const knowledgeEditorOpen = computed(() => Boolean(knowledgeEditor.value || knowledgeEditorCreating.value));

  function $reset(): void {
    knowledgeEditor.value = null;
    knowledgeEditorForm.value = emptyForm();
    knowledgeEditorSaving.value = false;
    knowledgeEditorError.value = "";
    knowledgeEditorProject.value = null;
    knowledgeEditorCreating.value = false;
    agentDecisionDraft.value = null;
    knowledgeHistoryItem.value = null;
  }

  return {
    knowledgeEditor,
    knowledgeEditorForm,
    knowledgeEditorSaving,
    knowledgeEditorError,
    knowledgeEditorProject,
    knowledgeEditorCreating,
    agentDecisionDraft,
    knowledgeHistoryItem,
    knowledgeEditorOpen,
    $reset,
  };
});
