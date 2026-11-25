import type { AgentReviewItemKind } from "@work-intelligence/core";
import { ApiError } from "../api/client";
import { useAgentReviewStore } from "../stores/agent-review";
import { errorMessage } from "../utils/format";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";
import { t } from "../i18n";

/** Creates or cancels the project's Agent review request and overturns Agent verdicts, with confirmation and feedback. */
export function useAgentReviewActions() {
  const store = useAgentReviewStore();
  const { showToast } = useToast();

  async function requestReview(): Promise<void> {
    try {
      const result = await store.createRequest();
      if (result.outcome === "agent_review_request") {
        showToast(result.duplicate ? t("knowledge.agentReviewAlreadyOpen") : t("knowledge.agentReviewRequested"));
      } else if (result.outcome === "agent_review_not_needed" || result.outcome === "skipped") {
        showToast(result.reason ?? t("common.trackingIsNotEnabledFor"));
      } else {
        showToast(t("knowledge.agentReviewCouldNotRequest"), "danger");
      }
    } catch (error) {
      showToast(errorMessage(error, t("knowledge.agentReviewCouldNotRequest")), "danger");
    }
  }

  async function cancelRequest(requestId: string): Promise<void> {
    const confirmed = await confirmAction({
      title: t("knowledge.agentReviewCancelTitle"),
      message: t("knowledge.agentReviewCancelMessage"),
      confirmLabel: t("knowledge.agentReviewCancelConfirm"),
      cancelLabel: t("knowledge.agentReviewKeepRequest"),
    });
    if (!confirmed) return;
    try {
      const result = await store.cancelRequest(requestId);
      if (result.outcome === "agent_review_request_cancelled") showToast(t("knowledge.agentReviewCancelled"));
      else showToast(t("knowledge.agentReviewCouldNotCancel"), "danger");
    } catch (error) {
      showToast(errorMessage(error, t("knowledge.agentReviewCouldNotCancel")), "danger");
    }
  }

  async function overturn(
    itemKind: AgentReviewItemKind,
    itemId: string,
    projectRoot: string | undefined,
  ): Promise<void> {
    if (!projectRoot) {
      showToast(t("knowledge.couldNotFindTheTracked"), "danger");
      return;
    }
    const confirmed = await confirmAction({
      title: t("knowledge.overturnTitle"),
      message:
        itemKind === "decision" ? t("knowledge.overturnDecisionMessage") : t("knowledge.overturnCandidateMessage"),
      confirmLabel: t("knowledge.overturn"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await store.overturn({ projectRoot, itemKind, itemId });
      if (result.outcome === "agent_review_overturned") {
        const action = result.knowledge?.action;
        showToast(
          action === "archived"
            ? t("knowledge.overturnedKnowledgeArchived")
            : action === "unchanged"
              ? t("knowledge.overturnedKnowledgeUnchanged")
              : action === "missing"
                ? t("knowledge.overturnedKnowledgeMissing")
                : t("knowledge.overturned"),
        );
      } else {
        showToast(result.outcome === "skipped" ? result.reason : t("knowledge.overturnNotFound"), "danger");
      }
    } catch (error) {
      showToast(
        error instanceof ApiError && error.code === "conflict"
          ? t("knowledge.overturnNotAgentReviewed")
          : errorMessage(error, t("knowledge.couldNotOverturn")),
        "danger",
      );
    }
  }

  return { requestReview, cancelRequest, overturn };
}
