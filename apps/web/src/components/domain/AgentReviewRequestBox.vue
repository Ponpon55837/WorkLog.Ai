<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { storeToRefs } from "pinia";
import { Bot } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import ProjectFilterMenu from "./ProjectFilterMenu.vue";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { agentReviewPageStateVisual, agentReviewRequestVisual } from "../../utils/status";
import { t } from "../../i18n";

const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const reviewStore = useAgentReviewStore();
const { latestRequest, latestCompletedRequest, hasOpenRequest, requestLoaded, requestError, skipped } =
  storeToRefs(reviewStore);
const { pages } = storeToRefs(useKnowledgePagesStore());
const { requestReview, cancelRequest } = useAgentReviewActions();

const hasProject = computed(() => props.projects.some((project) => project.id === projectId.value));
const canRequest = computed(() => hasProject.value && requestLoaded.value && !skipped.value && !hasOpenRequest.value);
const hint = computed(() => {
  if (!hasProject.value) return t("knowledge.agentReviewChooseProject");
  if (skipped.value) return t("outstanding.trackingIsNotEnabledFor");
  if (hasOpenRequest.value) return t("knowledge.agentReviewAskYourAgent");
  return t("knowledge.agentReviewIntro");
});
const pageRows = computed(() => {
  const request = latestCompletedRequest.value;
  if (hasOpenRequest.value || !request?.knowledgePages) return undefined;
  const pageIds = new Map(
    pages.value.filter((page) => page.projectId === request.projectId).map((page) => [page.slug, page.id]),
  );
  return request.knowledgePages.map((page) => {
    const pageId = pageIds.get(page.slug);
    const link: RouteLocationRaw | undefined = pageId
      ? { name: "knowledge", params: { tab: "pages" }, query: { project: request.projectId, knowledgePage: pageId } }
      : undefined;
    return { ...page, link };
  });
});
const doneCount = computed(
  () => pageRows.value?.filter((page) => page.state === "updated" || page.state === "checked").length ?? 0,
);
</script>

<template>
  <UiBox data-testid="agent-review-request">
    <template #header>
      <UiBoxTitle :icon="Bot" :title="t('knowledge.agentReviewTitle')" />
    </template>
    <UiFlash v-if="requestError" tone="danger">{{ requestError }}</UiFlash>
    <p class="agent-review-request__hint">{{ hint }}</p>
    <div class="agent-review-request__actions">
      <ProjectFilterMenu v-model="projectId" :header="t('common.filterProject')" />
      <UiButton size="sm" variant="primary" :disabled="!canRequest" @click="requestReview">{{
        t("knowledge.askAgentToReview")
      }}</UiButton>
    </div>
    <div v-if="latestRequest" class="agent-review-request__status" data-testid="agent-review-request-status">
      <div class="agent-review-request__line">
        <StatusLabel :status="agentReviewRequestVisual[latestRequest.status]" />
        <span>{{
          t("knowledge.agentReviewSnapshot", {
            itemCount: latestRequest.itemCount,
            decisionCount: latestRequest.decisionCount,
            candidateCount: latestRequest.candidateCount,
            knowledgeCount: latestRequest.knowledgeCount,
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
    <div v-if="pageRows" class="agent-review-request__pages" data-testid="agent-review-pages">
      <div class="agent-review-request__line">
        <strong>{{ t("knowledge.agentReviewPagesTitle") }}</strong>
        <span v-if="pageRows.length > 0">{{
          t("knowledge.agentReviewPagesProgress", { done: doneCount, total: pageRows.length })
        }}</span>
      </div>
      <p v-if="pageRows.length === 0" class="agent-review-request__omitted">
        {{ t("knowledge.agentReviewPagesNone") }}
      </p>
      <ul v-else class="agent-review-request__page-list" :aria-label="t('knowledge.agentReviewPagesList')">
        <li
          v-for="page in pageRows"
          :key="page.slug"
          class="agent-review-request__page"
          data-testid="agent-review-page"
        >
          <span class="agent-review-request__page-title">{{ page.title }}</span>
          <StatusLabel :status="agentReviewPageStateVisual[page.state]" />
          <RouterLink
            v-if="page.link"
            class="agent-review-request__page-link"
            :to="page.link"
            :aria-label="t('knowledge.agentReviewPageOpenLabel', { title: page.title })"
            >{{ t("knowledge.agentReviewPageOpen") }}</RouterLink
          >
        </li>
      </ul>
    </div>
  </UiBox>
</template>

<style scoped>
.agent-review-request__hint,
.agent-review-request__failure,
.agent-review-request__omitted {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.agent-review-request__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3);
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

.agent-review-request__pages {
  border-top: 1px solid var(--border-muted);
}

.agent-review-request__page-list {
  margin: 0;
  padding: 0 var(--space-4) var(--space-2);
  list-style: none;
}

.agent-review-request__page {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
}

.agent-review-request__page-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-review-request__page-link {
  margin-inline-start: auto;
  color: var(--accent);
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
