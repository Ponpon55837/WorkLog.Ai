import { storeToRefs } from "pinia";
import type { DecideKnowledgeCandidateInput, KnowledgeCandidate, ProjectRecord } from "@work-intelligence/core";
import { useKnowledgeStore } from "../stores/knowledge";
import { useKnowledgeCandidateEditorStore } from "../stores/knowledge-candidate-editor";
import { errorMessage } from "../utils/format";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";
import { t } from "../i18n";

function splitValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function requestCandidates(project: ProjectRecord, refreshProjectRoot?: string): Promise<void> {
  const { showToast } = useToast();
  try {
    const result = await useKnowledgeStore().requestKnowledgeCandidates(project.rootPath, refreshProjectRoot);
    if (result.outcome === "knowledge_candidates_not_needed") {
      showToast(result.reason);
    } else if (result.outcome === "skipped") {
      showToast(result.reason, "danger");
    } else {
      showToast(
        result.duplicate
          ? t("knowledge.alreadyHasARequestWaiting", { name: project.name })
          : t("knowledge.createdASynthesisRequestFor", {
              name: project.name,
              length: result.request.sourceSessionIds.length,
            }),
      );
    }
  } catch (error) {
    showToast(errorMessage(error, t("common.couldNotCreateTheRequest")), "danger");
  }
}

async function decide(
  candidate: KnowledgeCandidate,
  decision: "accept" | "reject",
  refreshProjectRoot?: string,
  edits?: DecideKnowledgeCandidateInput["edits"],
): Promise<boolean> {
  const { showToast } = useToast();
  try {
    const result = await useKnowledgeStore().decideKnowledgeCandidate(
      { candidateId: candidate.id, decision, edits },
      refreshProjectRoot,
    );
    if (result.outcome === "already_decided") {
      showToast(t("knowledge.thisCandidateHasAlreadyBeen"));
    } else if (result.outcome !== "knowledge_candidate_decided") {
      showToast(result.outcome === "skipped" ? result.reason : t("knowledge.candidateNotFound"), "danger");
      return false;
    } else {
      showToast(decision === "accept" ? t("knowledge.addedToKnowledge") : t("knowledge.candidateRejected"));
    }
  } catch (error) {
    showToast(errorMessage(error, t("knowledge.couldNotHandleThisCandidate")), "danger");
    return false;
  }
  return true;
}

function acceptCandidate(candidate: KnowledgeCandidate, refreshProjectRoot?: string): Promise<boolean> {
  return decide(candidate, "accept", refreshProjectRoot);
}

async function rejectCandidate(candidate: KnowledgeCandidate, refreshProjectRoot?: string): Promise<void> {
  const confirmed = await confirmAction({
    title: t("knowledge.rejectThisCandidate"),
    message: t("knowledge.willNotBecomeKnowledgeAnd", {
      title: candidate.title,
    }),
    confirmLabel: t("knowledge.reject"),
    danger: true,
  });
  if (confirmed) await decide(candidate, "reject", refreshProjectRoot);
}

function openCandidateEditor(candidate: KnowledgeCandidate): void {
  useKnowledgeCandidateEditorStore().candidateEditor = candidate;
  useKnowledgeCandidateEditorStore().candidateForm = {
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.body,
    tags: candidate.tags.join(", "),
    appliesTo: candidate.appliesTo.join("\n"),
  };
  useKnowledgeCandidateEditorStore().candidateError = "";
}

function closeCandidateEditor(): void {
  if (!useKnowledgeCandidateEditorStore().candidateSaving) useKnowledgeCandidateEditorStore().candidateEditor = null;
}

/** Accepts the candidate with the reviewer's edits. */
async function saveCandidateEditor(refreshProjectRoot?: string): Promise<void> {
  const candidate = useKnowledgeCandidateEditorStore().candidateEditor;
  const form = useKnowledgeCandidateEditorStore().candidateForm;
  if (!candidate) return;
  if (!form.title.trim() || !form.body.trim()) {
    useKnowledgeCandidateEditorStore().candidateError = t("knowledge.titleAndBodyCannotBe");
    return;
  }
  useKnowledgeCandidateEditorStore().candidateSaving = true;
  const accepted = await decide(candidate, "accept", refreshProjectRoot, {
    kind: form.kind,
    title: form.title.trim(),
    body: form.body.trim(),
    tags: splitValues(form.tags),
    appliesTo: splitValues(form.appliesTo),
  });
  useKnowledgeCandidateEditorStore().candidateSaving = false;
  if (accepted) useKnowledgeCandidateEditorStore().candidateEditor = null;
}

function loadCandidates(projectRoot?: string): Promise<void> {
  return useKnowledgeStore().loadCandidates(projectRoot);
}

/** Re-checks without the loading indicator, while an Agent is working on a request. */
function refreshCandidates(projectRoot?: string): Promise<void> {
  return useKnowledgeStore().loadCandidates(projectRoot, true);
}

export function useKnowledgeCandidates() {
  const { candidateEditor, candidateForm, candidateSaving, candidateError } = storeToRefs(
    useKnowledgeCandidateEditorStore(),
  );
  const { candidates, openCandidateRequests, candidatesLoading, candidatesError } = storeToRefs(useKnowledgeStore());

  return {
    candidates,
    openCandidateRequests,
    candidatesLoading,
    candidatesError,
    candidateEditor,
    candidateForm,
    candidateSaving,
    candidateError,
    loadCandidates,
    refreshCandidates,
    requestCandidates,
    acceptCandidate,
    rejectCandidate,
    openCandidateEditor,
    closeCandidateEditor,
    saveCandidateEditor,
  };
}
