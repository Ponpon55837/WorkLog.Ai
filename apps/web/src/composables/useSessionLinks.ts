import { ref } from "vue";
import type { SessionLinkDirection, WorkSessionRecord } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { invalidateActiveQueries } from "./useAppRefresh";
import { confirmAction } from "./useConfirm";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

const linkSource = ref<WorkSessionRecord | null>(null);
const linkQuery = ref("");
const linkCandidates = ref<WorkSessionRecord[]>([]);
const linkCandidatesLoading = ref(false);
const linkTargetId = ref("");
const linkDirection = ref<SessionLinkDirection>("continues");
const linkSaving = ref(false);
const linkError = ref("");

function openLinkDialog(session: WorkSessionRecord): void {
  linkSource.value = session;
  linkQuery.value = "";
  linkCandidates.value = [];
  linkTargetId.value = "";
  linkDirection.value = "continues";
  linkError.value = "";
  void searchLinkCandidates();
}

function closeLinkDialog(): void {
  if (linkSaving.value) {
    return;
  }
  linkSource.value = null;
}

/** Candidate Sessions for a new link: same keyword search as the Sessions page, minus the open Session. */
async function searchLinkCandidates(): Promise<void> {
  const source = linkSource.value;
  if (!source) {
    return;
  }
  linkCandidatesLoading.value = true;
  await runKeyed(
    "session-link-candidates",
    async (signal) => {
      const result = await useApi().client.listSessions(
        { q: linkQuery.value.trim() || undefined, pageSize: 8 },
        signal,
      );
      linkCandidates.value = result.items.filter((item) => item.id !== source.id);
    },
    {
      onError: (error) => {
        linkError.value = errorMessage(error, "無法搜尋 Session。");
      },
      onSettled: () => {
        linkCandidatesLoading.value = false;
      },
    },
  );
}

async function afterLinkChange(sessionId: string, message: string): Promise<void> {
  useToast().showToast(message);
  await useSessionDetail().openSessionDetail(sessionId);
  void invalidateActiveQueries().catch(() => undefined);
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
    linkError.value = "請先選擇要關聯的 Session。";
    return;
  }
  const reverse = linkDirection.value === "continued_by";
  linkSaving.value = true;
  linkError.value = "";
  try {
    const result = await useApi().client.linkSession(
      reverse ? targetId : source.id,
      reverse ? source.id : targetId,
      linkDirection.value === "related" ? "related" : "continues",
    );
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? "找不到這筆 Session。" : result.reason);
    }
  } catch (error) {
    linkError.value = errorMessage(error, "無法建立關聯。");
    linkSaving.value = false;
    return;
  }
  linkSaving.value = false;
  linkSource.value = null;
  await afterLinkChange(source.id, "已建立 Session 關聯。");
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
    const result = await useApi().client.unlinkSession(sessionId, relatedSessionId);
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? "找不到這筆 Session。" : result.reason);
    }
  } catch (error) {
    useToast().showToast(errorMessage(error, "無法移除關聯。"), "danger");
    return;
  }
  await afterLinkChange(sessionId, "已移除 Session 關聯。");
}

export function useSessionLinks() {
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
