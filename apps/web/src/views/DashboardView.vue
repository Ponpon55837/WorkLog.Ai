<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
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
import ActivityHeatmap from "../components/domain/ActivityHeatmap.vue";
import FirstRunChecklist from "../components/domain/FirstRunChecklist.vue";
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
import UiFlash from "../components/ui/UiFlash.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiSparkline from "../components/ui/UiSparkline.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import VirtualList from "../components/VirtualList.vue";
import { router } from "../router";
import { useActivityStore } from "../stores/activity";
import { useDashboardStore, type InboxItem } from "../stores/dashboard";
import { metadataBackfillInstruction } from "../stores/metadata-backfill";
import { useProjectsStore } from "../stores/projects";
import { reportSynthesisInstruction } from "../stores/reports";
import { useSessionsStore } from "../stores/sessions";
import { useSystemStatusStore } from "../stores/system-status";
import { formatRelative } from "../utils/format";
import { requestStatus, trackingStatus } from "../utils/status";
import { intlLocale, t } from "../i18n";

const projectsStore = useProjectsStore();
const { dashboard, projects, recentSessions, initialDataReady } = storeToRefs(projectsStore);
const dashboardStore = useDashboardStore();
const { weekReport, weekVerification, inbox } = storeToRefs(dashboardStore);
const activityStore = useActivityStore();
const { days: activityDays, activityLoaded, activityError } = storeToRefs(activityStore);
const sessionsStore = useSessionsStore();
const { openSessionDetail, setSessionSequence } = sessionsStore;
const systemStatusStore = useSystemStatusStore();
const { systemStatus, systemStatusLoading, systemStatusError } = storeToRefs(systemStatusStore);

const today = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "full" }).format(new Date());
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
  const text =
    comparison.direction === "flat"
      ? t("dashboard.sameAsLastWeek")
      : t("dashboard.vsLastWeek", { value: Math.abs(comparison.delta) });
  return { direction: comparison.direction, text };
});
const showFirstRunChecklist = computed(
  () => initialDataReady.value && (dashboard.value.trackedProjects === 0 || dashboard.value.finalizedSessions === 0),
);

function openSession(session: WorkSessionRecord): void {
  void openSessionDetail(session.id);
}

/** Opens the report scope of a synthesis request so the retry/cancel actions live in one place. */
async function openRequest(item: InboxItem): Promise<void> {
  if (item.kind === "backfill") {
    await router.push({ name: "projects", params: { tab: "backfill" } });
    return;
  }
  await router.push({
    name: "reports",
    query: {
      period: item.request.period,
      date: item.request.range.from,
      ...(item.request.projectId ? { project: item.request.projectId } : {}),
    },
  });
}

/** Opens that day's report, linked the same way the report pages read period and date from the URL. */
async function openDayReport(date: string): Promise<void> {
  await router.push({ name: "reports", query: { period: "day", date } });
}

watch(recentSessions, (items) => setSessionSequence(items.map((item) => item.id)), { immediate: true });
watch(showFirstRunChecklist, (visible) => systemStatusStore.setSystemStatusActive(visible), { immediate: true });

onMounted(() => activityStore.setActive(true));
onBeforeUnmount(() => {
  activityStore.setActive(false);
  systemStatusStore.setSystemStatusActive(false);
});
</script>

<template>
  <PageHeader :description="t('dashboard.projectsTracked', { today, trackedProjects: dashboard.trackedProjects })">
    <template #actions>
      <UiButton :icon="ChartColumn" :to="{ name: 'reports' }">{{ t("dashboard.thisWeekSReport") }}</UiButton>
      <UiButton :icon="ListChecks" :to="{ name: 'sessions' }">{{ t("dashboard.allSessions") }}</UiButton>
    </template>
  </PageHeader>

  <FirstRunChecklist
    v-if="showFirstRunChecklist"
    class="dashboard__first-run"
    :has-project="projects.length > 0"
    :has-tracked-project="dashboard.trackedProjects > 0"
    :has-session="dashboard.finalizedSessions > 0"
    :agent-connections="systemStatus?.agents ?? null"
    :agent-status-loading="systemStatusLoading"
    :agent-status-error="systemStatusError"
  />

  <div class="dashboard__stats">
    <UiStatCard
      :label="t('common.trackedProjects')"
      :icon="FolderGit2"
      :value="dashboard.trackedProjects"
      :foot="`${t('dashboard.explicitOptIn')}${pausedCount ? t('dashboard.paused', { pausedCount }) : ''}`"
    />
    <UiStatCard
      :label="t('dashboard.sessionsCompletedThisWeek')"
      :icon="CircleCheckBig"
      :value="weekReport?.totals.sessions ?? 0"
      :delta="weekDelta"
    >
      <UiSparkline v-if="weekTrend.length" :values="weekTrend" :label="t('dashboard.sessionsCompletedPerDayThis')" />
      <template #foot>{{
        t("dashboard.notTheSameAsGit", { finalizedSessions: dashboard.finalizedSessions })
      }}</template>
    </UiStatCard>
    <UiStatCard
      :label="t('dashboard.verificationThisWeek')"
      :icon="ShieldCheck"
      :value="weekVerification.passed"
      :suffix="t('dashboard.passed', { total: weekVerification.total })"
    >
      <VerificationBreakdown :counts="weekVerification" />
    </UiStatCard>
    <UiStatCard
      :label="t('common.pending')"
      :icon="Inbox"
      :value="inbox.length"
      :value-tone="inbox.length ? 'attention' : undefined"
      :foot="inbox.length ? t('dashboard.waitingForTheAgentOr') : t('common.allCaughtUp')"
    />
  </div>

  <div class="dashboard__grid">
    <div class="dashboard__main">
      <UiBox>
        <template #header>
          <UiBoxTitle eyebrow="Activity" :title="t('dashboard.activityTitle')" />
        </template>
        <UiFlash v-if="activityError" tone="danger">
          {{ activityError }}
          <template #actions
            ><UiButton size="sm" @click="activityStore.reloadActivity()">{{ t("common.retry") }}</UiButton></template
          >
        </UiFlash>
        <UiSkeleton v-else-if="!activityLoaded" variant="text" :count="3" :label="t('dashboard.activityLoading')" />
        <ActivityHeatmap v-else :days="activityDays" @select="openDayReport" />
      </UiBox>

      <UiBox>
        <template #header>
          <UiBoxTitle eyebrow="Action required" :title="t('dashboard.needsAttention')" />
          <UiCounter v-if="inbox.length" :count="inbox.length" tone="attention" />
        </template>
        <UiEmptyState
          v-if="inbox.length === 0"
          compact
          :icon="CircleCheckBig"
          :title="t('common.allCaughtUp')"
          :description="t('dashboard.noReportSynthesisOrMetadata')"
        />
        <VirtualList
          v-else
          :items="inbox"
          :enabled="true"
          :estimate-item-height="104"
          :label="t('dashboard.pendingRequestsList')"
        >
          <template #default="{ item }">
            <UiBoxRow :title="item.title" :meta="item.meta">
              <template #leading>
                <component
                  :is="requestStatus[item.request.status].icon"
                  :size="16"
                  :stroke-width="1.75"
                  :class="`tone-${requestStatus[item.request.status].tone}`"
                  aria-hidden="true"
                />
              </template>
              <template #labels
                ><StatusLabel :status="requestStatus[item.request.status]" :show-icon="false"
              /></template>
              <template #trailing>
                <UiCopyButton
                  v-if="item.request.status !== 'failed'"
                  size="sm"
                  :label="t('common.copyAgentInstruction')"
                  :text="item.kind === 'synthesis' ? reportSynthesisInstruction() : metadataBackfillInstruction()"
                  :success-message="t('dashboard.naturalLanguageInstructionCopied')"
                />
                <UiButton v-else size="sm" :icon="RotateCcw" @click="openRequest(item)">{{
                  t("dashboard.goToRetry")
                }}</UiButton>
                <UiButton size="sm" variant="invisible" :trailing-icon="ArrowRight" @click="openRequest(item)">{{
                  t("common.go")
                }}</UiButton>
              </template>
            </UiBoxRow>
          </template>
        </VirtualList>
      </UiBox>

      <UiBox>
        <template #header>
          <UiBoxTitle eyebrow="Latest memory" :title="t('dashboard.recentlyCompletedWork')" />
          <UiButton size="sm" variant="invisible" :trailing-icon="ArrowRight" :to="{ name: 'sessions' }">{{
            t("dashboard.viewAll")
          }}</UiButton>
        </template>
        <UiEmptyState
          v-if="recentSessions.length === 0"
          compact
          :icon="ListChecks"
          :title="t('common.noWorkRecordsYet')"
          :description="t('dashboard.addAProjectOnThe')"
        >
          <template #action
            ><UiButton :to="{ name: 'projects' }">{{ t("dashboard.goToProjects") }}</UiButton></template
          >
        </UiEmptyState>
        <VirtualList
          v-else
          :items="recentSessions"
          :enabled="recentSessions.length > 5"
          :estimate-item-height="112"
          max-height="min(40vh, 360px)"
          grow-to-viewport
          :label="t('dashboard.recentlyCompletedWorkList')"
        >
          <template #default="{ item: session }">
            <SessionRow :session="session" @open="openSession" />
          </template>
        </VirtualList>
      </UiBox>
    </div>

    <UiBox>
      <template #header>
        <UiBoxTitle eyebrow="Projects" :title="t('dashboard.projectStatus')" />
        <UiButton size="sm" variant="invisible" :to="{ name: 'projects' }">{{ t("dashboard.manage") }}</UiButton>
      </template>
      <UiEmptyState v-if="projects.length === 0" compact :icon="FolderGit2" :title="t('dashboard.noProjectsYet')" />
      <VirtualList
        v-else
        :items="visibleProjects"
        :enabled="visibleProjects.length > 5"
        :estimate-item-height="96"
        max-height="min(48vh, 520px)"
        grow-to-viewport
        :label="t('dashboard.projectStatusList')"
      >
        <template #default="{ item: project }">
          <UiBoxRow :title="project.name">
            <template #leading
              ><component :is="trackingStatus[project.status].icon" :size="16" :stroke-width="1.75" aria-hidden="true"
            /></template>
            <template #meta
              ><code class="dashboard__path">{{ project.rootPath }}</code></template
            >
            <div class="dashboard__project-meta">
              {{
                project.lastIngestedAt
                  ? t("dashboard.lastWritten", { value: formatRelative(project.lastIngestedAt) })
                  : t("common.updated", { value: formatRelative(project.updatedAt) })
              }}
            </div>
            <template #trailing><StatusLabel :status="trackingStatus[project.status]" :show-icon="false" /></template>
          </UiBoxRow>
        </template>
      </VirtualList>
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

.dashboard__first-run {
  margin-bottom: var(--space-4);
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
