import { ref } from "vue";
import type {
  DecideKnowledgeCandidateInput,
  KnowledgeCandidate,
  KnowledgeCandidateRequest,
  KnowledgeKind,
  ProjectRecord,
} from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { confirmAction } from "./useConfirm";
import { useKnowledge } from "./useKnowledge";
import { useToast } from "./useToast";

type CandidateForm = { kind: KnowledgeKind; title: string; body: string; tags: string; appliesTo: string };

const candidates = ref<KnowledgeCandidate[]>([]);
const openCandidateRequests = ref<KnowledgeCandidateRequest[]>([]);
const candidatesLoading = ref(false);
const candidatesError = ref("");
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

/** Proposed candidates and open requests, optionally limited to one project's root. */
async function fetchCandidates(projectRoot?: string, quiet = false): Promise<void> {
  if (!quiet) {
    candidatesLoading.value = true;
  }
  await runKeyed(
    "knowledge-candidates",
    async (signal) => {
      const result = await useApi().client.listKnowledgeCandidates(projectRoot, signal);
      if (result.outcome === "knowledge_candidates") {
        candidates.value = result.items;
        openCandidateRequests.value = result.openRequests;
        candidatesError.value = "";
      } else {
        candidates.value = [];
        openCandidateRequests.value = [];
      }
    },
    {
      onError: (error) => {
        candidatesError.value = errorMessage(error, "無法載入 Knowledge 候選。");
      },
      onSettled: () => {
        candidatesLoading.value = false;
      },
    },
  );
}

/** Opens a request an Agent will process; the Web UI never proposes candidates itself. */
async function requestCandidates(project: ProjectRecord, reloadRoot?: string): Promise<void> {
  const { showToast } = useToast();
  try {
    const result = await useApi().client.requestKnowledgeCandidates(project.rootPath);
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
    return;
  }
  await loadCandidates(reloadRoot);
}

async function decide(
  candidate: KnowledgeCandidate,
  decision: "accept" | "reject",
  reloadRoot?: string,
  edits?: DecideKnowledgeCandidateInput["edits"],
): Promise<boolean> {
  const { showToast } = useToast();
  try {
    const result = await useApi().client.decideKnowledgeCandidate({ candidateId: candidate.id, decision, edits });
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
  await Promise.all([loadCandidates(reloadRoot), decision === "accept" ? useKnowledge().loadKnowledge() : undefined]);
  return true;
}

function acceptCandidate(candidate: KnowledgeCandidate, reloadRoot?: string): Promise<boolean> {
  return decide(candidate, "accept", reloadRoot);
}

async function rejectCandidate(candidate: KnowledgeCandidate, reloadRoot?: string): Promise<void> {
  const confirmed = await confirmAction({
    title: "拒絕這筆候選？",
    message: `「${candidate.title}」不會成為 Knowledge；之後的整理請求也不會再用同一筆 Session 產生候選。`,
    confirmLabel: "拒絕",
    danger: true,
  });
  if (confirmed) {
    await decide(candidate, "reject", reloadRoot);
  }
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
  if (!candidateSaving.value) {
    candidateEditor.value = null;
  }
}

/** Accepts the candidate with the reviewer's edits. */
async function saveCandidateEditor(reloadRoot?: string): Promise<void> {
  const candidate = candidateEditor.value;
  const form = candidateForm.value;
  if (!candidate) {
    return;
  }
  if (!form.title.trim() || !form.body.trim()) {
    candidateError.value = "標題與內容不能留白。";
    return;
  }
  candidateSaving.value = true;
  const accepted = await decide(candidate, "accept", reloadRoot, {
    kind: form.kind,
    title: form.title.trim(),
    body: form.body.trim(),
    tags: splitValues(form.tags),
    appliesTo: splitValues(form.appliesTo),
  });
  candidateSaving.value = false;
  if (accepted) {
    candidateEditor.value = null;
  }
}

function loadCandidates(projectRoot?: string): Promise<void> {
  return fetchCandidates(projectRoot);
}

/** Re-checks without the loading indicator, while an Agent is working on a request. */
function refreshCandidates(projectRoot?: string): Promise<void> {
  return fetchCandidates(projectRoot, true);
}

export function useKnowledgeCandidates() {
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
