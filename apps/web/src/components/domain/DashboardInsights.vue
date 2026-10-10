<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ArrowRight, ChartColumn } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { useDashboardStore } from "../../stores/dashboard";
import { dashboardInsights } from "../../utils/dashboard-insights";
import { t } from "../../i18n";

/** Renders two deterministic weekly insights with scoped report navigation. */
const store = useDashboardStore();
const { weekReport, weekReportLoaded, weekReportFailed } = storeToRefs(store);
const insight = computed(() =>
  weekReport.value && !weekReportFailed.value ? dashboardInsights(weekReport.value) : null,
);
const reportLink = computed(() => ({ name: "reports", query: { period: "week", date: weekReport.value?.range.from } }));
const projectLink = computed(() => ({
  ...reportLink.value,
  query: { ...reportLink.value.query, project: insight.value?.topProject?.id },
}));
const activityText = computed(() => {
  const i = insight.value;
  if (!i) return "";
  const change =
    i.previous === 0
      ? t("insights.noPrevious")
      : i.delta === 0
        ? t("insights.flat")
        : t(i.delta > 0 ? "insights.up" : "insights.down", { count: Math.abs(i.delta) });
  return i.topProject
    ? t("insights.activityProject", {
        count: i.sessions,
        change,
        project: i.topProject.name,
        share: i.topProject.share,
      })
    : t("insights.activity", { count: i.sessions, change });
});
const verificationText = computed(() => {
  const i = insight.value;
  if (!i) return "";
  if (i.verification === "failed") return t("insights.failed", { count: i.count });
  if (i.verification === "in_progress") return t("insights.inProgress", { count: i.count });
  if (i.verification === "incomplete")
    return t("insights.incomplete", { notSupplied: i.notSupplied, notRun: i.notRun });
  return t("insights.passed", { count: i.count });
});
</script>
<template>
  <UiBox data-testid="dashboard-insights">
    <template #header
      ><UiBoxTitle eyebrow="This week" :title="t('insights.title')" /><UiButton
        size="sm"
        variant="invisible"
        :trailing-icon="ArrowRight"
        :to="reportLink"
        >{{ t("dashboard.thisWeekSReport") }}</UiButton
      ></template
    >
    <UiFlash v-if="weekReportFailed" tone="danger"
      >{{ t("insights.failedToLoad")
      }}<template #actions
        ><UiButton size="sm" @click="store.loadDashboardData()">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiSkeleton v-else-if="!weekReportLoaded" variant="text" :count="2" :label="t('insights.loading')" />
    <UiEmptyState
      v-else-if="!insight || insight.sessions === 0"
      compact
      :icon="ChartColumn"
      :title="t('insights.empty')"
      ><template #action
        ><UiButton :to="{ name: 'sessions' }">{{ t("dashboard.allSessions") }}</UiButton></template
      ></UiEmptyState
    >
    <div v-else class="dashboard-insights__content">
      <p class="dashboard-insights__range">
        {{
          t("insights.range", {
            from: weekReport!.range.from,
            to: weekReport!.range.to,
            timezone: weekReport!.timezone,
          })
        }}
      </p>
      <p>
        {{ activityText }}
        <UiButton v-if="insight.topProject" size="sm" variant="invisible" :to="projectLink">{{
          t("insights.projectReport")
        }}</UiButton>
      </p>
      <p :class="{ 'dashboard-insights__attention': insight.verification !== 'passed' }">
        {{ verificationText }}
        <UiButton size="sm" variant="invisible" :to="reportLink">{{ t("insights.verificationReport") }}</UiButton>
      </p>
    </div>
  </UiBox>
</template>
<style scoped>
.dashboard-insights__content {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
  overflow-wrap: anywhere;
}
.dashboard-insights__content p {
  margin: 0;
}
.dashboard-insights__range {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.dashboard-insights__attention {
  color: var(--fg-attention);
}
</style>
