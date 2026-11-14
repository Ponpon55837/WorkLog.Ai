<script setup lang="ts">
import { computed } from "vue";
import { ChartColumn, FolderGit2 } from "lucide-vue-next";
import type { WorkReport } from "@work-intelligence/core";
import UiBarChart from "../ui/UiBarChart.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiMeter from "../ui/UiMeter.vue";
import UiSplitLayout from "../ui/UiSplitLayout.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import UiStatGrid from "../ui/UiStatGrid.vue";
import type { Tone } from "../ui/types";
import VirtualList from "../VirtualList.vue";
import { formatReportTrendLabel } from "../../utils/format";
import { t } from "../../i18n";

const { report } = defineProps<{ report: WorkReport }>();

const trend = computed(() => ({
  labels: report.trends.map((point) => formatReportTrendLabel(point.date, report.trendGranularity)),
  series: [
    { name: "Sessions", tone: "accent" as const, values: report.trends.map((point) => point.sessions) },
    { name: "Events", tone: "done" as const, values: report.trends.map((point) => point.events) },
  ],
}));

const dailySessionBuckets = computed(() => {
  const buckets = [
    { label: "00:00–03:59", count: 0 },
    { label: "04:00–07:59", count: 0 },
    { label: "08:00–11:59", count: 0 },
    { label: "12:00–15:59", count: 0 },
    { label: "16:00–19:59", count: 0 },
    { label: "20:00–23:59", count: 0 },
  ];
  const hourFormatter = new Intl.DateTimeFormat("en", { timeZone: report.timezone, hour: "2-digit", hourCycle: "h23" });
  for (const session of report.sessions) {
    const hour = Number(
      hourFormatter.formatToParts(new Date(session.completedAt)).find((part) => part.type === "hour")?.value,
    );
    if (Number.isFinite(hour) && hour >= 0 && hour < 24) {
      const bucket = buckets[Math.floor(hour / 4)];
      if (bucket) bucket.count += 1;
    }
  }
  return buckets;
});
const dailySessionPeak = computed(() => Math.max(1, ...dailySessionBuckets.value.map((bucket) => bucket.count)));

function bucketSegments(bucket: { label: string; count: number }): { value: number; tone: Tone; label: string }[] {
  return [{ value: bucket.count, tone: "accent", label: bucket.label }];
}
</script>

<template>
  <UiSplitLayout id="report-panel-trend" role="tabpanel" aria-labelledby="report-tab-trend">
    <template #main>
      <UiBox>
        <template #header><UiBoxTitle :title="t('reports.workRhythm')" /></template>
        <div v-if="report.period === 'day'" class="reports__day-trend">
          <UiStatGrid :columns="2">
            <UiStatCard :label="t('reports.sessionsCompletedThatDay')" :value="report.totals.sessions" />
            <UiStatCard :label="t('reports.eventsThatDay')" :value="report.totals.events" value-tone="success" />
          </UiStatGrid>
          <p class="reports__note">{{ t("reports.bySessionCompletionTimeTime", { timezone: report.timezone }) }}</p>
          <UiStatGrid v-if="report.sessions.length > 0" :columns="3">
            <UiStatCard
              v-for="bucket in dailySessionBuckets"
              :key="bucket.label"
              compact
              :label="bucket.label"
              :value="t('reports.records', { count: bucket.count })"
            >
              <UiMeter size="sm" :max="dailySessionPeak" :segments="bucketSegments(bucket)" />
            </UiStatCard>
          </UiStatGrid>
          <UiEmptyState
            v-else
            compact
            :icon="ChartColumn"
            :title="t('reports.noSessionsCompletedThatDay')"
            :description="t('reports.theDaySTotalEvents')"
          />
          <p class="reports__note">
            {{ t("reports.eventsCurrentlyShowTheWhole")
            }}<template v-if="report.sessionTruncation.currentPeriod">
              {{ t("reports.theTimeDistributionIsLimited") }}</template
            >
          </p>
        </div>
        <UiBarChart
          v-else
          :labels="trend.labels"
          :series="trend.series"
          :label="t('reports.completedSessionsAndEventsPer')"
        />
      </UiBox>
    </template>
    <template #aside>
      <UiBox>
        <template #header
          ><UiBoxTitle :title="t('reports.projectDistribution')" :count="report.projects.length"
        /></template>
        <UiEmptyState
          v-if="report.projects.length === 0"
          compact
          :icon="FolderGit2"
          :title="t('reports.noProjectData')"
        />
        <VirtualList
          v-else
          :items="report.projects"
          :enabled="true"
          fit-viewport
          fit-viewport-to-panel
          :estimate-item-height="72"
          :label="t('reports.reportProjectDistributionList')"
        >
          <template #default="{ item: project }">
            <UiBoxRow
              :title="project.projectName"
              :meta="
                t('reports.sessionsEvents', {
                  sessionCount: project.sessionCount,
                  eventCount: project.eventCount,
                })
              "
            >
              <template #leading><FolderGit2 :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
              <template #trailing
                ><UiLabel>{{ t("reports.sources", { length: project.sourceSessionIds.length }) }}</UiLabel></template
              >
            </UiBoxRow>
          </template>
        </VirtualList>
      </UiBox>
    </template>
  </UiSplitLayout>
</template>

<style scoped>
.reports__day-trend {
  padding: var(--space-4);
}

.reports__note {
  margin-top: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
