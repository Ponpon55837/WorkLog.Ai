<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import {
  ChartColumn,
  CircleCheckBig,
  Download,
  FileText,
  FolderGit2,
  LayoutDashboard,
  Link,
  RefreshCw,
  Search,
  TrendingUp,
  TriangleAlert
} from "lucide-vue-next";
import type { ReportEvidence, ReportExportFormat, ReportPeriod, WorkSessionRecord } from "@work-intelligence/core";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import SessionRow from "../components/domain/SessionRow.vue";
import SynthesisCard from "../components/domain/SynthesisCard.vue";
import VerificationBreakdown from "../components/domain/VerificationBreakdown.vue";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiBarChart from "../components/ui/UiBarChart.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiIconButton from "../components/ui/UiIconButton.vue";
import UiLabel from "../components/ui/UiLabel.vue";
import UiPagination from "../components/ui/UiPagination.vue";
import UiSegmentedControl from "../components/ui/UiSegmentedControl.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import VirtualList from "../components/VirtualList.vue";
import { useViewLoader } from "../composables/useAppRefresh";
import { useProjects } from "../composables/useProjects";
import { useReports } from "../composables/useReports";
import { enumQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { useSessionDetail } from "../composables/useSessionDetail";
import { router } from "../router";
import { formatDate, formatReadableSummary, formatRelative, formatReportTrendLabel, toDateInputValue } from "../utils/format";
import { evidenceKindLabels, insightKindLabels, reportPeriodLabels, reportTabOptions, type ReportTab } from "../utils/labels";

const route = useRoute();
const { trackedProjects } = useProjects();
const {
  report,
  reportPeriod,
  reportDate,
  reportProjectId,
  reportLoading,
  reportError,
  reportExportLoading,
  reportEvidenceLoading,
  reportEvidencePage,
  reportEvidencePageSize,
  reportEvidenceKind,
  reportEvidenceQuery,
  reportSessionItems,
  reportSessionPage,
  reportSessionPageSize,
  reportSessionPageInfo,
  reportSessionLoading,
  reportComparisons,
  loadReport,
  loadReportSessions,
  loadReportEvidence,
  exportReport,
  openReportSession,
  openReportEvidence
} = useReports();
const { openSessionDetail, setSessionSequence } = useSessionDetail();

const periods: ReportPeriod[] = ["day", "week", "month", "quarter", "year"];
useRouteQuery("period", reportPeriod, enumQuery(periods, "week"));
useRouteQuery("date", reportDate, stringQuery(toDateInputValue(new Date())));
useRouteQuery("project", reportProjectId, stringQuery());
useViewLoader(() => loadReport(true));
watch([reportPeriod, reportDate, reportProjectId], () => void loadReport(true));

const tabIds = reportTabOptions.map((option) => option.id);
const tab = computed<ReportTab>({
  get: () => (tabIds.includes(route.params.tab as ReportTab) ? (route.params.tab as ReportTab) : "overview"),
  set: (value) => void router.replace({ name: "reports", params: { tab: value === "overview" ? undefined : value }, query: route.query })
});
const tabIcons = { overview: LayoutDashboard, work: CircleCheckBig, trend: TrendingUp, risks: TriangleAlert, raw: FileText, evidence: Link } as const;
const tabs = computed(() =>
  reportTabOptions.map((option) => ({ value: option.id, label: option.shortLabel, icon: tabIcons[option.id], count: tabCount(option.id) }))
);

function tabCount(id: ReportTab): number | undefined {
  const current = report.value;
  if (!current) {
    return undefined;
  }
  const counts: Record<ReportTab, number | undefined> = {
    overview: undefined,
    work: current.totals.sessions,
    trend: undefined,
    risks: current.risks.length + current.decisions.length,
    raw: reportSessionPageInfo.value.total,
    evidence: current.evidencePageInfo.total
  };
  return counts[id];
}

const periodShortLabels: Record<ReportPeriod, string> = { day: "日", week: "週", month: "月", quarter: "季", year: "年" };
const periodOptions = periods.map((period) => ({ value: period, label: periodShortLabels[period] }));
const projectItems = computed(() => [{ value: "", label: "所有記錄中專案" }, ...trackedProjects.value.map((project) => ({ value: project.id, label: project.name }))]);
const projectLabel = computed(() => projectItems.value.find((item) => item.value === reportProjectId.value)?.label ?? "所有記錄中專案");
const exportItems = [
  { value: "markdown" as ReportExportFormat, label: "下載 Markdown", icon: Download },
  { value: "json" as ReportExportFormat, label: "匯出 JSON", icon: Download }
];
const description = computed(() => {
  const current = report.value;
  return current
    ? `${reportPeriodLabels[current.period]} · ${current.range.from} – ${current.range.to}（${current.timezone}）· ${projectLabel.value}`
    : "報告只聚合「記錄中」的專案，並保留每筆來源 Session。";
});

const verificationCounts = computed(() => {
  const totals = report.value?.totals.verification;
  return { passed: totals?.passed ?? 0, failed: totals?.failed ?? 0, notRun: totals?.not_run ?? 0, notSupplied: totals?.not_supplied ?? 0 };
});
const trend = computed(() => {
  const current = report.value;
  if (!current) {
    return { labels: [], series: [] };
  }
  return {
    labels: current.trends.map((point) => formatReportTrendLabel(point.date, current.trendGranularity)),
    series: [
      { name: "Sessions", tone: "accent" as const, values: current.trends.map((point) => point.sessions) },
      { name: "Events", tone: "done" as const, values: current.trends.map((point) => point.events) }
    ]
  };
});

const evidenceKindItems = [
  { value: "" as const, label: "所有類型" },
  ...(Object.keys(evidenceKindLabels) as ReportEvidence["kind"][]).map((kind) => ({ value: kind, label: evidenceKindLabels[kind] }))
];

function openSession(session: WorkSessionRecord, list: readonly WorkSessionRecord[]): void {
  setSessionSequence(list.map((item) => item.id));
  void openSessionDetail(session.id);
}

function changeRawPage(page: number): void {
  reportSessionPage.value = page;
  void loadReportSessions();
}

function changeEvidencePage(page: number): void {
  reportEvidencePage.value = page;
  void loadReportEvidence();
}

function reloadEvidenceFromFirstPage(): void {
  reportEvidencePage.value = 1;
  void loadReportEvidence();
}

watch(reportSessionPageSize, () => {
  reportSessionPage.value = 1;
  void loadReportSessions();
});
watch([reportEvidencePageSize, reportEvidenceKind], reloadEvidenceFromFirstPage);
let evidenceTimer: number | undefined;
watch(reportEvidenceQuery, () => {
  window.clearTimeout(evidenceTimer);
  evidenceTimer = window.setTimeout(reloadEvidenceFromFirstPage, 300);
});
onBeforeUnmount(() => window.clearTimeout(evidenceTimer));

const evidenceLetters: Record<ReportEvidence["kind"], string> = { handoff: "H", verification: "V", "changed-files": "F", event: "E", attached: "A" };
</script>

<template>
  <PageHeader :description="description">
    <template #actions>
      <UiSegmentedControl v-model="reportPeriod" :options="periodOptions" label="選擇報表區間" />
      <UiTextInput v-model="reportDate" type="date" class="reports__date" label="選擇報告日期" />
      <UiActionMenu v-model="reportProjectId" :label="projectLabel" :icon="FolderGit2" variant="button" header="專案範圍" default-value="" align="end" :items="projectItems" />
      <UiActionMenu label="匯出" :icon="Download" variant="button" align="end" :items="exportItems" @select="exportReport" />
      <UiIconButton :icon="RefreshCw" label="重新整理報告" variant="default" :loading="reportLoading || Boolean(reportExportLoading)" @click="loadReport(true)" />
    </template>
  </PageHeader>

  <UiFlash v-if="reportError" tone="danger">{{ reportError }}</UiFlash>
  <UiSkeleton v-if="reportLoading && !report" variant="card" :count="4" />
  <UiEmptyState v-else-if="!report" :icon="ChartColumn" title="尚未產生報告" description="選擇區間後，系統會從已授權的工作紀錄建立 deterministic 報告。" />

  <template v-else>
    <PageToolbar>
      <UiUnderlineNav v-model="tab" :items="tabs" label="工作報告內容分頁" id-prefix="report" />
      <div v-if="tab === 'evidence'" class="reports__evidence-search">
        <UiTextInput v-model="reportEvidenceQuery" type="search" :icon="Search" label="搜尋來源證據" placeholder="搜尋 Session、來源或證據內容" />
      </div>
    </PageToolbar>

    <section v-if="tab === 'overview'" id="report-panel-overview" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-overview">
      <SynthesisCard />
      <div class="reports__stats">
        <UiStatCard
          v-for="item in reportComparisons"
          :key="item.key"
          :label="item.label"
          :value="item.comparison.current"
          :delta="{ direction: item.comparison.direction, text: item.comparison.direction === 'flat' ? '與上期相同' : `${Math.abs(item.comparison.delta)} vs 上期` }"
          :foot="item.foot"
        />
        <UiStatCard label="Verification" :value="verificationCounts.passed" :suffix="`/ ${report.totals.sessions} 通過`">
          <VerificationBreakdown :counts="verificationCounts" />
        </UiStatCard>
      </div>
      <UiBox padded>
        <template #header>
          <UiBoxTitle eyebrow="Period summary" title="這段時間發生了什麼" />
          <span class="reports__muted">比較期間 {{ report.previousRange.from }} – {{ report.previousRange.to }}</span>
        </template>
        <p class="reports__summary">{{ formatReadableSummary(report.periodSummary) }}</p>
      </UiBox>
    </section>

    <section v-else-if="tab === 'work'" id="report-panel-work" class="reports__panel reports__grid" role="tabpanel" aria-labelledby="report-tab-work">
      <UiBox sticky-header>
        <template #header><UiBoxTitle eyebrow="Completed work" title="主要完成事項" :count="report.totals.sessions" /></template>
        <UiEmptyState v-if="report.completedWork.length === 0" compact :icon="CircleCheckBig" title="這段期間沒有完成工作" />
        <SessionRow v-for="session in report.completedWork" :key="session.id" :session="session" @open="openSession($event, report.completedWork)" />
      </UiBox>
      <UiBox padded>
        <template #header><UiBoxTitle eyebrow="Verification" title="驗證狀態" /></template>
        <VerificationBreakdown :counts="verificationCounts" />
        <p class="reports__note">未回報代表沒有結構化 verification；未執行代表 Agent 明確表示尚未驗證。報告不會替 Agent 推測驗證結果。</p>
      </UiBox>
    </section>

    <section v-else-if="tab === 'trend'" id="report-panel-trend" class="reports__panel reports__grid" role="tabpanel" aria-labelledby="report-tab-trend">
      <UiBox>
        <template #header><UiBoxTitle eyebrow="Activity trend" title="工作節奏" /></template>
        <UiBarChart :labels="trend.labels" :series="trend.series" label="每期完成 Session 與事件數" />
      </UiBox>
      <UiBox>
        <template #header><UiBoxTitle eyebrow="Project breakdown" title="專案分布" :count="report.projects.length" /></template>
        <UiEmptyState v-if="report.projects.length === 0" compact :icon="FolderGit2" title="沒有專案資料" />
        <UiBoxRow v-for="project in report.projects" :key="project.projectId" :title="project.projectName" :meta="`${project.sessionCount} 個 Session · ${project.eventCount} 個事件`">
          <template #leading><FolderGit2 :size="16" :stroke-width="1.75" aria-hidden="true" /></template>
          <template #trailing><UiLabel>{{ project.sourceSessionIds.length }} 個來源</UiLabel></template>
        </UiBoxRow>
      </UiBox>
    </section>

    <section v-else-if="tab === 'risks'" id="report-panel-risks" class="reports__panel reports__grid" role="tabpanel" aria-labelledby="report-tab-risks">
      <UiBox sticky-header>
        <template #header><UiBoxTitle eyebrow="Risks to review" title="資料型風險" :count="report.risks.length" /></template>
        <UiEmptyState v-if="report.risks.length === 0" compact :icon="TriangleAlert" title="沒有偵測到資料型風險" />
        <UiBoxRow
          v-for="insight in report.risks"
          :key="`${insight.kind}-${insight.label}`"
          clickable
          :title="insight.label"
          :meta="`${insight.sourceSessionIds.length} 筆來源 Session`"
          @select="openReportSession(insight.sourceSessionIds[0])"
        >
          <template #labels><UiLabel tone="attention">{{ insightKindLabels[insight.kind] }}</UiLabel></template>
          <p class="reports__row-detail">{{ insight.detail }}</p>
        </UiBoxRow>
      </UiBox>
      <UiBox sticky-header>
        <template #header><UiBoxTitle eyebrow="Decisions" title="決策與 closing 事件" :count="report.decisions.length" /></template>
        <UiEmptyState v-if="report.decisions.length === 0" compact title="這段期間沒有決策事件" description="Agent 提交 note 或 closing event 後，會在這裡保留來源。" />
        <UiBoxRow v-for="decision in report.decisions" :key="`${decision.sessionId}-${decision.occurredAt}`" clickable :title="decision.summary" @select="openReportSession(decision.sessionId)">
          <template #meta>{{ decision.sessionTitle }} · <time :title="formatDate(decision.occurredAt)">{{ formatRelative(decision.occurredAt) }}</time></template>
        </UiBoxRow>
      </UiBox>
    </section>

    <section v-else-if="tab === 'raw'" id="report-panel-raw" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-raw">
      <UiBox sticky-header>
        <template #header><UiBoxTitle eyebrow="Raw work records" title="原始工作紀錄" :count="reportSessionPageInfo.total" /></template>
        <UiSkeleton v-if="reportSessionLoading && reportSessionItems.length === 0" />
        <UiEmptyState v-else-if="reportSessionItems.length === 0" compact :icon="FileText" title="這段期間沒有原始 Session" />
        <VirtualList v-else :items="reportSessionItems" :enabled="reportSessionPageSize === 'all'" label="報告原始工作紀錄清單">
          <template #default="{ item }">
            <SessionRow :session="item" @open="openSession($event, reportSessionItems)" />
          </template>
        </VirtualList>
        <template #footer>
          <UiPagination v-model:page-size="reportSessionPageSize" :page-info="reportSessionPageInfo" size-label="報告原始工作紀錄每頁筆數" @page="changeRawPage" />
        </template>
      </UiBox>
    </section>

    <section v-else id="report-panel-evidence" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-evidence">
      <UiBox sticky-header>
        <template #header>
          <UiBoxTitle eyebrow="Source evidence" title="來源證據" :count="report.evidencePageInfo.total" />
          <UiActionMenu v-model="reportEvidenceKind" label="類型" header="篩選 Evidence 類型" default-value="" align="end" :items="evidenceKindItems" />
        </template>
        <UiSkeleton v-if="reportEvidenceLoading && report.evidence.length === 0" />
        <UiEmptyState v-else-if="report.evidence.length === 0" compact :icon="Link" title="尚無可呈現的證據" description="Session 提供 handoff、verification、changed files 或 event 後，報告就能建立追溯線索。" />
        <VirtualList v-else :items="report.evidence" :enabled="reportEvidencePageSize === 'all'" :estimate-item-height="72" label="報告來源證據清單">
          <template #default="{ item }">
            <UiBoxRow clickable :title="item.label" @select="openReportEvidence(item)">
              <template #leading><span class="reports__evidence-kind" aria-hidden="true">{{ evidenceLetters[item.kind as ReportEvidence["kind"]] }}</span></template>
              <template #labels><UiLabel>{{ evidenceKindLabels[item.kind as ReportEvidence["kind"]] }}</UiLabel></template>
              <template #meta>{{ item.sessionTitle }}<template v-if="item.projectName"> · {{ item.projectName }}</template><template v-if="item.reference"> · {{ item.reference }}</template></template>
              <p class="reports__row-detail">{{ item.detail }}</p>
            </UiBoxRow>
          </template>
        </VirtualList>
        <template #footer>
          <UiPagination v-model:page-size="reportEvidencePageSize" :page-info="report.evidencePageInfo" size-label="報告來源證據每頁筆數" @page="changeEvidencePage" />
        </template>
      </UiBox>
    </section>
  </template>
</template>

<style scoped>
.reports__date {
  width: 150px;
}

.reports__panel {
  display: grid;
  gap: var(--space-4);
}

.reports__panel > :deep(.ui-box + .ui-box) {
  margin-top: 0;
}

.reports__grid {
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  align-items: start;
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

.reports__muted,
.reports__note {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.reports__note {
  margin-top: var(--space-3);
}

.reports__row-detail {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.reports__evidence-search {
  flex: 1 1 100%;
  padding: var(--space-2) 0;
}

.reports__evidence-kind {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font: 700 11px var(--font-mono);
}

@media (max-width: 1279px) {
  .reports__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 959px) {
  .reports__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 639px) {
  .reports__date {
    flex: 1;
    width: auto;
  }
}
</style>
