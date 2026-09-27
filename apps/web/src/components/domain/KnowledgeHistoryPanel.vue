<script setup lang="ts">
import { ExternalLink, History, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { useKnowledgeActions } from "../../composables/useKnowledge";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate, formatRelative } from "../../utils/format";
import { knowledgeAuditActionLabels } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";

const { knowledgeHistoryItem, closeKnowledgeHistory, knowledgeAuditFields } = useKnowledgeActions();
const { knowledgeHistory, knowledgeFeedback, knowledgeHistoryLoading, knowledgeHistoryError } =
  storeToRefs(useKnowledgeStore());
const sessionsStore = useSessionsStore();
const actionTone = { created: "success", updated: "accent", archived: "neutral", restored: "done" } as const;
const feedbackVisual = {
  applied: { tone: "success", label: "Session 確認" },
  manual_confirm: { tone: "done", label: "手動確認" },
  contradicted: { tone: "danger", label: "Session 推翻" },
} as const;

function openFeedbackSession(sessionId: string): void {
  // The Session panel is also a modal side panel; close this one so focus moves cleanly.
  closeKnowledgeHistory();
  void sessionsStore.openSessionDetail(sessionId, "無法載入確認或推翻這筆 Knowledge 的 Session。");
}
</script>

<template>
  <UiSidePanel
    :open="Boolean(knowledgeHistoryItem)"
    label="Knowledge 變更紀錄"
    :width="640"
    storage-key="knowledge-history"
    @close="closeKnowledgeHistory"
  >
    <template #header>
      <div class="history__top">
        <span class="history__eyebrow">Knowledge audit history</span>
        <UiIconButton :icon="X" label="關閉 Knowledge 變更紀錄" @click="closeKnowledgeHistory" />
      </div>
      <h2 class="history__title">{{ knowledgeHistoryItem?.title }}</h2>
      <p class="history__note">顯示中央 registry 保存的前後快照；不會讀取來源 repo，也不會重新推論內容。</p>
    </template>

    <UiDisclosure
      v-if="!knowledgeHistoryLoading && knowledgeFeedback.length > 0"
      class="history__feedback"
      title="確認與推翻"
      :count="knowledgeFeedback.length"
      hint="Session 套用後回報仍有效、回報已不成立，或在這裡手動確認的紀錄"
      open
    >
      <ul class="history__feedback-list" data-testid="knowledge-feedback">
        <li v-for="entry in knowledgeFeedback" :key="entry.id">
          <UiLabel :tone="feedbackVisual[entry.kind].tone">{{ feedbackVisual[entry.kind].label }}</UiLabel>
          <UiButton
            v-if="entry.sessionId"
            size="sm"
            variant="invisible"
            :icon="ExternalLink"
            @click="openFeedbackSession(entry.sessionId)"
            >{{ entry.sessionTitle ?? `Session ${entry.sessionId.slice(0, 8)}` }}</UiButton
          >
          <time :datetime="entry.occurredAt" :title="formatDate(entry.occurredAt)">{{
            formatRelative(entry.occurredAt)
          }}</time>
        </li>
      </ul>
    </UiDisclosure>
    <UiSkeleton v-if="knowledgeHistoryLoading" variant="text" :count="4" />
    <UiFlash v-else-if="knowledgeHistoryError" tone="danger">{{ knowledgeHistoryError }}</UiFlash>
    <UiEmptyState
      v-else-if="knowledgeHistory.length === 0"
      compact
      :icon="History"
      title="尚無變更紀錄"
      description="這筆 Knowledge 可能在 audit history 功能加入前建立，會從下一次變更開始追蹤。"
    />
    <VirtualList
      v-else
      class="history__list"
      :items="knowledgeHistory"
      :enabled="true"
      :estimate-item-height="320"
      max-height="min(64vh, 680px)"
      label="Knowledge 變更紀錄清單"
    >
      <template #default="{ item: entry }">
        <article class="history__entry">
          <div class="history__entry-head">
            <UiLabel :tone="actionTone[entry.action]">{{ knowledgeAuditActionLabels[entry.action] }}</UiLabel>
            <span class="history__fields">{{ knowledgeAuditFields(entry) }}</span>
            <time :datetime="entry.occurredAt" :title="formatDate(entry.occurredAt)">{{
              formatRelative(entry.occurredAt)
            }}</time>
          </div>
          <div class="history__snapshots">
            <div v-if="entry.before" class="history__snapshot">
              <span class="history__snapshot-label">變更前</span>
              <strong>{{ entry.before.title }}</strong>
              <p>{{ entry.before.body }}</p>
            </div>
            <div class="history__snapshot history__snapshot--after">
              <span class="history__snapshot-label">{{ entry.before ? "變更後" : "初始內容" }}</span>
              <strong>{{ entry.after.title }}</strong>
              <p>{{ entry.after.body }}</p>
            </div>
          </div>
        </article>
      </template>
    </VirtualList>
  </UiSidePanel>
</template>

<style scoped>
.history__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.history__eyebrow {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.history__title {
  margin-top: var(--space-2);
  font-size: var(--text-xl);
  font-weight: 600;
}

.history__note {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.history__feedback {
  margin-bottom: var(--space-3);
}

.history__feedback-list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.history__feedback-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.history__feedback-list time {
  margin-inline-start: auto;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.history__list {
  margin: 0;
  padding: 0;
}

.history__list :deep(.virtual-list-item) {
  padding-block: var(--space-2);
}

.history__entry-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.history__fields {
  flex: 1;
}

.history__snapshots {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.history__snapshot {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  font-size: var(--text-sm);
}

.history__snapshot--after {
  border-color: var(--border);
}

.history__snapshot-label {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.history__snapshot p {
  color: var(--fg-muted);
  white-space: pre-line;
}
</style>
