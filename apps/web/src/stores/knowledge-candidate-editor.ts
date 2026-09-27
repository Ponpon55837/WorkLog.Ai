import { defineStore } from "pinia";
import { ref } from "vue";
import type { KnowledgeCandidate, KnowledgeKind } from "@work-intelligence/core";

export type CandidateForm = { kind: KnowledgeKind; title: string; body: string; tags: string; appliesTo: string };

/** The "edit before accepting" dialog for a Knowledge candidate: the candidate and its draft. */
export const useKnowledgeCandidateEditorStore = defineStore("knowledge-candidate-editor", () => {
  const candidateEditor = ref<KnowledgeCandidate | null>(null);
  const candidateForm = ref<CandidateForm>({ kind: "pattern", title: "", body: "", tags: "", appliesTo: "" });
  const candidateSaving = ref(false);
  const candidateError = ref("");

  function $reset(): void {
    candidateEditor.value = null;
    candidateForm.value = { kind: "pattern", title: "", body: "", tags: "", appliesTo: "" };
    candidateSaving.value = false;
    candidateError.value = "";
  }

  return { candidateEditor, candidateForm, candidateSaving, candidateError, $reset };
});
