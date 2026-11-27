<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { storeToRefs } from "pinia";
import { Bot } from "lucide-vue-next";
import type { AgentReviewPendingProject, AgentReviewRequest, ProjectRecord } from "@work-intelligence/core";
import AgentHandoffNotice from "./AgentHandoffNotice.vue";
import ProjectFilterMenu from "./ProjectFilterMenu.vue";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { agentReviewPageStateVisual, agentReviewRequestVisual } from "../../utils/status";
import { t } from "../../i18n";

const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const reviewStore = useAgentReviewStore();
const {
  latestRequest,
  latestCompletedRequest,
  hasOpenRequest,
  openRequests,
  pendingProjects,
  openRequestsLoaded,
  openRequestsError,
  pendingLoaded,
  pendingError,
  requestLoaded,
  requestError,
  skipped,
} = storeToRefs(reviewStore);
const { pages } = storeToRefs(useKnowledgePagesStore());
const { requestReview, cancelRequest } = useAgentReviewActions();

const creatingProjectId = ref("");

const overviewError = computed(() => pendingError.value || openRequestsError.value);
const overviewLoaded = computed(() => pendingLoaded.value && openRequestsLoaded.value);
const selectedProject = computed(() => props.projects.find((project) => project.id === projectId.value));
const openProjectIds = computed(() => new Set(openRequests.value.map((request) => request.projectId)));
const startableProjects = computed(() =>
  overviewLoaded.value ? pendingProjects.value.filter((project) => !openProjectIds.value.has(project.projectId)) : [],
);
const onlyProject = computed(() => (startableProjects.value.length === 1 ? startableProjects.value[0] : undefined));
const selectedPending = computed(() => pendingProjects.value.find((project) => project.projectId === projectId.value));
const selectedCount = computed(() => (selectedPending.value ? itemTotal(selectedPending.value) : 0));
const disabledReason = computed(() => {
  if (!selectedProject.value) return undefined;
  if (!overviewLoaded.value || !requestLoaded.value) return t("common.loading");
  if (skipped.value) return t("outstanding.trackingIsNotEnabledFor");
  if (hasOpenRequest.value) return t("knowledge.agentReviewReasonOpen");
  if (selectedCount.value === 0)
    return t("knowledge.agentReviewNothingInProject", { project: selectedProject.value.name });
  return undefined;
});
const statusMessage = computed(() => {
  const status = latestRequest.value?.status;
  if (status === "failed") return t("knowledge.agentReviewFailedMessage");
  return status === "completed" ? t("knowledge.agentReviewDoneMessage") : t("knowledge.agentReviewOpenMessage");
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

async function ask(targetProjectId: string): Promise<void> {
  creatingProjectId.value = targetProjectId;
  try {
    await requestReview(targetProjectId);
  } finally {
    creatingProjectId.value = "";
  }
}

function itemTotal(project: AgentReviewPendingProject): number {
  return project.decisionCount + project.candidateCount + project.knowledgeCount;
}

function pendingCounts(project: AgentReviewPendingProject): string {
  return t("knowledge.agentReviewPendingCounts", {
    decisionCount: project.decisionCount,
    candidateCount: project.candidateCount,
    knowledgeCount: project.knowledgeCount,
  });
}

function snapshotText(request: AgentReviewRequest): string {
  return t("knowledge.agentReviewSnapshot", {
    itemCount: request.itemCount,
    decisionCount: request.decisionCount,
    candidateCount: request.candidateCount,
    knowledgeCount: request.knowledgeCount,
  });
}

function totalsText(request: AgentReviewRequest): string {
  return t("knowledge.agentReviewTotals", {
    applied: request.appliedCount,
    skipped: request.skippedCount,
    open: request.openCount,
  });
}
</script>

<template>
  <UiBox data-testid="agent-review-request">
    <template #header>
      <UiBoxTitle :icon="Bot" :title="t('knowledge.agentReviewTitle')" />
    </template>
    <UiFlash v-if="requestError" tone="danger">{{ requestError }}</UiFlash>
    <UiFlash v-if="overviewError" tone="danger">
      {{ overviewError }}
      <template #actions
        ><UiButton size="sm" @click="reviewStore.reloadOverview">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>
    <p class="agent-review-request__hint">{{ t("knowledge.agentReviewIntro") }}</p>
    <div class="agent-review-request__filter">
      <ProjectFilterMenu v-model="projectId" :header="t('common.filterProject')" />
    </div>
    <div class="agent-review-request__start" data-testid="agent-review-start">
      <template v-if="selectedProject">
        <UiButton
          size="sm"
          variant="primary"
          :loading="creatingProjectId === selectedProject.id"
          :disabled="Boolean(disabledReason)"
          :disabled-reason="disabledReason"
          @click="ask(selectedProject.id)"
          >{{ t("knowledge.agentReviewAskProject", { project: selectedProject.name, count: selectedCount }) }}</UiButton
        >
        <p v-if="selectedPending" class="agent-review-request__meta">{{ pendingCounts(selectedPending) }}</p>
        <p v-if="disabledReason" class="agent-review-request__meta">{{ disabledReason }}</p>
      </template>
      <UiSkeleton v-else-if="!overviewLoaded && !overviewError" :count="1" :label="t('common.loading')" />
      <p v-else-if="overviewLoaded && startableProjects.length === 0" class="agent-review-request__meta">
        {{ openRequests.length > 0 ? t("knowledge.agentReviewNothingElse") : t("knowledge.agentReviewNothingPending") }}
      </p>
      <template v-else-if="onlyProject">
        <UiButton
          size="sm"
          variant="primary"
          :loading="creatingProjectId === onlyProject.projectId"
          @click="ask(onlyProject.projectId)"
          >{{
            t("knowledge.agentReviewAskProject", { project: onlyProject.projectName, count: itemTotal(onlyProject) })
          }}</UiButton
        >
        <p class="agent-review-request__meta">{{ pendingCounts(onlyProject) }}</p>
      </template>
      <ul
        v-else-if="startableProjects.length > 1"
        class="agent-review-request__projects"
        :aria-label="t('knowledge.agentReviewPendingTitle')"
      >
        <li
          v-for="project in startableProjects"
          :key="project.projectId"
          class="agent-review-request__project"
          data-testid="agent-review-project"
        >
          <span class="agent-review-request__project-name">{{ project.projectName }}</span>
          <span class="agent-review-request__meta">{{ pendingCounts(project) }}</span>
          <UiButton
            size="sm"
            variant="primary"
            :loading="creatingProjectId === project.projectId"
            :aria-label="t('knowledge.agentReviewAskProjectLabel', { project: project.projectName })"
            @click="ask(project.projectId)"
            >{{ t("knowledge.askAgentToReview") }}</UiButton
          >
        </li>
      </ul>
    </div>
    <div
      v-if="selectedProject && latestRequest"
      class="agent-review-request__status"
      data-testid="agent-review-request-status"
    >
      <AgentHandoffNotice
        :status="agentReviewRequestVisual[latestRequest.status]"
        :message="statusMessage"
        :command="hasOpenRequest ? t('knowledge.agentReviewCommand') : undefined"
        :cancel-label="hasOpenRequest ? t('knowledge.agentReviewCancelConfirm') : undefined"
        @cancel="cancelRequest(latestRequest.id)"
      >
        <p class="agent-review-request__line">{{ snapshotText(latestRequest) }} · {{ totalsText(latestRequest) }}</p>
        <p
          v-if="latestRequest.status === 'failed' && latestRequest.failureReason"
          class="agent-review-request__failure"
        >
          {{ t("knowledge.agentReviewFailed", { reason: latestRequest.failureReason }) }}
        </p>
        <p v-if="latestRequest.omittedCount > 0" class="agent-review-request__line">
          {{ t("knowledge.agentReviewOmitted", { count: latestRequest.omittedCount }) }}
        </p>
      </AgentHandoffNotice>
    </div>
    <div
      v-else-if="!selectedProject && openRequests.length > 0"
      class="agent-review-request__status"
      data-testid="agent-review-request-status"
    >
      <AgentHandoffNotice
        :title="t('knowledge.agentReviewOpenRequests')"
        :message="
          openRequests.length > 1 ? t('knowledge.agentReviewManyOpenMessage') : t('knowledge.agentReviewOpenMessage')
        "
        :command="t('knowledge.agentReviewCommand')"
      >
        <ul class="agent-review-request__projects">
          <li
            v-for="request in openRequests"
            :key="request.id"
            class="agent-review-request__project"
            data-testid="agent-review-open-request"
          >
            <span class="agent-review-request__project-name">{{ request.projectName }}</span>
            <StatusLabel :status="agentReviewRequestVisual[request.status]" />
            <span class="agent-review-request__meta">{{ snapshotText(request) }}</span>
            <p v-if="request.status === 'failed' && request.failureReason" class="agent-review-request__failure">
              {{ t("knowledge.agentReviewFailed", { reason: request.failureReason }) }}
            </p>
            <UiButton
              class="agent-review-request__cancel"
              size="sm"
              :aria-label="t('knowledge.agentReviewCancelLabel', { project: request.projectName ?? '' })"
              @click="cancelRequest(request.id)"
              >{{ t("knowledge.agentReviewCancelConfirm") }}</UiButton
            >
          </li>
        </ul>
      </AgentHandoffNotice>
    </div>
    <div v-if="pageRows" class="agent-review-request__pages" data-testid="agent-review-pages">
      <div class="agent-review-request__page-head">
        <strong>{{ t("knowledge.agentReviewPagesTitle") }}</strong>
        <span v-if="pageRows.length > 0">{{
          t("knowledge.agentReviewPagesProgress", { done: doneCount, total: pageRows.length })
        }}</span>
      </div>
      <p v-if="pageRows.length === 0" class="agent-review-request__line">
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
.agent-review-request__meta,
.agent-review-request__line,
.agent-review-request__failure {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.agent-review-request__hint {
  padding: var(--space-2) var(--space-4);
}

.agent-review-request__filter {
  padding: 0 var(--space-4) var(--space-2);
}

.agent-review-request__start {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3);
}

.agent-review-request__projects {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.agent-review-request__project {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  font-size: var(--text-sm);
}

.agent-review-request__project-name {
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.agent-review-request__cancel {
  margin-inline-start: auto;
}

.agent-review-request__status {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.agent-review-request__pages {
  border-top: 1px solid var(--border-muted);
}

.agent-review-request__page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}

.agent-review-request__pages .agent-review-request__line {
  padding: 0 var(--space-4) var(--space-2);
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

.agent-review-request__failure {
  color: var(--danger);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
