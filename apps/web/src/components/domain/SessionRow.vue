<script setup lang="ts">
import { computed } from "vue";
import { Ban, FileDiff } from "lucide-vue-next";
import type { WorkSessionRecord } from "@work-intelligence/core";
import {
  formatClock,
  formatDate,
  formatReadableSummary,
  formatRelative,
  wasUpdatedAfterFinalize,
} from "../../utils/format";
import { verificationOf, verificationStatus } from "../../utils/status";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiLabel from "../ui/UiLabel.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

/**
 * One Session in any list (Sessions, Dashboard, Reports). Selecting it opens the SessionPanel.
 * `timeline` is the Work history layout: the time of day on the left, a rail whose dot shows the verification
 * result, the summary on its own single line, and `createdKnowledge` (Knowledge created from this Session).
 */
const props = withDefaults(
  defineProps<{ session: WorkSessionRecord; showSummary?: boolean; timeline?: boolean; createdKnowledge?: number }>(),
  { showSummary: true, timeline: false, createdKnowledge: 0 },
);
const emit = defineEmits<{ open: [session: WorkSessionRecord] }>();

const verification = computed(() => verificationStatus[verificationOf(props.session)]);
const firstOutcome = computed(
  () => props.session.workSummary?.outcomes[0] ?? formatReadableSummary(props.session.summary).split("\n")[0],
);
</script>

<template>
  <UiBoxRow
    :class="{ 'session-row--timeline': timeline }"
    clickable
    data-testid="session-row"
    @select="emit('open', session)"
  >
    <template #leading>
      <template v-if="timeline">
        <time class="session-row__time" :datetime="session.completedAt">{{ formatClock(session.completedAt) }}</time>
        <span class="session-row__rail" aria-hidden="true"
          ><span :class="['session-row__dot', `session-row__dot--${verification.tone}`]"></span
        ></span>
      </template>
      <component
        :is="verification.icon"
        v-else
        :size="16"
        :stroke-width="1.75"
        :class="`tone-${verification.tone}`"
        :aria-label="`Verification ${verification.label}`"
      />
    </template>
    <template #title>{{ session.title }}</template>
    <template #meta>
      <span>{{ session.projectName }}</span>
      <template v-if="!timeline">
        ·
        <time :datetime="session.completedAt" :title="formatDate(session.completedAt)">{{
          formatRelative(session.completedAt)
        }}</time>
      </template>
      <template v-if="wasUpdatedAfterFinalize(session)">
        ·
        <time
          :datetime="session.updatedAt"
          :title="t('session.lastUpdatedAt', { value: formatDate(session.updatedAt) })"
          >{{ t("common.updated", { value: formatRelative(session.updatedAt) }) }}</time
        ></template
      >
      <template v-if="session.gitBranch"> · {{ session.gitBranch }}</template>
      <template v-if="timeline && session.agentClient"> · {{ session.agentClient }}</template>
      <template v-if="timeline && createdKnowledge > 0">
        ·
        <span class="session-row__knowledge">{{ t("sessions.newKnowledge", { count: createdKnowledge }) }}</span>
      </template>
      <template v-if="!timeline && showSummary && firstOutcome"> · {{ firstOutcome }}</template>
    </template>
    <p v-if="timeline && showSummary && firstOutcome" class="session-row__summary" :title="firstOutcome">
      {{ firstOutcome }}
    </p>
    <template #trailing>
      <UiLabel v-if="session.voided" tone="danger" :icon="Ban">{{ t("session.voidedLabel") }}</UiLabel>
      <StatusLabel :status="verification" :show-icon="false" />
      <UiLabel class="hide-sm" :icon="FileDiff">{{ session.changedFiles.length }}</UiLabel>
    </template>
  </UiBoxRow>
</template>

<style scoped>
.tone-success {
  color: var(--success);
}
.tone-danger {
  color: var(--danger);
}
.tone-attention {
  color: var(--attention);
}
.tone-neutral {
  color: var(--fg-muted);
}

/* Timeline layout. The rail is stretched over the row padding so the line joins the rows of one day. */
.session-row--timeline :deep(.ui-box-row__leading) {
  align-self: stretch;
  gap: var(--space-2);
  padding-top: 0;
}

.session-row--timeline :deep(.ui-box-row__main) {
  display: flex;
  flex-direction: column;
}

.session-row--timeline :deep(.ui-box-row__meta) {
  order: 2;
}

.session-row__time {
  flex: 0 0 auto;
  min-width: 3.25rem;
  padding-top: 1px;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.session-row__rail {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  width: 12px;
  margin: calc(-1 * var(--space-3)) 0;
}

.session-row__rail::before {
  content: "";
  position: absolute;
  inset: 0 auto;
  width: 1px;
  background: var(--border);
}

.session-row__dot {
  position: relative;
  box-sizing: border-box;
  align-self: flex-start;
  width: 10px;
  height: 10px;
  margin-top: calc(var(--space-3) + 4px);
  border: 2px solid var(--fg-muted);
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
}

.session-row__dot--success {
  border-color: var(--success);
}
.session-row__dot--danger {
  border-color: var(--danger);
  background: var(--danger);
}
.session-row__dot--attention {
  border-color: var(--attention);
}
.session-row__dot--accent {
  border-color: var(--accent);
}

.session-row__summary {
  order: 1;
  margin-top: 2px;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row__knowledge {
  color: var(--accent);
  font-weight: 500;
}

@media (max-width: 639px) {
  .session-row__time {
    min-width: 2.75rem;
    font-size: var(--text-xs);
  }
}
</style>
