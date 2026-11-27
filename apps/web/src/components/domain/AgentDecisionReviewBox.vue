<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { BookOpen, Check, ExternalLink, X } from "lucide-vue-next";
import type { SessionDecisionRecord } from "@work-intelligence/core";
import AgentReviewFilter from "./AgentReviewFilter.vue";
import AgentReviewVerdict from "./AgentReviewVerdict.vue";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useDecisionReview } from "../../composables/useDecisionReview";
import { useFocusRestore } from "../../composables/useFocusRestore";
import { useKnowledgeActions } from "../../composables/useKnowledge";
import { useRowSelection } from "../../composables/useRowSelection";
import { useToast } from "../../composables/useToast";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useProjectsStore } from "../../stores/projects";
import { useSessionDecisionsStore } from "../../stores/session-decisions";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate, formatRelative } from "../../utils/format";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCheckbox from "../ui/UiCheckbox.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSelectionBar from "../ui/UiSelectionBar.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { t } from "../../i18n";

const props = defineProps<{ projectRoot?: string; highlightId?: string }>();

const REVEAL_ATTEMPTS = 10;
const REVEAL_DELAY_MS = 100;

const decisionStore = useSessionDecisionsStore();
const { decisions, pendingCount, decisionsLoading, decisionsLoaded, decisionsError } = storeToRefs(decisionStore);
const { filter } = storeToRefs(useAgentReviewStore());
const { overturn } = useAgentReviewActions();
const projectsStore = useProjectsStore();
const { showToast } = useToast();
const { isReviewing, review, reviewMany } = useDecisionReview();
const { openAgentDecisionEditor } = useKnowledgeActions();
const { openSessionDetail } = useSessionsStore();
const { selectedIds, allSelected, clearSelection, selectItem, dropFromSelection } = useRowSelection(() =>
  filter.value === "pending" ? decisions.value.map((decision) => decision.id) : [],
);
const { boxRef, listRef, restoreFocus, settleFocus } = useFocusRestore({
  rowIdAttribute: "data-decision-id",
  actionSelector: ".agent-decisions__actions button",
});

const revealedId = ref("");
const batchBusy = ref(false);
const orderedDecisions = computed(() => {
  const id = props.highlightId;
  const targeted = id ? decisions.value.filter((decision) => decision.id === id) : [];
  return targeted.length ? [...targeted, ...decisions.value.filter((decision) => decision.id !== id)] : decisions.value;
});

const selectionBusy = computed(() => batchBusy.value || selectedIds.value.some(isReviewing));
const moreItems = computed(() => [
  { value: "promote" as const, label: t("knowledge.turnIntoKnowledge"), icon: BookOpen },
]);

function projectRootFor(item: SessionDecisionRecord): string | undefined {
  return props.projectRoot ?? projectsStore.projects.find((project) => project.id === item.projectId)?.rootPath;
}

function revealHighlighted(): void {
  const id = props.highlightId;
  if (!id || revealedId.value === id || !decisions.value.some((decision) => decision.id === id)) return;
  revealedId.value = id;
  const selector = `[data-decision-id="${CSS.escape(id)}"]`;
  let attempts = 0;
  const locate = (): void => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
    } else if (++attempts < REVEAL_ATTEMPTS) {
      setTimeout(locate, REVEAL_DELAY_MS);
    }
  };
  void nextTick(locate);
}

function verdictFor(item: SessionDecisionRecord): "confirmed" | "rejected" | "promoted" {
  return item.reviewStatus === "pending" ? "confirmed" : item.reviewStatus;
}

async function reviewOne(item: SessionDecisionRecord, verdict: "confirmed" | "rejected"): Promise<void> {
  const nextId = orderedDecisions.value[orderedDecisions.value.findIndex((entry) => entry.id === item.id) + 1]?.id;
  if (await review(item, verdict, projectRootFor(item))) {
    dropFromSelection([item.id]);
    await restoreFocus(nextId);
  }
}

async function reviewSelected(verdict: "confirmed" | "rejected"): Promise<void> {
  if (selectionBusy.value || selectedIds.value.length === 0) return;
  const targets = orderedDecisions.value.filter((decision) => selectedIds.value.includes(decision.id));
  batchBusy.value = true;
  try {
    dropFromSelection(await reviewMany(targets, verdict));
    await restoreFocus();
  } finally {
    batchBusy.value = false;
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

watch([() => props.highlightId, decisions], revealHighlighted, { immediate: true });
watch([filter, () => props.projectRoot], clearSelection);
watch(
  decisions,
  (items) => {
    const listed = new Set(items.map((decision) => decision.id));
    selectedIds.value = selectedIds.value.filter((id) => listed.has(id));
  },
  { flush: "pre" },
);
watch(decisions, settleFocus, { flush: "post" });
</script>

<template>
  <UiBox ref="boxRef" class="agent-decisions" sticky-header data-testid="agent-decision-review">
    <template #header>
      <UiBoxTitle
        :title="
          filter === 'agent' ? t('knowledge.agentProcessedDecisions') : t('knowledge.agentAutonomousDecisionsToConfirm')
        "
        :count="decisionsLoaded ? (filter === 'agent' ? decisions.length : pendingCount) : undefined"
      />
      <AgentReviewFilter v-model="filter" />
    </template>
    <UiSelectionBar
      v-if="filter === 'pending' && decisionsLoaded && decisions.length > 0"
      v-model="allSelected"
      :label="t('knowledge.selectAllDecisionsInList')"
      :select-text="t('knowledge.selectList')"
      :group-label="t('knowledge.decisionBulkActions')"
      :summary="t('knowledge.decisionsSelected', { count: selectedIds.length })"
      :count="selectedIds.length"
      :indeterminate="selectedIds.length > 0 && !allSelected"
      :disabled="selectionBusy"
      toolbar-testid="decision-batch-toolbar"
      summary-testid="decision-selection-summary"
    >
      <UiButton variant="link" size="sm" :disabled="selectionBusy" @click="clearSelection">{{
        t("knowledge.clearSelection")
      }}</UiButton>
      <UiButton size="sm" variant="primary" :disabled="selectionBusy" @click="reviewSelected('confirmed')">{{
        t("knowledge.confirmSelected")
      }}</UiButton>
      <UiButton size="sm" :disabled="selectionBusy" @click="reviewSelected('rejected')">{{
        t("knowledge.rejectSelected")
      }}</UiButton>
    </UiSelectionBar>
    <UiFlash v-if="decisionsError" tone="danger">{{ decisionsError }}</UiFlash>
    <UiSkeleton v-else-if="!decisionsLoaded" :count="3" :label="t('knowledge.loadingAgentAutonomousDecisions')" />
    <UiEmptyState
      v-else-if="!decisionsLoading && decisions.length === 0"
      :title="filter === 'agent' ? t('knowledge.noAgentProcessedDecisions') : t('knowledge.noDecisionsToConfirm')"
      :description="
        filter === 'agent'
          ? t('knowledge.agentProcessedDecisionsHint')
          : t('knowledge.decisionsTheAgentExplicitlyMarks')
      "
    />
    <VirtualList
      v-else
      ref="listRef"
      :items="orderedDecisions"
      :enabled="true"
      fit-viewport
      fit-viewport-to-panel
      fill-available-space
      :estimate-item-height="176"
      :label="
        filter === 'agent'
          ? t('knowledge.agentProcessedDecisionsList')
          : t('knowledge.agentAutonomousDecisionsToConfirmList')
      "
    >
      <template #default="{ item }">
        <article
          :class="['agent-decisions__item', { 'is-targeted': item.id === highlightId }]"
          :data-decision-id="item.id"
          :tabindex="item.id === highlightId ? -1 : undefined"
          data-testid="agent-decision-item"
        >
          <div class="agent-decisions__meta">
            <UiCheckbox
              v-if="filter === 'pending'"
              :model-value="selectedIds.includes(item.id)"
              :label="t('knowledge.selectDecision', { text: item.text })"
              :disabled="selectionBusy || isReviewing(item.id)"
              @update:model-value="selectItem(item.id, $event)"
            />
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
          <AgentReviewVerdict
            v-if="filter === 'agent'"
            :verdict="verdictFor(item)"
            :reason="item.reviewReason"
            :reviewed-at="item.reviewedAt"
            @overturn="overturn('decision', item.id, projectRootFor(item))"
          />
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
            <div v-if="filter === 'pending'" class="agent-decisions__actions">
              <UiButton
                size="sm"
                variant="primary"
                :icon="Check"
                :loading="isReviewing(item.id)"
                :disabled="selectionBusy || isReviewing(item.id)"
                @click="reviewOne(item, 'confirmed')"
                >{{ t("common.confirm") }}</UiButton
              >
              <UiButton
                size="sm"
                :icon="X"
                :disabled="selectionBusy || isReviewing(item.id)"
                @click="reviewOne(item, 'rejected')"
                >{{ t("knowledge.reject") }}</UiButton
              >
              <UiActionMenu
                :label="t('knowledge.more')"
                :items="moreItems"
                variant="button"
                size="sm"
                align="end"
                @select="promote(item)"
              />
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

.agent-decisions__item.is-targeted {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
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
