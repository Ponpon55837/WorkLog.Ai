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
import UiStatCard from "../ui/UiStatCard.vue";
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

function dailyBucketWidth(count: number): string {
  return count === 0 ? "0%" : Math.max(5, (count / dailySessionPeak.value) * 100) + "%";
}
</script>

<template>
  <section
    id="report-panel-trend"
    class="reports__panel reports__grid"
    role="tabpanel"
    aria-labelledby="report-tab-trend"
  >
    <UiBox>
      <template #header><UiBoxTitle eyebrow="Activity trend" :title="t('工作節奏')" /></template>
      <div v-if="report.period === 'day'" class="reports__day-trend">
        <div class="reports__day-stats">
          <UiStatCard :label="t('當日完成 Sessions')" :value="report.totals.sessions" />
          <UiStatCard :label="t('當日 Events')" :value="report.totals.events" value-tone="success" />
        </div>
        <p class="reports__note">{{ t("依 Session 完成時間分布 · {timezone} 時區", { timezone: report.timezone }) }}</p>
        <ol v-if="report.sessions.length > 0" class="reports__day-buckets">
          <li v-for="bucket in dailySessionBuckets" :key="bucket.label" class="reports__day-bucket">
            <div class="reports__day-bucket-label">
              <span>{{ bucket.label }}</span>
              <strong>{{ t("{count} 筆", { count: bucket.count }) }}</strong>
            </div>
            <div class="reports__day-bucket-track" aria-hidden="true">
              <span :style="{ width: dailyBucketWidth(bucket.count) }"></span>
            </div>
          </li>
        </ol>
        <UiEmptyState
          v-else
          compact
          :icon="ChartColumn"
          :title="t('當日沒有完成的 Session')"
          :description="t('上方仍會顯示當日 Events 總數。')"
        />
        <p class="reports__note">
          {{ t("Events 目前顯示整日總數，尚未按時段拆分。")
          }}<template v-if="report.sessionTruncation.currentPeriod">
            {{ t("時段分布受報表 200 筆 Session 上限影響。") }}</template
          >
        </p>
      </div>
      <UiBarChart v-else :labels="trend.labels" :series="trend.series" :label="t('每期完成 Session 與事件數')" />
    </UiBox>
    <UiBox>
      <template #header
        ><UiBoxTitle eyebrow="Project breakdown" :title="t('專案分布')" :count="report.projects.length"
      /></template>
      <UiEmptyState v-if="report.projects.length === 0" compact :icon="FolderGit2" :title="t('沒有專案資料')" />
      <VirtualList
        v-else
        :items="report.projects"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="72"
        :label="t('報表專案分布清單')"
      >
        <template #default="{ item: project }">
          <UiBoxRow
            :title="project.projectName"
            :meta="
              t('{sessionCount} 個 Session · {eventCount} 個事件', {
                sessionCount: project.sessionCount,
                eventCount: project.eventCount,
              })
            "
          >
            <template #leading><FolderGit2 :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
            <template #trailing
              ><UiLabel>{{ t("{length} 個來源", { length: project.sourceSessionIds.length }) }}</UiLabel></template
            >
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
  </section>
</template>

<style scoped>
.reports__panel {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  align-items: start;
}

.reports__panel > .ui-box + .ui-box {
  margin-top: 0;
}

.reports__day-trend {
  padding: var(--space-4);
}

.reports__day-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.reports__day-buckets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.reports__day-bucket {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.reports__day-bucket-label {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.reports__day-bucket-label strong {
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.reports__day-bucket-track {
  height: 6px;
  margin-top: var(--space-2);
  overflow: hidden;
  border-radius: 999px;
  background: var(--border-muted);
}

.reports__day-bucket-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
}

.reports__note {
  margin-top: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 959px) {
  .reports__panel {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 639px) {
  .reports__day-buckets {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
