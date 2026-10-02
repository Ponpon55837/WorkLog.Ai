<script setup lang="ts">
import { computed } from "vue";
import type { Hotspot } from "@work-intelligence/core";
import { formatDate, formatRelative } from "../../utils/format";
import { hotspotRiskVisual, HOTSPOT_HIGH_FAILURE_RATE, verificationStatus } from "../../utils/status";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

/** Most changed files or directories: a bar for the Session count and a labelled failure share. */
const props = withDefaults(defineProps<{ items: readonly Hotspot[]; showProject?: boolean; label: string }>(), {
  showProject: false,
});
const emit = defineEmits<{ "open-session": [sessionId: string] }>();

const maxCount = computed(() => Math.max(1, ...props.items.map((item) => item.sessionCount)));
const legend = [
  hotspotRiskVisual({ sessionCount: 1, failedCount: 1 }),
  hotspotRiskVisual({ sessionCount: 2, failedCount: 0.1 }),
  hotspotRiskVisual({ sessionCount: 1, failedCount: 0 }),
];
const legendNotes = [
  t("graph.failedAtLeastPercent", { value: HOTSPOT_HIGH_FAILURE_RATE * 100 }),
  t("graph.failedAboveZero"),
  t("graph.noFailures"),
];

function failureText(item: Hotspot): string {
  const rate = Math.round((item.failedCount / item.sessionCount) * 100);
  const notRun = item.notRunCount > 0 ? t("graph.notRun", { notRunCount: item.notRunCount }) : "";
  return t("graph.failed", { failedCount: item.failedCount, rate, notRun });
}
</script>

<template>
  <div class="hotspots">
    <p class="hotspots__legend" :aria-label="t('graph.hotspotLegend')">
      <span>{{ t("graph.barSessionsThatChangedIt") }}</span>
      <span v-for="(visual, index) in legend" :key="visual.label">
        <StatusLabel :status="visual" /> {{ legendNotes[index] }}
      </span>
    </p>
    <ol class="hotspots__list" :aria-label="label">
      <li v-for="item in items" :key="`${item.projectId}:${item.path}`" class="hotspots__item" data-testid="hotspot">
        <div class="hotspots__head">
          <code class="hotspots__path">{{ item.path }}</code>
          <StatusLabel :status="hotspotRiskVisual(item)" />
        </div>
        <div class="hotspots__bar" aria-hidden="true">
          <i
            :class="`tone-${hotspotRiskVisual(item).tone}`"
            :style="{ width: `${(item.sessionCount / maxCount) * 100}%` }"
          />
        </div>
        <p class="hotspots__meta">
          <span v-if="showProject">{{ item.projectName }} · </span>
          <strong>{{ t("graph.sessions", { sessionCount: item.sessionCount }) }}</strong>
          {{ t("graph.lastModified", { value: failureText(item) }) }}
          <time :datetime="item.lastChangedAt" :title="formatDate(item.lastChangedAt)">{{
            formatRelative(item.lastChangedAt)
          }}</time>
        </p>
        <details class="hotspots__sessions">
          <summary>{{ t("graph.lastSessions", { length: item.recentSessions.length }) }}</summary>
          <ul>
            <li v-for="session in item.recentSessions" :key="session.id">
              <button type="button" class="hotspots__session" @click="emit('open-session', session.id)">
                {{ session.title }}
              </button>
              <StatusLabel :status="verificationStatus[session.verificationStatus]" :show-icon="false" />
              <time :datetime="session.completedAt">{{ formatRelative(session.completedAt) }}</time>
            </li>
          </ul>
        </details>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.hotspots__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.hotspots__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.hotspots__item {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.hotspots__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.hotspots__path {
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.hotspots__bar {
  height: 6px;
  border-radius: 3px;
  background: var(--border-muted);
}

.hotspots__bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: currentColor;
}

.hotspots__bar .tone-danger {
  color: var(--danger);
}

.hotspots__bar .tone-attention {
  color: var(--attention);
}

.hotspots__bar .tone-success {
  color: var(--success);
}

.hotspots__meta {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.hotspots__meta strong {
  color: var(--fg);
}

.hotspots__sessions summary {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}

.hotspots__sessions ul {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
}

.hotspots__sessions li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.hotspots__sessions time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.hotspots__session {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.hotspots__session:hover {
  text-decoration: underline;
}
</style>
