<script setup lang="ts">
import { computed } from "vue";
import { CalendarRange, CircleCheckBig, FolderGit2 } from "lucide-vue-next";
import type { WorkReport, WorkSessionRecord } from "@work-intelligence/core";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
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
const shareSummary = computed(() => {
  const [top] = shares.value;
  return top && shares.value.length > 1 ? t("reports.mostly", { label: top.label, percent: top.percent }) : "";
});

function bucketSegments(bucket: { label: string; sessions: number }): { value: number; tone: Tone; label: string }[] {
  return [{ value: bucket.sessions, tone: "accent", label: bucket.label }];
}

function shareSegments(share: { label: string; percent: number }): { value: number; tone: Tone; label: string }[] {
  return [{ value: share.percent, tone: "accent", label: share.label }];
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
        <template v-else>
          <VirtualList
            :items="buckets"
            :enabled="true"
            :estimate-item-height="76"
            max-height="min(56vh, 560px)"
            :label="t('reports.reportPeriodDistributionList')"
          >
            <template #default="{ item: bucket }">
              <UiBoxRow
                :title="bucket.label"
                :meta="t('reports.sessionEventCounts', { sessions: bucket.sessions, events: bucket.events })"
              >
                <template #labels>
                  <UiLabel v-if="bucket.key === busiest.key" tone="accent">{{ t("reports.busiest") }}</UiLabel>
                </template>
                <UiMeter size="sm" :max="busiest.sessions" :segments="bucketSegments(bucket)" />
              </UiBoxRow>
            </template>
          </VirtualList>
        </template>
      </UiBox>
    </template>

    <template #aside>
      <UiBox>
        <template #header>
          <UiBoxTitle :icon="FolderGit2" :title="t('reports.projectShare')" :count="shares.length" />
          <span v-if="shareSummary" class="report-breakdown__muted">{{ shareSummary }}</span>
        </template>
        <UiEmptyState v-if="shares.length === 0" compact :icon="FolderGit2" :title="t('reports.noProjectData')" />
        <VirtualList
          v-else
          :items="shares"
          :enabled="true"
          :estimate-item-height="72"
          max-height="min(56vh, 560px)"
          :label="t('reports.reportProjectShareList')"
        >
          <template #default="{ item: share }">
            <UiBoxRow
              :title="share.label"
              :meta="t('reports.sessions', { sessions: share.sessions, percent: share.percent })"
            >
              <UiMeter size="sm" :max="100" :segments="shareSegments(share)" />
            </UiBoxRow>
          </template>
        </VirtualList>
      </UiBox>
    </template>
  </UiSplitLayout>
</template>

<style scoped>
.report-breakdown__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
