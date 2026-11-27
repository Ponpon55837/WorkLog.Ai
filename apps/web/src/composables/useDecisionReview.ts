import { ref } from "vue";
import { useProjectsStore } from "../stores/projects";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { useToast } from "./useToast";
import { t } from "../i18n";

type DecisionTarget = { id: string; projectId?: string };

/** Confirms or rejects Agent-autonomous decisions, several at once, and reports each outcome with a toast. */
export function useDecisionReview() {
  const decisionStore = useSessionDecisionsStore();
  const projectsStore = useProjectsStore();
  const { showToast } = useToast();
  const reviewingIds = ref<string[]>([]);

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
    if (reviewingIds.value.includes(decision.id)) return;
    reviewingIds.value = [...reviewingIds.value, decision.id];
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
      reviewingIds.value = reviewingIds.value.filter((id) => id !== decision.id);
    }
  }

  function isReviewing(id: string): boolean {
    return reviewingIds.value.includes(id);
  }

  return { isReviewing, review };
}
