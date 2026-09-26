import { computed, ref } from "vue";
import type { SessionLinkDirection, WorkSessionRecord } from "@work-intelligence/core";
import { storeToRefs } from "pinia";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

const linkSource = ref<WorkSessionRecord | null>(null);
const linkQuery = ref("");
const linkTargetId = ref("");
const linkDirection = ref<SessionLinkDirection>("continues");
const linkSaving = ref(false);
const linkActionError = ref("");

function openLinkDialog(session: WorkSessionRecord): void {
  linkSource.value = session;
  linkQuery.value = "";
  linkTargetId.value = "";
  linkDirection.value = "continues";
  linkActionError.value = "";
  useSessionsStore().openLinkCandidates(session.id);
}

function closeLinkDialog(): void {
  if (linkSaving.value) {
    return;
  }
  linkSource.value = null;
  useSessionsStore().closeLinkCandidates();
}

/** Candidate Sessions for a new link: same keyword search as the Sessions page, minus the open Session. */
function searchLinkCandidates(): void {
  if (!linkSource.value) return;
  linkActionError.value = "";
  useSessionsStore().searchLinkCandidates(linkQuery.value);
}

function afterLinkChange(message: string): void {
  useToast().showToast(message);
}

/**
 * Saves the chosen link. The API stores `continues` on the Session that continues the other, so
 * "the selected Session continues this one" is written from the selected Session's side.
 */
async function saveLink(): Promise<void> {
  const source = linkSource.value;
  const targetId = linkTargetId.value;
  if (!source) {
    return;
  }
  if (!targetId) {
    linkActionError.value = "請先選擇要關聯的 Session。";
    return;
  }
  const reverse = linkDirection.value === "continued_by";
  linkSaving.value = true;
  linkActionError.value = "";
  try {
    const result = await useSessionsStore().linkSessions({
      sessionId: reverse ? targetId : source.id,
      relatedSessionId: reverse ? source.id : targetId,
      relation: linkDirection.value === "related" ? "related" : "continues",
    });
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? "找不到這筆 Session。" : result.reason);
    }
  } catch (error) {
    linkActionError.value = errorMessage(error, "無法建立關聯。");
    linkSaving.value = false;
    return;
  }
  linkSaving.value = false;
  linkSource.value = null;
  useSessionsStore().closeLinkCandidates();
  afterLinkChange("已建立 Session 關聯。");
}

async function removeLink(sessionId: string, relatedSessionId: string, relatedTitle: string): Promise<void> {
  const confirmed = await confirmAction({
    title: "移除這個關聯？",
    message: `只移除與「${relatedTitle}」的關聯，兩筆 Session 本身都不受影響。`,
    confirmLabel: "移除",
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  try {
    const result = await useSessionsStore().unlinkSessions({ sessionId, relatedSessionId });
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? "找不到這筆 Session。" : result.reason);
    }
  } catch (error) {
    useToast().showToast(errorMessage(error, "無法移除關聯。"), "danger");
    return;
  }
  afterLinkChange("已移除 Session 關聯。");
}

export function useSessionLinks() {
  const sessionsStore = useSessionsStore();
  const { linkCandidates, linkCandidatesLoading, linkCandidatesError } = storeToRefs(sessionsStore);
  const linkError = computed(() => linkActionError.value || linkCandidatesError.value);

  return {
    linkSource,
    linkQuery,
    linkCandidates,
    linkCandidatesLoading,
    linkTargetId,
    linkDirection,
    linkSaving,
    linkError,
    openLinkDialog,
    closeLinkDialog,
    searchLinkCandidates,
    saveLink,
    removeLink,
  };
}
