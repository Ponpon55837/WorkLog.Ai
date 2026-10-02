<script setup lang="ts">
import { storeToRefs } from "pinia";
import { BookOpen, Check, ExternalLink, X } from "lucide-vue-next";
import type { SessionDecisionRecord } from "@work-intelligence/core";
import { useKnowledgeActions } from "../../composables/useKnowledge";
import { useToast } from "../../composables/useToast";
import { useProjectsStore } from "../../stores/projects";
import { useSessionDecisionsStore } from "../../stores/session-decisions";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate, formatRelative } from "../../utils/format";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { t } from "../../i18n";

const props = defineProps<{ projectRoot?: string }>();
const decisionStore = useSessionDecisionsStore();
const { decisions, pendingCount, decisionsLoading, decisionsLoaded, decisionsError } = storeToRefs(decisionStore);
const projectsStore = useProjectsStore();
const { showToast } = useToast();
const { openAgentDecisionEditor } = useKnowledgeActions();
const { openSessionDetail } = useSessionsStore();

function projectRootFor(item: SessionDecisionRecord): string | undefined {
  return props.projectRoot ?? projectsStore.projects.find((project) => project.id === item.projectId)?.rootPath;
}

async function review(item: SessionDecisionRecord, reviewStatus: "confirmed" | "rejected"): Promise<void> {
  const projectRoot = projectRootFor(item);
  if (!projectRoot) {
    showToast(t("knowledge.couldNotFindTheTracked"), "danger");
    return;
  }
  try {
    const result = await decisionStore.reviewDecision({ decisionId: item.id, projectRoot, reviewStatus });
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
  }
}

function promote(item: SessionDecisionRecord): void {
  const project = projectsStore.projects.find((entry) => entry.id === item.projectId);
  if (!project) {
    showToast(t("knowledge.couldNotFindTheTracked"), "danger");
    return;
  }
  openAgentDecisionEditor(item, project);
}

function openSource(item: SessionDecisionRecord): void {
  void openSessionDetail(item.sessionId, t("knowledge.decisionSourceLoadFailed"));
}
</script>

<template>
  <UiBox class="agent-decisions" sticky-header data-testid="agent-decision-review">
    <template #header>
      <UiBoxTitle
        eyebrow="Agent decisions"
        :title="t('knowledge.agentAutonomousDecisionsToConfirm')"
        :count="decisionsLoaded ? pendingCount : undefined"
      />
    </template>
    <UiFlash v-if="decisionsError" tone="danger">{{ decisionsError }}</UiFlash>
    <UiSkeleton v-else-if="!decisionsLoaded" :count="3" :label="t('knowledge.loadingAgentAutonomousDecisions')" />
    <UiEmptyState
      v-else-if="!decisionsLoading && decisions.length === 0"
      :title="t('knowledge.noDecisionsToConfirm')"
      :description="t('knowledge.decisionsTheAgentExplicitlyMarks')"
    />
    <VirtualList
      v-else
      :items="decisions"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="176"
      :label="t('knowledge.agentAutonomousDecisionsToConfirmList')"
    >
      <template #default="{ item }">
        <article class="agent-decisions__item" data-testid="agent-decision-item">
          <div class="agent-decisions__meta">
            <UiLabel tone="attention">{{ t("knowledge.agentAutonomousDecisions") }}</UiLabel>
            <span>{{
              projectsStore.projects.find((project) => project.id === item.projectId)?.name ??
              t("knowledge.trackedProjectFallback")
            }}</span>
            <template v-if="item.sessionCompletedAt">
              <span aria-hidden="true">·</span>
              <time :title="formatDate(item.sessionCompletedAt)">{{ formatRelative(item.sessionCompletedAt) }}</time>
            </template>
          </div>
          <p class="agent-decisions__text">{{ item.text }}</p>
          <div class="agent-decisions__footer">
            <UiButton
              class="agent-decisions__source"
              size="sm"
              variant="invisible"
              :icon="ExternalLink"
              @click="openSource(item)"
            >
              {{ item.sessionTitle ?? t("knowledge.openSourceSession") }}
            </UiButton>
            <div class="agent-decisions__actions">
              <UiButton size="sm" :icon="Check" @click="review(item, 'confirmed')">{{ t("common.confirm") }}</UiButton>
              <UiButton size="sm" :icon="X" @click="review(item, 'rejected')">{{ t("knowledge.reject") }}</UiButton>
              <UiButton size="sm" variant="primary" :icon="BookOpen" @click="promote(item)">{{
                t("knowledge.turnIntoKnowledge")
              }}</UiButton>
            </div>
          </div>
        </article>
      </template>
    </VirtualList>
  </UiBox>
</template>

<style scoped>
.agent-decisions__item {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

/* The virtual list wraps each row, so the first row is found through its wrapper. */
:deep(.virtual-list-item:first-child) .agent-decisions__item,
.agent-decisions__item:first-child {
  border-top: 0;
}

.agent-decisions__meta,
.agent-decisions__footer,
.agent-decisions__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.agent-decisions__meta {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.agent-decisions__text {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-decisions__footer {
  justify-content: space-between;
}

/* A long Session title wraps inside the button instead of pushing the actions away. */
.agent-decisions__source {
  max-width: 100%;
  white-space: normal;
  text-align: start;
}

.agent-decisions__actions {
  margin-inline-start: auto;
}
</style>
