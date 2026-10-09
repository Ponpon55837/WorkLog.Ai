<script setup lang="ts">
import { computed } from "vue";
import type { ReportMetricComparison, WorkReport, WorkSessionRecord } from "@work-intelligence/core";
import ReportPeriodBreakdown from "./ReportPeriodBreakdown.vue";
import SynthesisCard from "./SynthesisCard.vue";
import VerificationBreakdown from "./VerificationBreakdown.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import { formatReadableSummary } from "../../utils/format";
import { t } from "../../i18n";

const { report, reportComparisons } = defineProps<{
  report: WorkReport;
  reportComparisons: Array<{ key: string; label: string; comparison: ReportMetricComparison; foot: string }>;
}>();
const emit = defineEmits<{
  open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]];
  "show-all": [];
}>();

const verificationCounts = computed(() => ({
  passed: report.totals.verification.passed,
  failed: report.totals.verification.failed,
  inProgress: report.totals.verification.in_progress,
  notRun: report.totals.verification.not_run,
  notSupplied: report.totals.verification.not_supplied,
}));

function openSession(session: WorkSessionRecord, list: readonly WorkSessionRecord[]): void {
  emit("open", session, list);
}
</script>

<template>
  <section id="report-panel-overview" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-overview">
    <SynthesisCard />
    <div class="reports__stats">
      <UiStatCard
        v-for="item in reportComparisons"
        :key="item.key"
        :label="item.label"
        :value="item.comparison.current"
        :delta="{
          direction: item.comparison.direction,
          text:
            item.comparison.direction === 'flat'
              ? t('reports.sameAsPreviousPeriod')
              : t('reports.vsPreviousPeriod', { value: Math.abs(item.comparison.delta) }),
        }"
        :foot="item.foot"
      />
      <UiStatCard
        :label="t('labels.verification')"
        :value="verificationCounts.passed"
        :suffix="t('reports.passed', { sessions: report.totals.sessions })"
      >
        <VerificationBreakdown :counts="verificationCounts" />
      </UiStatCard>
    </div>
    <ReportPeriodBreakdown :report="report" @open="openSession" @show-all="emit('show-all')" />
    <UiBox padded>
      <template #header>
        <UiBoxTitle eyebrow="Period summary" :title="t('reports.whatHappenedInThisPeriod')" />
        <span class="reports__muted">{{
          t("reports.comparisonPeriod", { from: report.previousRange.from, to: report.previousRange.to })
        }}</span>
      </template>
      <p class="reports__summary">{{ formatReadableSummary(report.periodSummary) }}</p>
    </UiBox>
  </section>
</template>

<style scoped>
.reports__panel {
  display: grid;
  gap: var(--space-4);
}

.reports__panel > .ui-box + .ui-box {
  margin-top: 0;
}

.reports__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.reports__summary {
  line-height: 1.7;
  white-space: pre-line;
}

.reports__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

@media (max-width: 1279px) {
  .reports__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
