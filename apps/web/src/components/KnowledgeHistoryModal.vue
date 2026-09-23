<script setup lang="ts">
import { useKnowledge } from "../composables/useKnowledge";
import { formatDate } from "../utils/format";
import { knowledgeAuditActionLabels } from "../utils/labels";
import BaseModal from "./BaseModal.vue";

const {
  knowledgeHistoryItem,
  knowledgeHistory,
  knowledgeHistoryLoading,
  knowledgeHistoryError,
  closeKnowledgeHistory,
  knowledgeAuditFields
} = useKnowledge();
</script>

<template>
  <BaseModal :open="Boolean(knowledgeHistoryItem)" ariaLabel="Knowledge 變更紀錄" panel-class="knowledge-history-modal" @close="closeKnowledgeHistory">
    <template v-if="knowledgeHistoryItem">
      <header class="detail-modal-header">
        <div>
          <div class="eyebrow">KNOWLEDGE AUDIT HISTORY</div>
          <h2>變更紀錄</h2>
          <p class="knowledge-editor-project">{{ knowledgeHistoryItem.title }}</p>
        </div>
        <button class="close-button" type="button" aria-label="關閉 Knowledge 變更紀錄" @click="closeKnowledgeHistory">×</button>
      </header>
      <div class="detail-modal-content knowledge-history-content">
        <p class="knowledge-editor-note">這裡顯示中央 registry 保存的前後狀態快照；不會讀取來源 repo，也不會重新推論內容。</p>
        <section v-if="knowledgeHistoryLoading" class="loading-state knowledge-history-loading"><div class="spinner"></div><p>正在載入變更紀錄…</p></section>
        <div v-else-if="knowledgeHistoryError" class="alert error-alert" role="alert">{{ knowledgeHistoryError }}</div>
        <div v-else-if="knowledgeHistory.length" class="knowledge-history-list">
          <article v-for="entry in knowledgeHistory" :key="entry.id" class="knowledge-history-entry">
            <div :class="['knowledge-history-marker', `knowledge-history-marker-${entry.action}`]">{{ knowledgeAuditActionLabels[entry.action].slice(0, 1) }}</div>
            <div class="knowledge-history-entry-body">
              <div class="knowledge-history-heading">
                <div><strong>{{ knowledgeAuditActionLabels[entry.action] }} Knowledge</strong><span>{{ knowledgeAuditFields(entry) }}</span></div>
                <time>{{ formatDate(entry.occurredAt) }}</time>
              </div>
              <div class="knowledge-history-snapshots">
                <div v-if="entry.before" class="knowledge-history-snapshot">
                  <span>變更前</span>
                  <strong>{{ entry.before.title }}</strong>
                  <p>{{ entry.before.body }}</p>
                </div>
                <div class="knowledge-history-snapshot knowledge-history-snapshot-current">
                  <span>{{ entry.before ? '變更後' : '初始內容' }}</span>
                  <strong>{{ entry.after.title }}</strong>
                  <p>{{ entry.after.body }}</p>
                </div>
              </div>
            </div>
          </article>
        </div>
        <div v-else class="empty-state large-empty knowledge-history-empty"><div class="empty-icon">↺</div><strong>尚無變更紀錄</strong><p>這筆 Knowledge 可能是在 audit history 功能加入前建立，目前只會從下一次變更開始追蹤。</p></div>
      </div>
    </template>
  </BaseModal>
</template>
