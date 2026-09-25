<script setup lang="ts">
import { History, X } from "lucide-vue-next";
import { useKnowledge } from "../../composables/useKnowledge";
import { formatDate, formatRelative } from "../../utils/format";
import { knowledgeAuditActionLabels } from "../../utils/labels";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";

const {
  knowledgeHistoryItem,
  knowledgeHistory,
  knowledgeHistoryLoading,
  knowledgeHistoryError,
  closeKnowledgeHistory,
  knowledgeAuditFields,
} = useKnowledge();
const actionTone = { created: "success", updated: "accent", archived: "neutral", restored: "done" } as const;
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
