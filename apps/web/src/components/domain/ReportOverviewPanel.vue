<script setup lang="ts">
import { computed } from "vue";
import type { ReportMetricComparison, WorkReport, WorkSessionRecord } from "@work-intelligence/core";
import ReportPeriodBreakdown from "./ReportPeriodBreakdown.vue";
import SynthesisCard from "./SynthesisCard.vue";
import VerificationBreakdown from "./VerificationBreakdown.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiStack from "../ui/UiStack.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import UiStatGrid from "../ui/UiStatGrid.vue";
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
  <UiStack id="report-panel-overview" tag="section" role="tabpanel" aria-labelledby="report-tab-overview">
    <SynthesisCard />
    <UiStatGrid>
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
    </UiStatGrid>
    <ReportPeriodBreakdown :report="report" @open="openSession" @show-all="emit('show-all')" />
    <UiBox padded>
      <template #header>
        <UiBoxTitle :title="t('reports.whatHappenedInThisPeriod')" />
        <span class="reports__muted">{{
          t("reports.comparisonPeriod", { from: report.previousRange.from, to: report.previousRange.to })
        }}</span>
      </template>
      <p class="reports__summary">{{ formatReadableSummary(report.periodSummary) }}</p>
    </UiBox>
  </UiStack>
</template>

<style scoped>
.reports__summary {
  line-height: 1.7;
  white-space: pre-line;
}

.reports__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
