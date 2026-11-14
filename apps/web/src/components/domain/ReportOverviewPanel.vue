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
import UiButton from "../ui/UiButton.vue";
import { formatReadableSummary, formatTimeOfDay, formatWeekdayTime } from "../../utils/format";
import { t } from "../../i18n";

const { report, reportComparisons } = defineProps<{
  report: WorkReport;
  reportComparisons: Array<{ key: string; label: string; comparison: ReportMetricComparison; foot: string }>;
}>();
const emit = defineEmits<{
  open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]];
  "show-all": [];
}>();

const happeningLimit = 8;

const verificationCounts = computed(() => ({
  passed: report.totals.verification.passed,
  failed: report.totals.verification.failed,
  inProgress: report.totals.verification.in_progress,
  notRun: report.totals.verification.not_run,
  notSupplied: report.totals.verification.not_supplied,
}));

/** The most recently completed Sessions in time order; the report's own period summary line stays above them. */
const happenings = computed(() =>
  [...report.sessions]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, happeningLimit)
    .reverse(),
);

function momentLabel(completedAt: string): string {
  return report.period === "day" ? formatTimeOfDay(completedAt) : formatWeekdayTime(completedAt);
}

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
    <UiBox>
      <template #header>
        <UiBoxTitle :title="t('reports.whatHappenedInThisPeriod')" />
        <span class="reports__muted">{{
          t("reports.comparisonPeriod", { from: report.previousRange.from, to: report.previousRange.to })
        }}</span>
      </template>
      <p class="reports__summary">{{ formatReadableSummary(report.periodSummary) }}</p>
      <ol v-if="happenings.length > 0" class="reports__happenings">
        <li v-for="session in happenings" :key="session.id">
          <time :datetime="session.completedAt">{{ momentLabel(session.completedAt) }}</time>
          <span>{{ session.title }}</span>
        </li>
      </ol>
      <template v-if="report.sessions.length > happeningLimit" #footer>
        <UiButton variant="invisible" size="sm" @click="emit('show-all')">
          {{ t("reports.seeAllSessionsInRaw", { length: report.sessions.length }) }}
        </UiButton>
      </template>
    </UiBox>
  </UiStack>
</template>

<style scoped>
.reports__summary {
  padding: var(--space-3) var(--space-4);
  line-height: 1.7;
  white-space: pre-line;
}

.reports__happenings {
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border-muted);
  list-style: none;
}

.reports__happenings li {
  display: grid;
  grid-template-columns: 13em minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
  font-size: var(--text-sm);
}

.reports__happenings li:first-child {
  border-top: 0;
}

.reports__happenings time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}

.reports__happenings span {
  overflow-wrap: anywhere;
}

@media (max-width: 639px) {
  .reports__happenings li {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}

.reports__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
