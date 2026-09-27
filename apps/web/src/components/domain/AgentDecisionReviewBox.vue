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
import VirtualList from "../VirtualList.vue";

const props = defineProps<{ projectRoot?: string }>();
const decisionStore = useSessionDecisionsStore();
const { decisions, pendingCount, decisionsLoading, decisionsError } = storeToRefs(decisionStore);
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
    showToast("找不到決策所屬的 tracked project。", "danger");
    return;
  }
  try {
    const result = await decisionStore.reviewDecision({ decisionId: item.id, projectRoot, reviewStatus });
    if (result.outcome === "session_decision_reviewed") {
      showToast(reviewStatus === "confirmed" ? "已確認這項 Agent 自主決策。" : "已拒絕這項 Agent 自主決策。");
    } else {
      showToast(
        result.outcome === "skipped" ? (result.reason ?? "此專案目前未啟用記錄。") : "找不到這項決策。",
        "danger",
      );
    }
  } catch {
    showToast("更新決策審核狀態失敗，請重試。", "danger");
  }
}

function promote(item: SessionDecisionRecord): void {
  const project = projectsStore.projects.find((entry) => entry.id === item.projectId);
  if (!project) {
    showToast("找不到決策所屬的 tracked project。", "danger");
    return;
  }
  openAgentDecisionEditor(item, project);
}

function openSource(item: SessionDecisionRecord): void {
  void openSessionDetail(item.sessionId, "無法載入這項決策的來源 Session。");
}
</script>

<template>
  <UiBox class="agent-decisions" data-testid="agent-decision-review">
    <template #header>
      <UiBoxTitle eyebrow="Agent decisions" title="待確認的 Agent 自主決策" :count="pendingCount" />
    </template>
    <UiFlash v-if="decisionsError" tone="danger">{{ decisionsError }}</UiFlash>
    <UiEmptyState
      v-else-if="!decisionsLoading && decisions.length === 0"
      title="目前沒有待確認的決策"
      description="Agent 明確標記為自主選擇的決策會出現在這裡。"
    />
    <VirtualList
      v-else
      :items="decisions"
      :enabled="decisions.length > 4"
      :estimate-item-height="176"
      max-height="min(42vh, 420px)"
      label="待確認的 Agent 自主決策清單"
    >
      <template #default="{ item }">
        <article class="agent-decisions__item" data-testid="agent-decision-item">
          <div class="agent-decisions__meta">
            <UiLabel tone="attention">Agent 自主決策</UiLabel>
            <span>{{
              projectsStore.projects.find((project) => project.id === item.projectId)?.name ?? "Tracked project"
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
              {{ item.sessionTitle ?? "開啟來源 Session" }}
            </UiButton>
            <div class="agent-decisions__actions">
              <UiButton size="sm" :icon="Check" @click="review(item, 'confirmed')">確認</UiButton>
              <UiButton size="sm" :icon="X" @click="review(item, 'rejected')">拒絕</UiButton>
              <UiButton size="sm" variant="primary" :icon="BookOpen" @click="promote(item)">整理成 Knowledge</UiButton>
            </div>
          </div>
        </article>
      </template>
    </VirtualList>
  </UiBox>
</template>

<style scoped>
.agent-decisions {
  margin-bottom: var(--space-4);
}

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
