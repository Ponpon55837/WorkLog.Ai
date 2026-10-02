import { computed } from "vue";
import type { WorkSessionRecord } from "@work-intelligence/core";
import { storeToRefs } from "pinia";
import { useSessionLinkDialogStore } from "../stores/session-link-dialog";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";
import { t } from "../i18n";

function openLinkDialog(session: WorkSessionRecord): void {
  useSessionLinkDialogStore().linkSource = session;
  useSessionLinkDialogStore().linkQuery = "";
  useSessionLinkDialogStore().linkTargetId = "";
  useSessionLinkDialogStore().linkDirection = "continues";
  useSessionLinkDialogStore().linkActionError = "";
  useSessionsStore().openLinkCandidates(session.id);
}

function closeLinkDialog(): void {
  if (useSessionLinkDialogStore().linkSaving) {
    return;
  }
  useSessionLinkDialogStore().linkSource = null;
  useSessionsStore().closeLinkCandidates();
}

/** Candidate Sessions for a new link: same keyword search as the Sessions page, minus the open Session. */
function searchLinkCandidates(): void {
  if (!useSessionLinkDialogStore().linkSource) return;
  useSessionLinkDialogStore().linkActionError = "";
  useSessionsStore().searchLinkCandidates(useSessionLinkDialogStore().linkQuery);
}

function afterLinkChange(message: string): void {
  useToast().showToast(message);
}

/**
 * Saves the chosen link. The API stores `continues` on the Session that continues the other, so
 * "the selected Session continues this one" is written from the selected Session's side.
 */
async function saveLink(): Promise<void> {
  const source = useSessionLinkDialogStore().linkSource;
  const targetId = useSessionLinkDialogStore().linkTargetId;
  if (!source) {
    return;
  }
  if (!targetId) {
    useSessionLinkDialogStore().linkActionError = t("session.chooseASessionToLink");
    return;
  }
  const reverse = useSessionLinkDialogStore().linkDirection === "continued_by";
  useSessionLinkDialogStore().linkSaving = true;
  useSessionLinkDialogStore().linkActionError = "";
  try {
    const result = await useSessionsStore().linkSessions({
      sessionId: reverse ? targetId : source.id,
      relatedSessionId: reverse ? source.id : targetId,
      relation: useSessionLinkDialogStore().linkDirection === "related" ? "related" : "continues",
    });
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? t("session.sessionNotFound") : result.reason);
    }
  } catch (error) {
    useSessionLinkDialogStore().linkActionError = errorMessage(error, t("session.couldNotCreateTheLink"));
    useSessionLinkDialogStore().linkSaving = false;
    return;
  }
  useSessionLinkDialogStore().linkSaving = false;
  useSessionLinkDialogStore().linkSource = null;
  useSessionsStore().closeLinkCandidates();
  afterLinkChange(t("session.sessionLinkCreated"));
}

async function removeLink(sessionId: string, relatedSessionId: string, relatedTitle: string): Promise<void> {
  const confirmed = await confirmAction({
    title: t("session.removeThisLink"),
    message: t("session.onlyTheLinkToIs", { relatedTitle }),
    confirmLabel: t("common.remove"),
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  try {
    const result = await useSessionsStore().unlinkSessions({ sessionId, relatedSessionId });
    if (result.outcome !== "session_link_updated") {
      throw new Error(result.outcome === "not_found" ? t("session.sessionNotFound") : result.reason);
    }
  } catch (error) {
    useToast().showToast(errorMessage(error, t("session.couldNotRemoveTheLink")), "danger");
    return;
  }
  afterLinkChange(t("session.sessionLinkRemoved"));
}

export function useSessionLinks() {
  const { linkSource, linkQuery, linkTargetId, linkDirection, linkSaving, linkActionError } =
    storeToRefs(useSessionLinkDialogStore());
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
