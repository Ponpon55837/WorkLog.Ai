<script setup lang="ts">
import { computed } from "vue";
import { CalendarRange, CircleCheckBig, FolderGit2 } from "lucide-vue-next";
import type { WorkReport, WorkSessionRecord } from "@work-intelligence/core";
import UiBarChart from "../ui/UiBarChart.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiMeter from "../ui/UiMeter.vue";
import UiSplitLayout from "../ui/UiSplitLayout.vue";
import type { Tone } from "../ui/types";
import VirtualList from "../VirtualList.vue";
import SessionRow from "./SessionRow.vue";
import { buildReportBuckets, buildReportProjectShares, reportBucketMode, reportBucketUnits } from "../../utils/report";
import { t } from "../../i18n";

/**
 * The period-specific part of the report overview, built only from deterministic report data: a daily
 * report lists its Sessions, longer periods break down into their sub-periods; both show project shares.
 */
const props = defineProps<{ report: WorkReport }>();
const emit = defineEmits<{ open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]]; showAll: [] }>();

const dayLimit = 8;
/** The stacked share bar colors its largest projects; the unfilled rest of the track is everyone else. */
const shareTones: readonly Tone[] = ["accent", "done", "neutral"];
/** Above this many columns the numbers above the bars would collide; the value table still lists them. */
const valueLabelLimit = 8;

const unit = computed(() => {
  const mode = reportBucketMode(props.report);
  return mode ? reportBucketUnits[mode] : null;
});
const buckets = computed(() => buildReportBuckets(props.report));
const busiest = computed(() =>
  buckets.value.reduce<(typeof buckets.value)[number] | null>(
    (best, bucket) => (bucket.sessions > (best?.sessions ?? 0) ? bucket : best),
    null,
  ),
);
const bucketSummary = computed(() => {
  const current = unit.value;
  const top = busiest.value;
  if (!current || !top) {
    return "";
  }
  const active = buckets.value.filter((bucket) => bucket.sessions > 0).length;
  return t("reports.busiestSessionsWorkCompletedIn", {
    label: top.label,
    sessions: top.sessions,
    length: buckets.value.length,
    unit: current.unit,
    active,
  });
});
const daySessions = computed(() => props.report.sessions.slice(0, dayLimit));
const shares = computed(() => buildReportProjectShares(props.report));
const busiestIndex = computed(() => buckets.value.findIndex((bucket) => bucket.key === busiest.value?.key));
const bucketChart = computed(() => ({
  labels: buckets.value.map((bucket) => bucket.label),
  series: [
    {
      name: t("reports.seriesSessions"),
      tone: "accent" as const,
      values: buckets.value.map((bucket) => bucket.sessions),
    },
    { name: t("reports.seriesEvents"), tone: "neutral" as const, values: buckets.value.map((bucket) => bucket.events) },
  ],
}));
const shareSegments = computed(() =>
  shares.value.slice(0, shareTones.length).map((share, index) => ({
    value: share.sessions,
    tone: shareTones[index] ?? "neutral",
    label: share.label,
  })),
);
const shareSummary = computed(() => {
  const [top] = shares.value;
  return top && shares.value.length > 1 ? t("reports.mostly", { label: top.label, percent: top.percent }) : "";
});

function shareSwatch(index: number): string {
  return shareTones[index] ?? "open";
}
</script>

<template>
  <UiSplitLayout data-testid="report-breakdown">
    <template #main>
      <UiBox v-if="!unit">
        <template #header>
          <UiBoxTitle :title="t('reports.workCompletedThatDay')" :count="report.totals.sessions" />
        </template>
        <UiEmptyState
          v-if="daySessions.length === 0"
          compact
          :icon="CircleCheckBig"
          :title="t('reports.noWorkCompletedThisDay')"
        />
        <VirtualList
          v-else
          :items="daySessions"
          :enabled="daySessions.length > 4"
          :estimate-item-height="88"
          max-height="min(56vh, 560px)"
          :label="t('reports.workCompletedThatDayList')"
        >
          <template #default="{ item: session }">
            <SessionRow :session="session" :show-summary="false" @open="emit('open', $event, report.sessions)" />
          </template>
        </VirtualList>
        <template v-if="report.sessions.length > dayLimit" #footer>
          <UiButton variant="invisible" size="sm" @click="emit('showAll')">
            {{ t("reports.seeAllSessionsInRaw", { length: report.sessions.length }) }}
          </UiButton>
        </template>
      </UiBox>

      <UiBox v-else>
        <template #header>
          <UiBoxTitle :icon="CalendarRange" :title="unit.title" />
          <span v-if="bucketSummary" class="report-breakdown__muted">{{ bucketSummary }}</span>
        </template>
        <UiEmptyState v-if="!busiest" compact :icon="CalendarRange" :title="t('reports.noWorkCompletedInThis')" />
        <UiBarChart
          v-else
          compact
          legend
          :show-values="buckets.length <= valueLabelLimit"
          :highlight="busiestIndex"
          :labels="bucketChart.labels"
          :series="bucketChart.series"
          :label="t('reports.reportPeriodDistributionList')"
        />
        <p v-if="busiest" class="report-breakdown__busiest">
          <UiLabel tone="accent">{{ t("reports.busiest") }}</UiLabel>
          {{ busiest.label }} ·
          {{ t("reports.sessionsEvents", { sessionCount: busiest.sessions, eventCount: busiest.events }) }}
        </p>
      </UiBox>
    </template>

    <template #aside>
      <UiBox>
        <template #header>
          <UiBoxTitle :icon="FolderGit2" :title="t('reports.projectShare')" :count="shares.length" />
          <span v-if="shareSummary" class="report-breakdown__muted">{{ shareSummary }}</span>
        </template>
        <UiEmptyState v-if="shares.length === 0" compact :icon="FolderGit2" :title="t('reports.noProjectData')" />
        <template v-else>
          <div class="report-breakdown__stack">
            <UiMeter :max="report.totals.sessions" :segments="shareSegments" />
          </div>
          <VirtualList
            :items="shares"
            :enabled="true"
            :estimate-item-height="44"
            max-height="min(56vh, 560px)"
            :label="t('reports.reportProjectShareList')"
          >
            <template #default="{ item: share, index }">
              <div class="report-breakdown__share">
                <i
                  :class="['report-breakdown__swatch', `report-breakdown__swatch--${shareSwatch(index)}`]"
                  aria-hidden="true"
                />
                <span class="report-breakdown__name" :title="share.label">{{ share.label }}</span>
                <span class="report-breakdown__figures">{{
                  t("reports.sessions", { sessions: share.sessions, percent: share.percent })
                }}</span>
              </div>
            </template>
          </VirtualList>
        </template>
      </UiBox>
    </template>
  </UiSplitLayout>
</template>

<style scoped>
.report-breakdown__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.report-breakdown__busiest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.report-breakdown__stack {
  padding: 0 var(--space-4) var(--space-2);
}

.report-breakdown__stack :deep(.ui-meter) {
  margin-top: var(--space-3);
}

.report-breakdown__share {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
  font-size: var(--text-sm);
}

.report-breakdown__swatch {
  flex: none;
  width: 10px;
  height: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
}

.report-breakdown__swatch--accent {
  border-color: var(--accent);
  background: var(--accent);
}

.report-breakdown__swatch--done {
  border-color: var(--done);
  background: var(--done);
}

.report-breakdown__swatch--neutral {
  border-color: var(--fg-subtle);
  background: var(--fg-subtle);
}

/* Projects past the colored ones fill the unfilled rest of the bar: an open swatch. */
.report-breakdown__swatch--open {
  background: transparent;
}

.report-breakdown__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-breakdown__figures {
  flex: none;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
</style>
