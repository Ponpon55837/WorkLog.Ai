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
import { t } from "../../i18n";

const props = defineProps<{ detail: SessionDetail }>();
const emit = defineEmits<{ restoreRecord: [target: VoidTarget] }>();

const session = computed(() => props.detail.session);
const redactionCount = computed(() => session.value.redactionCount ?? 0);
const agentLabel = computed(() =>
  [session.value.agentClient, session.value.agentModel].filter((part): part is string => Boolean(part)).join(" · "),
);
const verification = computed(() => verificationStatus[verificationOf(session.value)]);
const sessionTarget = computed<VoidTarget>(() => ({
  type: "session",
  id: session.value.id,
  sessionId: session.value.id,
  title: session.value.title,
}));
</script>

<template>
  <UiFlash v-if="session.voided" tone="attention" :title="t('session.thisSessionIsVoided')">
    {{
      t("session.hiddenFromTheWorkHistory", {
        reason: session.voided.reason,
        date: formatDate(session.voided.at),
      })
    }}
    <template #actions
      ><UiButton size="sm" :icon="RotateCcw" @click="emit('restoreRecord', sessionTarget)">{{
        t("session.restore")
      }}</UiButton></template
    >
  </UiFlash>
  <p class="session-panel__summary">{{ formatReadableSummary(session.summary) }}</p>
  <p v-if="redactionCount > 0" class="session-panel__redaction" role="status">
    {{ t("session.sensitiveValuesRedacted", { redactionCount }) }}
  </p>

  <dl class="session-panel__meta">
    <dt>{{ t("common.project") }}</dt>
    <dd>
      <span>{{ detail.project.name }}</span>
      <code class="session-panel__path">{{ detail.project.rootPath }}</code>
    </dd>
    <dt>{{ t("common.agent") }}</dt>
    <dd>
      <span v-if="agentLabel">{{ agentLabel }}</span>
      <span v-else class="session-panel__muted">{{ t("common.notReported") }}</span>
    </dd>
    <dt>{{ t("session.started") }}</dt>
    <dd>
      <template v-if="session.startedAt">
        <time :datetime="session.startedAt">{{ formatDate(session.startedAt) }}</time>
        <span class="session-panel__muted">{{
          t("session.took", { value: formatDuration(session.startedAt, session.completedAt) })
        }}</span>
      </template>
      <span v-else class="session-panel__muted">{{ t("common.notReported") }}</span>
    </dd>
    <dt>{{ t("common.completed") }}</dt>
    <dd>
      <time :datetime="session.completedAt">{{
        t("session.dateWithRelative", {
          value: formatDate(session.completedAt),
          value2: formatRelative(session.completedAt),
        })
      }}</time>
    </dd>
    <dt>{{ t("session.lastUpdated") }}</dt>
    <dd>
      <time v-if="wasUpdatedAfterFinalize(session)" :datetime="session.updatedAt">{{
        t("session.dateWithRelative", {
          value: formatDate(session.updatedAt),
          value2: formatRelative(session.updatedAt),
        })
      }}</time>
      <span v-else class="session-panel__muted">{{ t("session.notModifiedAfterCompletion") }}</span>
    </dd>
    <dt>{{ t("session.executionStatus") }}</dt>
    <dd><StatusLabel :status="executionStatusVisual" /></dd>
    <dt>{{ t("labels.verification") }}</dt>
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
