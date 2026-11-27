import { ref } from "vue";
import { useProjectsStore } from "../stores/projects";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { useToast } from "./useToast";
import { t } from "../i18n";

type DecisionTarget = { id: string; projectId?: string };

/** Confirms or rejects one Agent-autonomous decision and reports the outcome with a toast. */
export function useDecisionReview() {
  const decisionStore = useSessionDecisionsStore();
  const projectsStore = useProjectsStore();
  const { showToast } = useToast();
  const reviewingId = ref("");

  async function review(
    decision: DecisionTarget,
    reviewStatus: "confirmed" | "rejected",
    projectRoot?: string,
  ): Promise<void> {
    const root = projectRoot ?? projectsStore.projects.find((project) => project.id === decision.projectId)?.rootPath;
    if (!root) {
      showToast(t("knowledge.couldNotFindTheTracked"), "danger");
      return;
    }
    reviewingId.value = decision.id;
    try {
      const result = await decisionStore.reviewDecision({ decisionId: decision.id, projectRoot: root, reviewStatus });
      if (result.outcome === "session_decision_reviewed") {
        showToast(
          reviewStatus === "confirmed"
            ? t("knowledge.agentAutonomousDecisionConfirmed")
            : t("knowledge.agentAutonomousDecisionRejected"),
        );
      } else {
        showToast(
          result.outcome === "skipped"
            ? (result.reason ?? t("common.trackingIsNotEnabledFor"))
            : t("knowledge.decisionNotFound"),
          "danger",
        );
      }
    } catch {
      showToast(t("knowledge.couldNotUpdateTheDecision"), "danger");
    } finally {
      reviewingId.value = "";
    }
  }

  return { reviewingId, review };
}
