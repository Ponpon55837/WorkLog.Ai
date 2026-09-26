import { ref } from "vue";
import { storeToRefs } from "pinia";
import type {
  DecideKnowledgeCandidateInput,
  KnowledgeCandidate,
  KnowledgeKind,
  ProjectRecord,
} from "@work-intelligence/core";
import { useKnowledgeStore } from "../stores/knowledge";
import { errorMessage } from "../utils/format";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

type CandidateForm = { kind: KnowledgeKind; title: string; body: string; tags: string; appliesTo: string };

const candidateEditor = ref<KnowledgeCandidate | null>(null);
const candidateForm = ref<CandidateForm>({ kind: "pattern", title: "", body: "", tags: "", appliesTo: "" });
const candidateSaving = ref(false);
const candidateError = ref("");

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
          ? `${project.name} 已有整理請求在等待 Agent。`
          : `已建立 ${project.name} 的整理請求（${result.request.sourceSessionIds.length} 筆 Session），請 Agent「整理 Knowledge 候選」。`,
      );
    }
  } catch (error) {
    showToast(errorMessage(error, "無法建立整理請求。"), "danger");
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
      showToast("這筆候選已經處理過了。");
    } else if (result.outcome !== "knowledge_candidate_decided") {
      showToast(result.outcome === "skipped" ? result.reason : "找不到這筆候選。", "danger");
      return false;
    } else {
      showToast(decision === "accept" ? "已加入 Knowledge。" : "已拒絕這筆候選。");
    }
  } catch (error) {
    showToast(errorMessage(error, "無法處理這筆候選。"), "danger");
    return false;
  }
  return true;
}

function acceptCandidate(candidate: KnowledgeCandidate, refreshProjectRoot?: string): Promise<boolean> {
  return decide(candidate, "accept", refreshProjectRoot);
}

async function rejectCandidate(candidate: KnowledgeCandidate, refreshProjectRoot?: string): Promise<void> {
  const confirmed = await confirmAction({
    title: "拒絕這筆候選？",
    message: `「${candidate.title}」不會成為 Knowledge；之後的整理請求也不會再用同一筆 Session 產生候選。`,
    confirmLabel: "拒絕",
    danger: true,
  });
  if (confirmed) await decide(candidate, "reject", refreshProjectRoot);
}

function openCandidateEditor(candidate: KnowledgeCandidate): void {
  candidateEditor.value = candidate;
  candidateForm.value = {
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.body,
    tags: candidate.tags.join(", "),
    appliesTo: candidate.appliesTo.join("\n"),
  };
  candidateError.value = "";
}

function closeCandidateEditor(): void {
  if (!candidateSaving.value) candidateEditor.value = null;
}

/** Accepts the candidate with the reviewer's edits. */
async function saveCandidateEditor(refreshProjectRoot?: string): Promise<void> {
  const candidate = candidateEditor.value;
  const form = candidateForm.value;
  if (!candidate) return;
  if (!form.title.trim() || !form.body.trim()) {
    candidateError.value = "標題與內容不能留白。";
    return;
  }
  candidateSaving.value = true;
  const accepted = await decide(candidate, "accept", refreshProjectRoot, {
    kind: form.kind,
    title: form.title.trim(),
    body: form.body.trim(),
    tags: splitValues(form.tags),
    appliesTo: splitValues(form.appliesTo),
  });
  candidateSaving.value = false;
  if (accepted) candidateEditor.value = null;
}

function loadCandidates(projectRoot?: string): Promise<void> {
  return useKnowledgeStore().loadCandidates(projectRoot);
}

/** Re-checks without the loading indicator, while an Agent is working on a request. */
function refreshCandidates(projectRoot?: string): Promise<void> {
  return useKnowledgeStore().loadCandidates(projectRoot, true);
}

export function useKnowledgeCandidates() {
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
