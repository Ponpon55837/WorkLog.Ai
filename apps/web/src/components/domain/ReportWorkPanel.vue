<script setup lang="ts">
import { computed } from "vue";
import { CircleCheckBig } from "lucide-vue-next";
import type { ReportSpanningSession, WorkReport, WorkSessionRecord } from "@work-intelligence/core";
import SessionRow from "./SessionRow.vue";
import VerificationBreakdown from "./VerificationBreakdown.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiGroupLabel from "../ui/UiGroupLabel.vue";
import VirtualList from "../VirtualList.vue";
import { formatDate } from "../../utils/format";

type SpanningListRow =
  | { kind: "group"; key: string; title: string }
  | { kind: "session"; key: string; sessionId: string; title: string; meta: string };

const { report } = defineProps<{ report: WorkReport }>();
const emit = defineEmits<{
  open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]];
  "open-report-session": [sessionId: string | undefined];
}>();

const verificationCounts = computed(() => ({
  passed: report.totals.verification.passed,
  failed: report.totals.verification.failed,
  notRun: report.totals.verification.not_run,
  notSupplied: report.totals.verification.not_supplied,
}));
const spanningGroups = computed(() => {
  const spanning = report.spanning;
  const project = (item: ReportSpanningSession) => (item.projectName ? `${item.projectName} · ` : "");
  return [
    {
      key: "startedEarlier",
      title: "更早開始、在這段期間完成",
      items: spanning.startedEarlier,
      meta: (item: ReportSpanningSession) => `${project(item)}開始於 ${formatDate(item.startedAt ?? item.completedAt)}`,
    },
    {
      key: "continuedLater",
      title: "在這段期間開始、之後才完成",
      items: spanning.continuedLater,
      meta: (item: ReportSpanningSession) =>
        `${project(item)}開始於 ${formatDate(item.startedAt ?? item.completedAt)} · 完成於 ${formatDate(item.completedAt)}`,
    },
    {
      key: "updatedInPeriod",
      title: "更早完成、在這段期間修改",
      items: spanning.updatedInPeriod,
      meta: (item: ReportSpanningSession) =>
        `${project(item)}完成於 ${formatDate(item.completedAt)} · 更新於 ${formatDate(item.updatedAt)}`,
    },
  ];
});
const spanningCount = computed(() => spanningGroups.value.reduce((total, group) => total + group.items.length, 0));
const spanningRows = computed<SpanningListRow[]>(() => {
  const rows: SpanningListRow[] = [];
  for (const group of spanningGroups.value) {
    if (group.items.length === 0) continue;
    rows.push({ kind: "group", key: `${group.key}-heading`, title: group.title });
    for (const item of group.items) {
      rows.push({
        kind: "session",
        key: `${group.key}-${item.id}`,
        sessionId: item.id,
        title: item.title,
        meta: group.meta(item),
      });
    }
  }
  return rows;
});

function openCompletedSession(session: WorkSessionRecord): void {
  emit("open", session, report.completedWork);
}
</script>

<template>
  <section
    id="report-panel-work"
    class="reports__panel reports__grid"
    role="tabpanel"
    aria-labelledby="report-tab-work"
  >
    <UiBox sticky-header>
      <template #header
        ><UiBoxTitle eyebrow="Completed work" title="主要完成事項" :count="report.totals.sessions"
      /></template>
      <UiEmptyState
        v-if="report.completedWork.length === 0"
        compact
        :icon="CircleCheckBig"
        title="這段期間沒有完成工作"
      />
      <VirtualList
        v-else
        :items="report.completedWork"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="112"
        label="報表完成事項清單"
      >
        <template #default="{ item: session }">
          <SessionRow :session="session" @open="openCompletedSession" />
        </template>
      </VirtualList>
    </UiBox>
    <div class="reports__side">
      <UiBox padded>
        <template #header><UiBoxTitle eyebrow="Verification" title="驗證狀態" /></template>
        <VerificationBreakdown :counts="verificationCounts" />
        <p class="reports__note">
          未回報代表沒有結構化 verification；未執行代表 Agent 明確表示尚未驗證。報告不會替 Agent 推測驗證結果。
        </p>
      </UiBox>
      <UiBox v-if="spanningCount > 0" data-testid="report-spanning">
        <template #header><UiBoxTitle eyebrow="Across periods" title="跨期工作" :count="spanningCount" /></template>
        <VirtualList
          :items="spanningRows"
          :enabled="true"
          fit-viewport
          fit-viewport-to-panel
          :estimate-item-height="64"
          label="跨期工作清單"
        >
          <template #default="{ item }">
            <UiGroupLabel v-if="item.kind === 'group'">{{ item.title }}</UiGroupLabel>
            <UiBoxRow
              v-else
              clickable
              :title="item.title"
              :meta="item.meta"
              @select="emit('open-report-session', item.sessionId)"
            />
          </template>
        </VirtualList>
        <p class="reports__spanning-note">數字只計算這段期間完成的 Session；這裡列出跨越期間邊界的工作，不重複計算。</p>
      </UiBox>
    </div>
  </section>
</template>

<style scoped>
.reports__panel {
  display: grid;
  gap: var(--space-4);
}

.reports__grid {
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  align-items: start;
}

.reports__side {
  display: grid;
  gap: var(--space-4);
  align-content: start;
  min-width: 0;
}

.reports__side > .ui-box + .ui-box {
  margin-top: 0;
}

.reports__spanning-note {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.reports__note,
.reports__row-detail {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.reports__note {
  margin-top: var(--space-3);
  font-size: var(--text-xs);
}

.reports__row-detail {
  margin-top: var(--space-1);
}

@media (max-width: 959px) {
  .reports__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
