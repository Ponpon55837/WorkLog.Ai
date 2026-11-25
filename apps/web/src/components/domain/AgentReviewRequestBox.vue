<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Bot } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useSessionDecisionsStore } from "../../stores/session-decisions";
import { agentReviewRequestVisual } from "../../utils/status";
import { t } from "../../i18n";

/**
 * One open request per project serves both the decision inbox and the Knowledge candidates. The Agent applies its
 * verdicts directly; this box only opens, shows, and cancels the request.
 */
const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const reviewStore = useAgentReviewStore();
const { latestRequest, hasOpenRequest, requestLoaded, requestError, skipped } = storeToRefs(reviewStore);
const { pendingCount, decisionsLoaded } = storeToRefs(useSessionDecisionsStore());
const { candidates, candidatesLoaded } = storeToRefs(useKnowledgeStore());
const { requestReview, cancelRequest } = useAgentReviewActions();

const hasProject = computed(() => props.projects.some((project) => project.id === projectId.value));
const projectItems = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const nothingPending = computed(
  () => decisionsLoaded.value && candidatesLoaded.value && pendingCount.value + candidates.value.length === 0,
);
const canRequest = computed(
  () => hasProject.value && requestLoaded.value && !skipped.value && !hasOpenRequest.value && !nothingPending.value,
);
const hint = computed(() => {
  if (!hasProject.value) return t("knowledge.agentReviewChooseProject");
  if (skipped.value) return t("outstanding.trackingIsNotEnabledFor");
  if (hasOpenRequest.value) return t("knowledge.agentReviewAskYourAgent");
  if (nothingPending.value) return t("knowledge.agentReviewNothingPending");
  return t("knowledge.agentReviewIntro");
});
</script>

<template>
  <UiBox class="agent-review-request" data-testid="agent-review-request">
    <template #header>
      <UiBoxTitle :icon="Bot" :title="t('knowledge.agentReviewTitle')" />
      <UiActionMenu
        v-model="projectId"
        :label="t('common.project')"
        :header="t('common.filterProject')"
        default-value=""
        align="end"
        :items="projectItems"
      />
      <UiButton size="sm" variant="primary" :disabled="!canRequest" @click="requestReview">{{
        t("knowledge.askAgentToReview")
      }}</UiButton>
    </template>
    <UiFlash v-if="requestError" tone="danger">{{ requestError }}</UiFlash>
    <p class="agent-review-request__hint">{{ hint }}</p>
    <div v-if="latestRequest" class="agent-review-request__status" data-testid="agent-review-request-status">
      <div class="agent-review-request__line">
        <StatusLabel :status="agentReviewRequestVisual[latestRequest.status]" />
        <span>{{
          t("knowledge.agentReviewSnapshot", {
            itemCount: latestRequest.itemCount,
            decisionCount: latestRequest.decisionCount,
            candidateCount: latestRequest.candidateCount,
          })
        }}</span>
        <span>{{
          t("knowledge.agentReviewTotals", {
            applied: latestRequest.appliedCount,
            skipped: latestRequest.skippedCount,
            open: latestRequest.openCount,
          })
        }}</span>
        <UiButton
          v-if="hasOpenRequest"
          class="agent-review-request__cancel"
          size="sm"
          @click="cancelRequest(latestRequest.id)"
          >{{ t("knowledge.agentReviewCancelConfirm") }}</UiButton
        >
      </div>
      <p v-if="latestRequest.status === 'failed' && latestRequest.failureReason" class="agent-review-request__failure">
        {{ t("knowledge.agentReviewFailed", { reason: latestRequest.failureReason }) }}
      </p>
      <p v-if="latestRequest.omittedCount > 0" class="agent-review-request__omitted">
        {{ t("knowledge.agentReviewOmitted", { count: latestRequest.omittedCount }) }}
      </p>
    </div>
  </UiBox>
</template>

<style scoped>
.agent-review-request {
  margin-bottom: var(--space-4);
}

.agent-review-request__hint,
.agent-review-request__failure,
.agent-review-request__omitted {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.agent-review-request__status {
  border-top: 1px solid var(--border-muted);
}

.agent-review-request__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}

.agent-review-request__cancel {
  margin-inline-start: auto;
}

.agent-review-request__failure {
  color: var(--danger);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
