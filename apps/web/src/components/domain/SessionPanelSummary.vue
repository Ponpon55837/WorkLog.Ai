<script setup lang="ts">
import { computed } from "vue";
import { RotateCcw } from "lucide-vue-next";
import type { SessionDetail } from "@work-intelligence/core";
import type { VoidTarget } from "../../composables/useRecordVoid";
import {
  formatDate,
  formatDuration,
  formatReadableSummary,
  formatRelative,
  wasUpdatedAfterFinalize,
} from "../../utils/format";
import { executionStatusVisual, verificationOf, verificationStatus } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import StatusLabel from "./StatusLabel.vue";
import WorkSummarySections from "./WorkSummarySections.vue";

const props = defineProps<{ detail: SessionDetail }>();
const emit = defineEmits<{ restoreRecord: [target: VoidTarget] }>();

const session = computed(() => props.detail.session);
const redactionCount = computed(() => session.value.redactionCount ?? 0);
const verification = computed(() => verificationStatus[verificationOf(session.value)]);
const sessionTarget = computed<VoidTarget>(() => ({
  type: "session",
  id: session.value.id,
  sessionId: session.value.id,
  title: session.value.title,
}));
</script>

<template>
  <UiFlash v-if="session.voided" tone="attention" title="這筆 Session 已作廢">
    {{ session.voided.reason }}（{{ formatDate(session.voided.at) }}）。不會出現在工作歷程、報告、圖譜與 Agent 檢索。
    <template #actions
      ><UiButton size="sm" :icon="RotateCcw" @click="emit('restoreRecord', sessionTarget)">還原</UiButton></template
    >
  </UiFlash>
  <p class="session-panel__summary">{{ formatReadableSummary(session.summary) }}</p>
  <p v-if="redactionCount > 0" class="session-panel__redaction" role="status">已遮蔽 {{ redactionCount }} 處敏感資訊</p>

  <dl class="session-panel__meta">
    <dt>專案</dt>
    <dd>
      <span>{{ detail.project.name }}</span>
      <code class="session-panel__path">{{ detail.project.rootPath }}</code>
    </dd>
    <dt>開始時間</dt>
    <dd>
      <template v-if="session.startedAt">
        <time :datetime="session.startedAt">{{ formatDate(session.startedAt) }}</time>
        <span class="session-panel__muted">耗時 {{ formatDuration(session.startedAt, session.completedAt) }}</span>
      </template>
      <span v-else class="session-panel__muted">未回報</span>
    </dd>
    <dt>完成時間</dt>
    <dd>
      <time :datetime="session.completedAt"
        >{{ formatDate(session.completedAt) }}（{{ formatRelative(session.completedAt) }}）</time
      >
    </dd>
    <dt>最後更新</dt>
    <dd>
      <time v-if="wasUpdatedAfterFinalize(session)" :datetime="session.updatedAt"
        >{{ formatDate(session.updatedAt) }}（{{ formatRelative(session.updatedAt) }}）</time
      >
      <span v-else class="session-panel__muted">完成後未修改</span>
    </dd>
    <dt>執行狀態</dt>
    <dd><StatusLabel :status="executionStatusVisual" /></dd>
    <dt>Verification</dt>
    <dd>
      <StatusLabel :status="verification" />
      <span v-if="session.verification?.summary" class="session-panel__muted">{{ session.verification.summary }}</span>
    </dd>
  </dl>

  <WorkSummarySections :summary="session.workSummary" />
</template>

<style scoped>
.session-panel__summary {
  color: var(--fg);
  font-size: var(--text-lg);
  line-height: 1.6;
  white-space: pre-line;
}

.session-panel__redaction {
  margin: calc(var(--space-2) * -1) 0 var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.session-panel__meta {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  margin: 0;
  font-size: var(--text-sm);
}

.session-panel__meta dt {
  color: var(--fg-muted);
}

.session-panel__meta dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
}

.session-panel__path {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.session-panel__muted {
  color: var(--fg-muted);
}

@media (max-width: 639px) {
  .session-panel__meta {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .session-panel__meta dd {
    margin-bottom: var(--space-2);
  }
}
</style>
