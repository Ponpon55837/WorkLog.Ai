<script setup lang="ts">
import { computed, watch } from "vue";
import {
  ArrowRight,
  ChartColumn,
  CircleCheckBig,
  FolderGit2,
  Inbox,
  ListChecks,
  RotateCcw,
  ShieldCheck,
} from "lucide-vue-next";
import type { WorkSessionRecord } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import SessionRow from "../components/domain/SessionRow.vue";
import StatusLabel from "../components/domain/StatusLabel.vue";
import VerificationBreakdown from "../components/domain/VerificationBreakdown.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiCopyButton from "../components/ui/UiCopyButton.vue";
import UiCounter from "../components/ui/UiCounter.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiSparkline from "../components/ui/UiSparkline.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { useDashboard, type InboxItem } from "../composables/useDashboard";
import { metadataBackfillInstruction } from "../composables/useMetadataBackfill";
import { useProjects } from "../composables/useProjects";
import { reportSynthesisInstruction, useReports } from "../composables/useReports";
import { useSessionDetail } from "../composables/useSessionDetail";
import { router } from "../router";
import { formatRelative } from "../utils/format";
import { requestStatus, trackingStatus } from "../utils/status";

const { dashboard, projects, recentSessions } = useProjects();
const { weekReport, weekVerification, inbox, ensureDashboardData } = useDashboard();
const { openSessionDetail, setSessionSequence } = useSessionDetail();

// App loads dashboard data at startup and on header refresh; only refetch here when it is stale.
useViewLoader(ensureDashboardData);

const today = new Intl.DateTimeFormat("zh-TW", { dateStyle: "full" }).format(new Date());
const pausedCount = computed(() => projects.value.filter((project) => project.status === "paused").length);
const visibleProjects = computed(() =>
  [...projects.value].sort((a, b) => Number(b.status === "tracked") - Number(a.status === "tracked")).slice(0, 6),
);
const weekTrend = computed(() => weekReport.value?.trends.map((point) => point.sessions) ?? []);
const weekDelta = computed(() => {
  const comparison = weekReport.value?.comparison.sessions;
  if (!comparison) {
    return undefined;
  }
  const text = comparison.direction === "flat" ? "與上週相同" : `${Math.abs(comparison.delta)} vs 上週`;
  return { direction: comparison.direction, text };
});

function openSession(session: WorkSessionRecord): void {
  void openSessionDetail(session.id);
}

/** Opens the report scope of a synthesis request so the retry/cancel actions live in one place. */
async function openRequest(item: InboxItem): Promise<void> {
  if (item.kind === "backfill") {
    await router.push({ name: "projects", params: { tab: "backfill" } });
    return;
  }
  const reports = useReports();
  reports.reportPeriod.value = item.request.period;
  reports.reportDate.value = item.request.range.from;
  reports.reportProjectId.value = item.request.projectId ?? "";
  await router.push({
    name: "reports",
    query: {
      period: item.request.period,
      date: item.request.range.from,
      ...(item.request.projectId ? { project: item.request.projectId } : {}),
    },
  });
}

watch(recentSessions, (items) => setSessionSequence(items.map((item) => item.id)), { immediate: true });
</script>

<template>
  <PageHeader :description="`${today} · ${dashboard.trackedProjects} 個專案記錄中`">
    <template #actions>
      <UiButton :icon="ChartColumn" :to="{ name: 'reports' }">本週報告</UiButton>
      <UiButton :icon="ListChecks" :to="{ name: 'sessions' }">全部 Sessions</UiButton>
    </template>
  </PageHeader>

  <div class="dashboard__stats">
    <UiStatCard
      label="記錄中專案"
      :icon="FolderGit2"
      :value="dashboard.trackedProjects"
      :foot="`explicit opt-in${pausedCount ? ` · ${pausedCount} 個已暫停` : ''}`"
    />
    <UiStatCard
      label="本週完成 Sessions"
      :icon="CircleCheckBig"
      :value="weekReport?.totals.sessions ?? 0"
      :delta="weekDelta"
    >
      <UiSparkline v-if="weekTrend.length" :values="weekTrend" label="本週每日完成 Session 數" />
      <template #foot>不等同 Git commit · 累計 {{ dashboard.finalizedSessions }}</template>
    </UiStatCard>
    <UiStatCard
      label="本週 Verification"
      :icon="ShieldCheck"
      :value="weekVerification.passed"
      :suffix="`/ ${weekVerification.total} 通過`"
    >
      <VerificationBreakdown :counts="weekVerification" />
    </UiStatCard>
    <UiStatCard
      label="待處理"
      :icon="Inbox"
      :value="inbox.length"
      :value-tone="inbox.length ? 'attention' : undefined"
      :foot="inbox.length ? '等待 Agent 或需要重試' : '全部處理完畢'"
    />
  </div>

  <div class="dashboard__grid">
    <div class="dashboard__main">
      <UiBox>
        <template #header>
          <UiBoxTitle eyebrow="Action required" title="需要處理" />
          <UiCounter v-if="inbox.length" :count="inbox.length" tone="attention" />
        </template>
        <UiEmptyState
          v-if="inbox.length === 0"
          compact
          :icon="CircleCheckBig"
          title="全部處理完畢"
          description="沒有等待 Agent 的報告整理或 metadata 回補請求。"
        />
        <UiBoxRow v-for="item in inbox" :key="`${item.kind}-${item.request.id}`" :title="item.title" :meta="item.meta">
          <template #leading>
            <component
              :is="requestStatus[item.request.status].icon"
              :size="16"
              :stroke-width="1.75"
              :class="`tone-${requestStatus[item.request.status].tone}`"
              aria-hidden="true"
            />
          </template>
          <template #labels><StatusLabel :status="requestStatus[item.request.status]" :show-icon="false" /></template>
          <template #trailing>
            <UiCopyButton
              v-if="item.request.status !== 'failed'"
              size="sm"
              label="複製 Agent 指令"
              :text="item.kind === 'synthesis' ? reportSynthesisInstruction : metadataBackfillInstruction"
              success-message="已複製自然語言指令。"
            />
            <UiButton v-else size="sm" :icon="RotateCcw" @click="openRequest(item)">前往重試</UiButton>
            <UiButton size="sm" variant="invisible" :trailing-icon="ArrowRight" @click="openRequest(item)"
              >前往</UiButton
            >
          </template>
        </UiBoxRow>
      </UiBox>

      <UiBox>
        <template #header>
          <UiBoxTitle eyebrow="Latest memory" title="最近完成的工作" />
          <UiButton size="sm" variant="invisible" :trailing-icon="ArrowRight" :to="{ name: 'sessions' }"
            >查看全部</UiButton
          >
        </template>
        <UiEmptyState
          v-if="recentSessions.length === 0"
          compact
          :icon="ListChecks"
          title="還沒有工作紀錄"
          description="先到專案頁加入一個專案，並明確切換為「記錄中」。"
        >
          <template #action><UiButton :to="{ name: 'projects' }">前往專案</UiButton></template>
        </UiEmptyState>
        <SessionRow v-for="session in recentSessions" :key="session.id" :session="session" @open="openSession" />
      </UiBox>
    </div>

    <UiBox>
      <template #header>
        <UiBoxTitle eyebrow="Projects" title="專案狀態" />
        <UiButton size="sm" variant="invisible" :to="{ name: 'projects' }">管理</UiButton>
      </template>
      <UiEmptyState v-if="projects.length === 0" compact :icon="FolderGit2" title="尚未加入專案" />
      <UiBoxRow v-for="project in visibleProjects" :key="project.id" :title="project.name">
        <template #leading
          ><component :is="trackingStatus[project.status].icon" :size="16" :stroke-width="1.75" aria-hidden="true"
        /></template>
        <template #meta
          ><code class="dashboard__path">{{ project.rootPath }}</code></template
        >
        <div class="dashboard__project-meta">
          {{
            project.lastIngestedAt
              ? `最後寫入 ${formatRelative(project.lastIngestedAt)}`
              : `更新於 ${formatRelative(project.updatedAt)}`
          }}
        </div>
        <template #trailing><StatusLabel :status="trackingStatus[project.status]" :show-icon="false" /></template>
      </UiBoxRow>
    </UiBox>
  </div>
</template>

<style scoped>
.dashboard__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}

.dashboard__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--space-6);
  align-items: start;
}

.dashboard__main {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

.dashboard__main > .ui-box + .ui-box {
  margin-top: 0;
}

.dashboard__path {
  color: var(--fg-muted);
}

.dashboard__project-meta {
  margin-top: 2px;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.tone-attention {
  color: var(--attention);
}
.tone-accent {
  color: var(--accent);
}
.tone-danger {
  color: var(--danger);
}
.tone-done {
  color: var(--done);
}
.tone-neutral {
  color: var(--fg-muted);
}

@media (max-width: 1279px) {
  .dashboard__grid {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
}

@media (max-width: 959px) {
  .dashboard__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 639px) {
  .dashboard__stats {
    gap: var(--space-2);
  }
}
</style>
