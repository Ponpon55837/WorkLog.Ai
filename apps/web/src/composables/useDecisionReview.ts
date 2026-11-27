import { ref } from "vue";
import { useProjectsStore } from "../stores/projects";
import { useSessionDecisionsStore } from "../stores/session-decisions";
import { errorMessage } from "../utils/format";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";
import { t } from "../i18n";

type DecisionTarget = { id: string; projectId?: string };
type DecisionVerdict = "confirmed" | "rejected";

/**
 * Confirms or rejects Agent-autonomous decisions and reports each outcome with a toast.
 * A human review cannot be reset to pending, so a reject asks first and no toast offers an undo.
 */
export function useDecisionReview() {
  const decisionStore = useSessionDecisionsStore();
  const projectsStore = useProjectsStore();
  const { showToast } = useToast();
  const reviewingIds = ref<string[]>([]);

  function rootFor(decision: DecisionTarget, projectRoot?: string): string | undefined {
    return projectRoot ?? projectsStore.projects.find((project) => project.id === decision.projectId)?.rootPath;
  }

  function confirmReject(count: number): Promise<boolean> {
    return confirmAction({
      title: t("knowledge.rejectDecisionsTitle", { count }),
      message: t("knowledge.rejectDecisionsMessage", { count }),
      confirmLabel: t("knowledge.reject"),
      danger: true,
    });
  }

  /** Resolves true when the decision was applied. */
  async function review(
    decision: DecisionTarget,
    reviewStatus: DecisionVerdict,
    projectRoot?: string,
  ): Promise<boolean> {
    const root = rootFor(decision, projectRoot);
    if (!root) {
      showToast(t("knowledge.couldNotFindTheTracked"), "danger");
      return false;
    }
    if (reviewingIds.value.includes(decision.id)) return false;
    if (reviewStatus === "rejected" && !(await confirmReject(1))) return false;
    reviewingIds.value = [...reviewingIds.value, decision.id];
    try {
      const result = await decisionStore.reviewDecision({ decisionId: decision.id, projectRoot: root, reviewStatus });
      if (result.outcome === "session_decision_reviewed") {
        showToast(
          reviewStatus === "confirmed"
            ? t("knowledge.agentAutonomousDecisionConfirmed")
            : t("knowledge.agentAutonomousDecisionRejected"),
        );
        return true;
      }
      showToast(
        result.outcome === "skipped"
          ? (result.reason ?? t("common.trackingIsNotEnabledFor"))
          : t("knowledge.decisionNotFound"),
        "danger",
      );
      return false;
    } catch {
      showToast(t("knowledge.couldNotUpdateTheDecision"), "danger");
      return false;
    } finally {
      reviewingIds.value = reviewingIds.value.filter((id) => id !== decision.id);
    }
  }

  /** Resolves the ids that are done with (applied or no longer pending); the rest stay for a retry. */
  async function reviewMany(decisions: DecisionTarget[], reviewStatus: DecisionVerdict): Promise<string[]> {
    const inputs = decisions.flatMap((decision) => {
      const projectRoot = rootFor(decision);
      return projectRoot ? [{ decisionId: decision.id, projectRoot, reviewStatus }] : [];
    });
    if (inputs.length === 0) {
      showToast(t("knowledge.couldNotFindTheTracked"), "danger");
      return [];
    }
    if (reviewStatus === "rejected" && !(await confirmReject(inputs.length))) return [];
    reviewingIds.value = [...reviewingIds.value, ...inputs.map((input) => input.decisionId)];
    try {
      const result = await decisionStore.reviewDecisions(inputs);
      const reviewed = result.reviewedIds.length;
      const skipped = result.skippedIds.length;
      if (result.failure) {
        const reason = errorMessage(result.failure, t("knowledge.couldNotUpdateTheDecision"));
        showToast(t("knowledge.decisionsPartiallyReviewed", { reviewed, total: inputs.length, reason }), "danger");
      } else if (skipped > 0) {
        showToast(t("knowledge.decisionsReviewedAndSkipped", { reviewed, skipped }));
      } else {
        showToast(
          reviewStatus === "confirmed"
            ? t("knowledge.decisionsConfirmed", { count: reviewed })
            : t("knowledge.decisionsRejected", { count: reviewed }),
          "success",
        );
      }
      return [...result.reviewedIds, ...result.skippedIds];
    } finally {
      const done = new Set(inputs.map((input) => input.decisionId));
      reviewingIds.value = reviewingIds.value.filter((id) => !done.has(id));
    }
  }

  function isReviewing(id: string): boolean {
    return reviewingIds.value.includes(id);
  }

  return { isReviewing, review, reviewMany };
}
