<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useSessionDetail } from "../composables/useSessionDetail";
import { eventDetails, formatDate, formatKnowledgeTags, formatReadableSummary } from "../utils/format";
import {
  changedFileChangeStatusLabels,
  changedFileSourceLabel,
  executionStatusLabels,
  knowledgeKindLabels,
  verificationLabels,
  workSummarySectionLabels
} from "../utils/labels";
import BaseModal from "./BaseModal.vue";

const { selectedDetail, closeSessionDetail } = useSessionDetail();
const detailModalContent = ref<HTMLElement | null>(null);

watch(selectedDetail, async (detail) => {
  if (detail) {
    await nextTick();
    detailModalContent.value?.scrollTo({ top: 0, behavior: "auto" });
  }
});
</script>

<template>
  <BaseModal :open="Boolean(selectedDetail)" ariaLabel="Session Detail" @close="closeSessionDetail">
    <template v-if="selectedDetail">
      <header class="detail-modal-header">
        <div class="eyebrow">SESSION DETAIL / {{ selectedDetail.session.status.toUpperCase() }}</div>
        <button class="close-button" type="button" aria-label="關閉" @click="closeSessionDetail()">×</button>
      </header>
      <div ref="detailModalContent" class="detail-modal-content">
        <h2>{{ selectedDetail.session.title }}</h2>
        <div class="detail-project"><span class="project-avatar small">{{ selectedDetail.project.name.slice(0, 1).toUpperCase() }}</span><div><strong>{{ selectedDetail.project.name }}</strong><span>{{ selectedDetail.project.rootPath }}</span></div></div>
        <p class="detail-summary">{{ formatReadableSummary(selectedDetail.session.summary) }}</p>
        <div v-if="selectedDetail.session.workSummary" class="detail-section structured-work-summary" data-testid="session-work-summary">
          <div class="eyebrow">WORK SUMMARY</div>
          <div class="work-summary-grid">
            <article v-for="section in workSummarySectionLabels" :key="section.key" class="work-summary-section">
              <span>{{ section.label }}</span>
              <ul v-if="selectedDetail.session.workSummary[section.key].length">
                <li v-for="item in selectedDetail.session.workSummary[section.key]" :key="item">{{ item }}</li>
              </ul>
              <em v-else>—</em>
            </article>
          </div>
        </div>
        <div class="detail-facts">
          <div><span>執行狀態 Execution</span><strong>{{ executionStatusLabels[selectedDetail.session.executionStatus] }}</strong></div>
          <div><span>完成時間 Completed</span><strong>{{ formatDate(selectedDetail.session.completedAt) }}</strong></div>
          <div><span>Git commit（可選）</span><strong>{{ selectedDetail.session.commitSha ? selectedDetail.session.commitSha.slice(0, 8) : '未要求' }}</strong></div>
          <div><span>驗證 Verification</span><strong :class="['detail-verification', `verification-${selectedDetail.session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabels[selectedDetail.session.verification?.status ?? 'not_supplied'] }}</strong></div>
        </div>
        <div class="detail-section"><div class="eyebrow">EVENT TIMELINE</div><div v-for="event in selectedDetail.events" :key="event.id" class="detail-event"><span class="event-type">{{ event.type }}</span><div><strong>{{ event.summary }}</strong><small>{{ formatDate(event.occurredAt) }} <span v-if="event.details">· {{ eventDetails(event.details) }}</span></small></div></div></div>
        <div v-if="selectedDetail.evidence.length" class="detail-section"><div class="eyebrow">ATTACHED EVIDENCE</div><div class="detail-evidence-list"><div v-for="item in selectedDetail.evidence" :key="item.id" class="detail-evidence-item"><div><strong>{{ item.kind }}</strong><small>{{ formatDate(item.capturedAt) }}</small></div><p v-if="item.summary">{{ item.summary }}</p><code>{{ item.reference }}</code></div></div></div>
        <div v-if="selectedDetail.knowledge.length" class="detail-section"><div class="eyebrow">LINKED KNOWLEDGE</div><div class="detail-knowledge-list"><article v-for="item in selectedDetail.knowledge" :key="item.id" class="detail-knowledge-item"><div class="detail-knowledge-heading"><strong>{{ item.title }}</strong><span>{{ knowledgeKindLabels[item.kind] }}</span></div><p>{{ item.body }}</p><small v-if="item.tags.length">{{ formatKnowledgeTags(item.tags) }}</small></article></div></div>
        <div v-if="selectedDetail.rawSnapshots.length" class="detail-section"><div class="eyebrow">RAW HANDOFF SNAPSHOT</div><pre class="snapshot">{{ selectedDetail.rawSnapshots[0]?.content }}</pre></div>
        <div class="detail-section">
          <div class="eyebrow">CHANGED FILES</div>
          <div class="file-list">
            <div v-for="file in selectedDetail.session.changedFiles" :key="file" class="file-list-item"><code>{{ file }}</code><span class="file-source">來源：{{ changedFileSourceLabel(selectedDetail.session, file) }}</span></div>
            <span v-if="!selectedDetail.session.changedFiles.length" class="muted">尚未提供檔案 metadata</span>
          </div>
          <div v-if="selectedDetail.session.changedFileChanges.length" class="file-change-history">
            <div class="eyebrow">FILE HISTORY</div>
            <div class="file-list">
              <div v-for="change in selectedDetail.session.changedFileChanges" :key="`${change.status}-${change.previousPath ?? ''}-${change.path}`" class="file-list-item file-change-history-item"><code>{{ change.status === 'renamed' ? `${change.previousPath} → ${change.path}` : change.path }}</code><span class="file-source">{{ changedFileChangeStatusLabels[change.status] }}</span></div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </BaseModal>
</template>
