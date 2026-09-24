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
import SessionRow from "./SessionRow.vue";
import { buildReportBuckets, buildReportProjectShares, reportBucketUnits } from "../../utils/report";

/**
 * The period-specific part of the report overview, built only from deterministic report data: a daily
 * report lists its Sessions, longer periods break down into their sub-periods; both show project shares.
 */
const props = defineProps<{ report: WorkReport }>();
const emit = defineEmits<{ open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]]; showAll: [] }>();

const dayLimit = 8;

const unit = computed(() => (props.report.period === "day" ? null : reportBucketUnits[props.report.period]));
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
  return `最多：${top.label}（${top.sessions} 個 Session）· ${buckets.value.length} ${current.unit}中有 ${active} ${current.unit}完成工作`;
});
const daySessions = computed(() => props.report.sessions.slice(0, dayLimit));
const shares = computed(() => buildReportProjectShares(props.report));
const shareSummary = computed(() => {
  const [top] = shares.value;
  return top && shares.value.length > 1 ? `以 ${top.label} 為主（${top.percent}%）` : "";
});

function barWidth(value: number, max: number): string {
  return max ? `${(value / max) * 100}%` : "0%";
}
</script>

<template>
  <div class="report-breakdown" data-testid="report-breakdown">
    <UiBox v-if="!unit">
      <template #header>
        <UiBoxTitle eyebrow="Completed work" title="當日完成的工作" :count="report.totals.sessions" />
      </template>
      <UiEmptyState v-if="daySessions.length === 0" compact :icon="CircleCheckBig" title="這一天沒有完成工作" />
      <SessionRow
        v-for="session in daySessions"
        :key="session.id"
        :session="session"
        :show-summary="false"
        @open="emit('open', $event, report.sessions)"
      />
      <template v-if="report.sessions.length > dayLimit" #footer>
        <UiButton variant="invisible" size="sm" @click="emit('showAll')">
          在原始紀錄查看全部 {{ report.sessions.length }} 個 Session
        </UiButton>
      </template>
    </UiBox>

    <UiBox v-else>
      <template #header>
        <UiBoxTitle :icon="CalendarRange" :eyebrow="unit.eyebrow" :title="unit.title" />
        <span v-if="bucketSummary" class="report-breakdown__muted">{{ bucketSummary }}</span>
      </template>
      <UiEmptyState v-if="!busiest" compact :icon="CalendarRange" title="這段期間沒有完成工作" />
      <template v-else>
        <UiBoxRow
          v-for="bucket in buckets"
          :key="bucket.key"
          :title="bucket.label"
          :meta="`${bucket.sessions} 個 Session · ${bucket.events} 個事件`"
        >
          <template #labels>
            <UiLabel v-if="bucket.key === busiest.key" tone="accent">最多</UiLabel>
          </template>
          <span class="report-breakdown__bar" aria-hidden="true"
            ><i :style="{ width: barWidth(bucket.sessions, busiest.sessions) }"></i
          ></span>
        </UiBoxRow>
      </template>
    </UiBox>

    <UiBox>
      <template #header>
        <UiBoxTitle :icon="FolderGit2" eyebrow="Projects" title="專案占比" :count="shares.length" />
        <span v-if="shareSummary" class="report-breakdown__muted">{{ shareSummary }}</span>
      </template>
      <UiEmptyState v-if="shares.length === 0" compact :icon="FolderGit2" title="沒有專案資料" />
      <UiBoxRow
        v-for="share in shares"
        :key="share.key"
        :title="share.label"
        :meta="`${share.sessions} 個 Session · ${share.percent}%`"
      >
        <span class="report-breakdown__bar" aria-hidden="true"><i :style="{ width: `${share.percent}%` }"></i></span>
      </UiBoxRow>
    </UiBox>
  </div>
</template>

<style scoped>
.report-breakdown {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  align-items: start;
  gap: var(--space-4);
}

/* UiBox stacks consecutive boxes with a top margin; side by side in this grid they must stay aligned. */
.report-breakdown > .ui-box + .ui-box {
  margin-top: 0;
}

.report-breakdown__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.report-breakdown__bar {
  display: block;
  height: 6px;
  margin-top: var(--space-2);
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
}

.report-breakdown__bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}

@media (max-width: 959px) {
  .report-breakdown {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
