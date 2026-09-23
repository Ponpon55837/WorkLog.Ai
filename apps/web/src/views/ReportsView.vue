<script setup lang="ts">
import { computed } from "vue";
import type {
  PageInfo,
  ProjectRecord,
  ReportEvidence,
  ReportExportFormat,
  ReportMetricComparison,
  ReportPeriod,
  ReportSynthesisRequest,
  ReportSummary,
  ReportVerificationStatus,
  WorkReport,
  WorkSessionRecord
} from "@work-intelligence/core";
import VirtualList from "../components/VirtualList.vue";

type ReportTab = "overview" | "work" | "trend" | "risks" | "raw" | "evidence";
type ListPageSize = 10 | 20 | 50 | 100 | "all";
type ReportResult = WorkReport | null;
type ReportTabOption = { id: ReportTab; label: string; shortLabel: string };
type ReportComparisonCard = { key: string; label: string; comparison: ReportMetricComparison; foot: string };
type ReportVerificationItem = { status: ReportVerificationStatus; label: string; count: number; percent: number };

const props = defineProps<{
  trackedProjects: readonly ProjectRecord[];
  report: ReportResult;
  reportPeriod: ReportPeriod;
  reportDate: string;
  reportProjectId: string;
  reportTab: ReportTab;
  reportLoading: boolean;
  reportError: string;
  reportExportLoading: ReportExportFormat | null;
  reportEvidenceLoading: boolean;
  reportEvidencePageSize: ListPageSize;
  reportEvidenceKind: ReportEvidence["kind"] | "";
  reportEvidenceQuery: string;
  reportSessionItems: readonly WorkSessionRecord[];
  reportSessionPageSize: ListPageSize;
  reportSessionPageInfo: PageInfo;
  reportSessionLoading: boolean;
  reportSynthesisRequest: ReportSynthesisRequest | null;
  reportSynthesisSummary: ReportSummary | null;
  reportSynthesisHistory: readonly ReportSummary[];
  reportSynthesisExpanded: boolean;
  reportSynthesisLoading: boolean;
  reportSynthesisCreating: boolean;
  reportSynthesisRetrying: boolean;
  reportSynthesisCancelling: boolean;
  reportSynthesisError: string;
  reportSynthesisStatusLabels: Readonly<Record<ReportSynthesisRequest["status"], string>>;
  reportPeriodLabels: Readonly<Record<ReportPeriod, string>>;
  reportTabOptions: readonly ReportTabOption[];
  reportSynthesisIsActive: boolean;
  reportSynthesisCanRetry: boolean;
  reportComparisons: readonly ReportComparisonCard[];
  reportVerification: readonly ReportVerificationItem[];
  verificationLabels: Readonly<Record<ReportVerificationStatus, string>>;
  evidenceKindLabels: Readonly<Record<ReportEvidence["kind"], string>>;
  insightKindLabels: Readonly<Record<"verification" | "metadata" | "event", string>>;
  listPageSizeOptions: readonly { value: ListPageSize; label: string }[];
  formatDate: (value: string) => string;
  formatReadableSummary: (value: string) => string;
  formatReportDelta: (comparison: ReportMetricComparison) => string;
  formatReportTrendLabel: (value: string, granularity: WorkReport["trendGranularity"]) => string;
  reportTrendHeight: (value: number, report: WorkReport) => string;
  shouldShowTrendLabel: (index: number, total: number) => boolean;
  verificationLabel: (value: unknown) => string;
  evidenceKindLabel: (value: unknown) => string;
}>();

const emit = defineEmits<{
  "update:reportPeriod": [value: ReportPeriod];
  "update:reportDate": [value: string];
  "update:reportProjectId": [value: string];
  "update:reportTab": [value: ReportTab];
  "update:reportEvidencePageSize": [value: ListPageSize];
  "update:reportEvidenceKind": [value: ReportEvidence["kind"] | ""];
  "update:reportEvidenceQuery": [value: string];
  "update:reportSessionPageSize": [value: ListPageSize];
  "update:reportSynthesisExpanded": [value: boolean];
  load: [reset?: boolean];
  export: [format: ReportExportFormat];
  loadReportSynthesis: [];
  retryReportSynthesis: [];
  createReportSynthesis: [];
  cancelReportSynthesis: [];
  selectReportSynthesisVersion: [summary: ReportSummary];
  deleteReportSynthesisVersion: [summary: ReportSummary];
  copyReportSynthesisInstruction: [];
  openSession: [session: WorkSessionRecord];
  openReportSession: [sessionId: string | undefined];
  openReportEvidence: [evidence: ReportEvidence];
  changeReportSessionPage: [page: number];
  changeReportSessionPageSize: [];
  loadReportEvidence: [reset?: boolean];
  changeReportEvidencePage: [page: number];
  changeReportEvidencePageSize: [];
}>();

const reportPeriodModel = computed({ get: () => props.reportPeriod, set: (value: ReportPeriod) => emit("update:reportPeriod", value) });
const reportDateModel = computed({ get: () => props.reportDate, set: (value: string) => emit("update:reportDate", value) });
const reportProjectIdModel = computed({ get: () => props.reportProjectId, set: (value: string) => emit("update:reportProjectId", value) });
const reportTabModel = computed({ get: () => props.reportTab, set: (value: ReportTab) => emit("update:reportTab", value) });
const reportEvidencePageSizeModel = computed({ get: () => props.reportEvidencePageSize, set: (value: ListPageSize) => emit("update:reportEvidencePageSize", value) });
const reportEvidenceKindModel = computed({ get: () => props.reportEvidenceKind, set: (value: ReportEvidence["kind"] | "") => emit("update:reportEvidenceKind", value) });
const reportEvidenceQueryModel = computed({ get: () => props.reportEvidenceQuery, set: (value: string) => emit("update:reportEvidenceQuery", value) });
const reportSessionPageSizeModel = computed({ get: () => props.reportSessionPageSize, set: (value: ListPageSize) => emit("update:reportSessionPageSize", value) });
const reportSynthesisExpandedModel = computed({ get: () => props.reportSynthesisExpanded, set: (value: boolean) => emit("update:reportSynthesisExpanded", value) });
</script>

<template>
  <section class="page-section reports-page">
    <div class="section-intro reports-intro">
      <div><div class="eyebrow">WORK REPORTS</div><h2>把已完成的工作，整理成可讀的節奏。</h2><p>報告只聚合「記錄中」的專案，並保留每筆來源 Session。</p></div>
      <form class="report-tools" @submit.prevent="emit('load', true)">
        <label class="report-control"><span>報表區間</span><select v-model="reportPeriodModel" aria-label="選擇報表區間" @change="emit('load', true)"><option value="day">今日</option><option value="week">本週</option><option value="month">本月</option><option value="quarter">本季</option><option value="year">本年</option></select></label>
        <label class="report-control report-date-control"><span>報告日期</span><input v-model="reportDateModel" type="date" aria-label="選擇報告日期" @change="emit('load', true)" /></label>
        <label class="report-control"><span>專案範圍</span><select v-model="reportProjectIdModel" aria-label="選擇報表專案" @change="emit('load', true)"><option value="">所有記錄中專案</option><option v-for="project in trackedProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
        <button class="filter-button report-refresh report-refresh-icon" type="submit" :disabled="reportLoading" :aria-busy="reportLoading" aria-label="重新整理報告" title="重新整理報告"><span class="refresh-icon" aria-hidden="true">{{ reportLoading ? '…' : '↻' }}</span><span class="sr-only">{{ reportLoading ? '整理中' : '重新整理報告' }}</span></button>
        <div class="report-export-actions" aria-label="匯出報告"><button class="text-button report-export-button" type="button" :disabled="reportLoading || !report || reportExportLoading !== null" @click="emit('export', 'markdown')">{{ reportExportLoading === 'markdown' ? '產生中…' : '下載 Markdown' }}</button><button class="text-button report-export-button" type="button" :disabled="reportLoading || !report || reportExportLoading !== null" @click="emit('export', 'json')">{{ reportExportLoading === 'json' ? '產生中…' : '匯出 JSON' }}</button></div>
      </form>
    </div>

    <div v-if="reportError" class="alert error-alert report-error" role="alert">{{ reportError }}</div>
    <section v-if="reportLoading" class="loading-state report-loading"><div class="spinner"></div><p>正在整理本機工作報告…</p></section>
    <template v-else-if="report">
      <div class="report-range-note"><div><span>{{ reportPeriodLabels[report.period] }}</span><strong>{{ report.range.from }} — {{ report.range.to }}</strong></div><small>資料時區 {{ report.timezone }} · {{ report.sourceSessionIds.length }} 筆來源 Session</small></div>
      <nav class="report-tabs" role="tablist" aria-label="工作報告內容分頁"><button v-for="tab in reportTabOptions" :id="`report-tab-${tab.id}`" :key="tab.id" class="report-tab" :class="{ 'report-tab-active': reportTab === tab.id }" type="button" role="tab" :aria-selected="reportTab === tab.id" :aria-controls="`report-tab-panel-${tab.id}`" :title="tab.label" @click="reportTabModel = tab.id"><span>{{ tab.shortLabel }}</span></button></nav>
      <div class="report-tab-panels">
        <section id="report-tab-panel-overview" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-overview" v-show="reportTab === 'overview'">
          <details class="report-synthesis-card" :open="reportSynthesisExpanded || !reportSynthesisSummary" @toggle="reportSynthesisExpandedModel = ($event.currentTarget as HTMLDetailsElement).open">
            <summary class="report-synthesis-summary"><div class="report-synthesis-heading"><div><div class="eyebrow">AGENT SYNTHESIS</div><h3>{{ reportSynthesisSummary?.title ?? '管理層摘要' }}</h3></div><span v-if="reportSynthesisRequest" :class="['synthesis-status', `synthesis-status-${reportSynthesisRequest.status}`]">{{ reportSynthesisStatusLabels[reportSynthesisRequest.status] }}</span></div></summary>
            <div v-if="reportSynthesisLoading" class="report-synthesis-loading"><span class="spinner small-spinner"></span><span>正在讀取提煉狀態…</span></div>
            <template v-else-if="reportSynthesisSummary && !reportSynthesisIsActive">
              <p class="report-synthesis-executive">{{ reportSynthesisSummary.executiveSummary }}</p>
              <div class="report-synthesis-block-grid">
                <section v-if="reportSynthesisSummary.themes.length" class="report-synthesis-block"><div class="eyebrow">WORKSTREAMS</div><article v-for="block in reportSynthesisSummary.themes" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.highlights.length" class="report-synthesis-block"><div class="eyebrow">HIGHLIGHTS</div><article v-for="block in reportSynthesisSummary.highlights" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.risks.length" class="report-synthesis-block"><div class="eyebrow">RISKS</div><article v-for="block in reportSynthesisSummary.risks" :key="`${block.title}-${block.detail}`" class="synthesis-block-item synthesis-risk-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.decisions.length" class="report-synthesis-block"><div class="eyebrow">DECISIONS</div><article v-for="block in reportSynthesisSummary.decisions" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.nextSteps.length" class="report-synthesis-block"><div class="eyebrow">KNOWN STATUS</div><article v-for="block in reportSynthesisSummary.nextSteps" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.verification.length" class="report-synthesis-block"><div class="eyebrow">VERIFICATION</div><article v-for="block in reportSynthesisSummary.verification" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
                <section v-if="reportSynthesisSummary.comparison.length" class="report-synthesis-block"><div class="eyebrow">COMPARISON</div><article v-for="block in reportSynthesisSummary.comparison" :key="`${block.title}-${block.detail}`" class="synthesis-block-item"><strong>{{ block.title }}</strong><p>{{ block.detail }}</p><div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="emit('openReportSession', sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div></article></section>
              </div>
              <div class="report-synthesis-footer"><span>由 {{ reportSynthesisSummary.generatedByAgent }} 產生 · Prompt {{ reportSynthesisSummary.promptVersion }} · {{ formatDate(reportSynthesisSummary.createdAt) }}</span><span v-if="reportSynthesisRequest?.failureReason" class="report-synthesis-failure">{{ reportSynthesisRequest.failureReason }}</span><div class="report-synthesis-footer-actions"><button class="icon-button report-icon-button" type="button" :disabled="reportSynthesisLoading" aria-label="重新整理提煉狀態" title="重新整理提煉狀態" @click="emit('loadReportSynthesis')"><span aria-hidden="true">↻</span></button><button class="text-button" type="button" :disabled="reportSynthesisCreating || reportSynthesisRetrying" @click="reportSynthesisCanRetry ? emit('retryReportSynthesis') : emit('createReportSynthesis')">{{ reportSynthesisCanRetry ? (reportSynthesisRetrying ? '重試中…' : '重試這次提煉') : '重新提煉' }}</button></div></div>
              <details v-if="reportSynthesisHistory.length > 1" class="report-synthesis-history"><summary><span>歷史版本</span><span>{{ reportSynthesisHistory.length }} 個版本</span></summary><div class="report-synthesis-history-list"><div v-for="summary in reportSynthesisHistory" :key="summary.id" :class="['report-synthesis-history-item', { 'report-synthesis-history-item-current': reportSynthesisSummary.id === summary.id }]" ><button class="report-synthesis-history-select" type="button" :aria-pressed="reportSynthesisSummary.id === summary.id" @click="emit('selectReportSynthesisVersion', summary)"><span class="report-synthesis-history-item-copy"><strong>{{ summary.title }}</strong><small>{{ formatDate(summary.createdAt) }} · {{ summary.generatedByAgent }}</small></span><span class="report-synthesis-history-item-status">{{ summary.isCurrent ? '目前版本' : '歷史版本' }}</span></button><button v-if="!summary.isCurrent" class="icon-button report-synthesis-history-delete" type="button" :aria-label="`移除歷史版本 ${summary.title}`" :title="`移除歷史版本 ${summary.title}`" @click.stop="emit('deleteReportSynthesisVersion', summary)"><span aria-hidden="true">×</span></button></div></div></details>
            </template>
            <div v-else class="report-synthesis-empty"><div class="report-synthesis-message"><p v-if="reportSynthesisRequest">{{ reportSynthesisRequest.status === 'pending' ? '請在目前的 Codex 或 Claude 對話中用自然語言請 Agent 處理這份報告。' : reportSynthesisRequest.status === 'processing' ? 'Agent 已開始處理；完成後可重新整理狀態。' : reportSynthesisRequest.status === 'failed' || reportSynthesisRequest.status === 'cancelled' ? '這次提煉沒有完成，可以重新建立一次安全的提煉請求。' : '目前沒有可顯示的提煉內容。' }}</p><p v-if="reportSynthesisRequest?.failureReason" class="report-synthesis-error">{{ reportSynthesisRequest.failureReason }}</p><p v-if="reportSynthesisSummary && reportSynthesisIsActive" class="report-synthesis-previous-note">上一版摘要仍保留在資料庫；新的提煉完成後才會替換，期間不會遺失早上的報告。</p><p v-if="!reportSynthesisRequest">這份 deterministic report 尚未建立 Agent 提煉請求。按下按鈕後，WorkLog 只會建立待處理請求，不會反向呼叫任何 Agent。</p></div><div class="report-synthesis-actions"><button v-if="reportSynthesisCanRetry" class="primary-button" type="button" :disabled="reportSynthesisRetrying" @click="emit('retryReportSynthesis')">{{ reportSynthesisRetrying ? '重試中…' : '重試這次提煉' }}</button><button v-else class="primary-button" type="button" :disabled="reportSynthesisCreating || reportSynthesisIsActive" @click="emit('createReportSynthesis')">{{ reportSynthesisCreating ? '建立中…' : reportSynthesisIsActive ? '等待 Agent 處理中…' : reportSynthesisRequest ? '重新提煉本報告' : '請 Agent 提煉本報告' }}</button><button v-if="reportSynthesisRequest" class="text-button" type="button" @click="emit('copyReportSynthesisInstruction')">複製提煉指令</button><button v-if="reportSynthesisIsActive" class="text-button cancel-button" type="button" :disabled="reportSynthesisCancelling" @click="emit('cancelReportSynthesis')">{{ reportSynthesisCancelling ? '取消中…' : '取消這次提煉' }}</button><button class="icon-button report-icon-button" type="button" :disabled="reportSynthesisLoading" aria-label="重新整理提煉狀態" title="重新整理提煉狀態" @click="emit('loadReportSynthesis')"><span aria-hidden="true">↻</span></button></div></div>
            <p v-if="reportSynthesisError" class="report-synthesis-error" role="alert">{{ reportSynthesisError }}</p>
          </details>
          <section class="report-summary-card"><div class="report-summary-copy"><div class="eyebrow">PERIOD SUMMARY</div><h3>這段時間發生了什麼</h3><p>{{ formatReadableSummary(report.periodSummary) }}</p></div><div class="report-period-meta"><div><span>比較期間</span><strong>{{ report.previousRange.from }} — {{ report.previousRange.to }}</strong></div><div><span>報告範圍</span><strong>{{ report.project?.name ?? '所有記錄中專案' }}</strong></div></div></section>
          <div class="report-comparison-grid"><article v-for="item in reportComparisons" :key="item.key" :class="['report-comparison-card', `comparison-${item.comparison.direction}`]"><div class="report-comparison-heading"><span>{{ item.label }}</span><span class="comparison-arrow">{{ item.comparison.direction === 'up' ? '↗' : item.comparison.direction === 'down' ? '↘' : '→' }}</span></div><strong>{{ item.comparison.current }}</strong><span class="report-comparison-delta">{{ formatReportDelta(item.comparison) }}</span><small>{{ item.foot }}</small></article></div>
        </section>

        <section id="report-tab-panel-work" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-work" v-show="reportTab === 'work'"><div class="content-grid report-grid report-primary-grid"><section class="panel report-panel report-work-panel"><div class="panel-heading"><div><div class="eyebrow">COMPLETED WORK</div><h3>主要完成事項</h3></div><span class="report-count">{{ report.totals.sessions }} 個 Session</span></div><div v-if="report.completedWork.length === 0" class="empty-state report-empty"><strong>這段期間沒有完成工作</strong><p>選擇其他區間，或先讓記錄中的專案完成一次 session。</p></div><button v-for="session in report.completedWork" :key="session.id" class="report-completed-row" type="button" @click="emit('openSession', session)"><div class="session-marker"></div><div class="session-main"><strong>{{ session.title }}</strong><p class="report-summary-preview">{{ formatReadableSummary(session.summary) }}</p><span>{{ session.projectName }} · {{ formatDate(session.completedAt) }}</span></div><span :class="['verification-badge', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabels[session.verification?.status ?? 'not_supplied'] }}</span><span class="session-arrow">↗</span></button></section><section class="panel report-panel report-verification-panel"><div class="panel-heading"><div><div class="eyebrow">VERIFICATION STATUS</div><h3>Verification 狀態</h3></div><span class="report-count">{{ report.totals.sessions }} 個 Session</span></div><div class="report-verification-list"><div v-for="item in reportVerification" :key="item.status" class="report-verification-row"><div class="report-progress-label"><span>{{ item.label }}</span><strong>{{ item.count }}</strong></div><div class="report-progress"><span :class="`verification-fill-${item.status}`" :style="{ width: `${item.percent}%` }"></span></div></div></div><p class="report-panel-note">待 Agent 回報代表沒有結構化 verification；未執行則代表 Agent 明確表示尚未驗證。報告不會替 Agent 推測驗證結果。</p></section></div></section>

        <section id="report-tab-panel-trend" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-trend" v-show="reportTab === 'trend'"><div class="content-grid report-grid report-secondary-grid"><section class="panel report-panel report-trend-panel"><div class="panel-heading"><div><div class="eyebrow">ACTIVITY TREND</div><h3>工作節奏</h3></div><span class="report-count">{{ report.trends.length }} {{ report.trendGranularity === 'month' ? '個月' : '天' }}</span></div><div class="report-trend-legend"><span><i class="trend-legend-sessions"></i>工作 Session</span><span><i class="trend-legend-events"></i>事件</span></div><div class="report-trend-chart"><div v-for="(point, index) in report.trends" :key="point.date" class="report-trend-column" :title="`${point.date} · ${point.sessions} 個 Session · ${point.events} 個事件`"><div class="report-trend-bars"><span class="trend-bar trend-bar-sessions" :style="{ height: reportTrendHeight(point.sessions, report) }"></span><span class="trend-bar trend-bar-events" :style="{ height: reportTrendHeight(point.events, report) }"></span></div><small v-if="shouldShowTrendLabel(index, report.trends.length)">{{ formatReportTrendLabel(point.date, report.trendGranularity) }}</small></div></div><p v-if="report.trends.every((point) => point.sessions === 0)" class="report-panel-note">這段期間尚未有工作活動，趨勢會在新的 Session 完成後出現。</p></section><section class="panel report-panel report-project-panel"><div class="panel-heading"><div><div class="eyebrow">PROJECT BREAKDOWN</div><h3>專案分布</h3></div><span class="report-count">{{ report.projects.length }}</span></div><div v-if="report.projects.length === 0" class="empty-state report-empty"><strong>沒有專案資料</strong><p>這段期間沒有可顯示的 tracked project。</p></div><div v-for="project in report.projects" :key="project.projectId" class="report-project-row"><div class="project-avatar">{{ project.projectName.slice(0, 1).toUpperCase() }}</div><div class="report-project-info"><strong>{{ project.projectName }}</strong><span>{{ project.sessionCount }} 個 Session · {{ project.eventCount }} 個事件</span></div><span class="report-source-count">{{ project.sourceSessionIds.length }} 個來源</span></div></section></div></section>

        <section id="report-tab-panel-risks" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-risks" v-show="reportTab === 'risks'"><div class="report-insights-grid"><section class="panel report-panel report-insight-panel"><div class="panel-heading"><div><div class="eyebrow">RISKS TO REVIEW</div><h3>風險與待確認事項</h3></div><span class="report-count">{{ report.risks.length }}</span></div><div v-if="report.risks.length === 0" class="empty-state report-empty"><strong>目前沒有資料型風險</strong><p>目前期間的報告資料沒有偵測到需要提醒的項目。</p></div><button v-for="insight in report.risks" :key="`${insight.kind}-${insight.label}`" class="report-insight-row" type="button" @click="emit('openReportSession', insight.sourceSessionIds[0])"><div class="report-insight-heading"><span class="report-insight-kind">{{ insightKindLabels[insight.kind] }}</span><strong>{{ insight.label }}</strong></div><p>{{ insight.detail }}</p><small>{{ insight.sourceSessionIds.length }} 筆來源 Session · 查看第一筆 ↗</small></button></section><section class="panel report-panel report-insight-panel"><div class="panel-heading"><div><div class="eyebrow">DECISIONS &amp; CLOSING</div><h3>風險／決策</h3></div><span class="report-count">{{ report.decisions.length }}</span></div><div v-if="report.decisions.length === 0" class="empty-state report-empty"><strong>這段期間沒有決策事件</strong><p>Agent 提交 note 或 closing event 後，會在這裡保留來源。</p></div><button v-for="decision in report.decisions" :key="`${decision.sessionId}-${decision.occurredAt}`" class="report-decision-row" type="button" @click="emit('openReportSession', decision.sessionId)"><div class="report-decision-copy"><strong>{{ decision.summary }}</strong><span>{{ decision.sessionTitle }} · {{ formatDate(decision.occurredAt) }}</span></div><span class="session-arrow">↗</span></button></section></div></section>

        <section id="report-tab-panel-raw" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-raw" v-show="reportTab === 'raw'"><details class="report-raw-details" open><summary><span><span class="eyebrow">RAW WORK RECORDS</span><strong>原始工作紀錄</strong></span><span class="report-count">{{ reportSessionPageInfo.total }} 個 Session</span></summary><div v-if="reportSessionLoading" class="report-raw-loading"><span class="spinner small-spinner"></span><span>正在載入原始 Session…</span></div><div v-else-if="reportSessionItems.length" class="report-raw-session-list"><VirtualList :items="reportSessionItems" :enabled="reportSessionPageSize === 'all'" aria-label="報告原始工作紀錄清單"><template #default="{ item: session }"><button class="report-raw-session-row" type="button" @click="emit('openSession', session)"><span class="session-marker"></span><span class="report-raw-session-copy"><strong>{{ session.title }}</strong><span>{{ session.projectName }} · {{ formatDate(session.completedAt) }}</span><small>{{ formatReadableSummary(session.summary) }}</small></span><span :class="['verification-badge', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabel(session.verification?.status) }}</span><span class="session-arrow">↗</span></button></template></VirtualList></div><div v-else class="report-empty report-empty-compact"><strong>這段期間沒有原始 Session</strong><p>請切換報告期間或專案範圍。</p></div><div v-if="reportSessionPageInfo.total > 0" class="pagination-bar report-list-pagination-bar"><span class="pagination-summary">顯示 {{ reportSessionPageInfo.from }}–{{ reportSessionPageInfo.to }}，共 {{ reportSessionPageInfo.total }} 筆<span v-if="reportSessionPageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ reportSessionPageInfo.pageSize }} 筆</span></span><label class="pagination-page-size"><span>每頁</span><select v-model="reportSessionPageSizeModel" aria-label="報告原始工作紀錄每頁筆數" @change="emit('changeReportSessionPageSize')"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label><div v-if="reportSessionPageInfo.totalPages > 1" class="pagination-controls"><button class="pagination-button" type="button" :disabled="!reportSessionPageInfo.hasPrevious" @click="emit('changeReportSessionPage', reportSessionPageInfo.page - 1)">上一頁</button><span>第 {{ reportSessionPageInfo.page }} / {{ reportSessionPageInfo.totalPages }} 頁</span><button class="pagination-button" type="button" :disabled="!reportSessionPageInfo.hasNext" @click="emit('changeReportSessionPage', reportSessionPageInfo.page + 1)">下一頁</button></div><span v-else class="pagination-current">共 {{ reportSessionPageInfo.total }} 筆</span></div></details></section>

        <section id="report-tab-panel-evidence" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-evidence" v-show="reportTab === 'evidence'"><section class="panel report-panel report-evidence-panel"><div class="panel-heading"><div><div class="eyebrow">SOURCE EVIDENCE</div><h3>來源證據</h3></div><span class="report-count">{{ report.evidencePageInfo.total }} 筆</span></div><form class="report-evidence-tools" @submit.prevent="emit('loadReportEvidence', true)"><label class="report-evidence-search"><span>⌕</span><input v-model="reportEvidenceQueryModel" type="search" placeholder="搜尋 Session、來源或證據內容" /></label><label class="report-evidence-kind"><span>類型</span><select v-model="reportEvidenceKindModel" aria-label="依 Evidence 類型篩選" @change="emit('loadReportEvidence', true)"><option value="">所有類型</option><option v-for="(label, kind) in evidenceKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><button class="text-button report-evidence-filter-button" type="submit" :disabled="reportEvidenceLoading">{{ reportEvidenceLoading ? '更新中…' : '套用篩選' }}</button></form><div v-if="reportEvidenceLoading" class="report-evidence-inline-loading"><span class="spinner small-spinner"></span><span>正在更新來源證據…</span></div><div v-else-if="report.evidence.length === 0" class="empty-state report-empty"><strong>尚無可呈現的證據</strong><p>完成 session 時提供 handoff、verification、changed files 或 event，報告就能建立追溯線索。</p></div><div v-else :class="['report-evidence-list', { 'report-evidence-list-virtualized': reportEvidencePageSize === 'all' }]"><VirtualList v-if="reportEvidencePageSize === 'all'" :items="report.evidence" :enabled="true" aria-label="報告來源證據清單" :estimate-item-height="94"><template #default="{ item }"><button class="report-evidence-row" type="button" @click="emit('openReportEvidence', item)"><span :class="['report-evidence-icon', `evidence-${item.kind}`]">{{ item.kind === 'handoff' ? 'H' : item.kind === 'verification' ? 'V' : item.kind === 'changed-files' ? 'F' : item.kind === 'attached' ? 'A' : 'E' }}</span><div class="report-evidence-copy"><div><span class="report-evidence-kind">{{ evidenceKindLabel(item.kind) }}</span><strong>{{ item.label }}</strong></div><p>{{ item.detail }}</p><small>{{ item.sessionTitle }}<span v-if="item.projectName"> · {{ item.projectName }}</span><span v-if="item.reference"> · {{ item.reference }}</span></small></div><span class="session-arrow">↗</span></button></template></VirtualList><template v-else><button v-for="item in report.evidence" :key="`${item.sessionId}-${item.kind}-${item.label}`" class="report-evidence-row" type="button" @click="emit('openReportEvidence', item)"><span :class="['report-evidence-icon', `evidence-${item.kind}`]">{{ item.kind === 'handoff' ? 'H' : item.kind === 'verification' ? 'V' : item.kind === 'changed-files' ? 'F' : item.kind === 'attached' ? 'A' : 'E' }}</span><div class="report-evidence-copy"><div><span class="report-evidence-kind">{{ evidenceKindLabels[item.kind] }}</span><strong>{{ item.label }}</strong></div><p>{{ item.detail }}</p><small>{{ item.sessionTitle }}<span v-if="item.projectName"> · {{ item.projectName }}</span><span v-if="item.reference"> · {{ item.reference }}</span></small></div><span class="session-arrow">↗</span></button></template></div><div v-if="report.evidencePageInfo.total > 0" class="pagination-bar report-list-pagination-bar"><span class="pagination-summary">顯示 {{ report.evidencePageInfo.from }}–{{ report.evidencePageInfo.to }}，共 {{ report.evidencePageInfo.total }} 筆<span v-if="report.evidencePageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ report.evidencePageInfo.pageSize }} 筆</span></span><label class="pagination-page-size"><span>每頁</span><select v-model="reportEvidencePageSizeModel" aria-label="報告來源證據每頁筆數" @change="emit('changeReportEvidencePageSize')"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label><div v-if="report.evidencePageInfo.totalPages > 1" class="pagination-controls"><button class="pagination-button" type="button" :disabled="!report.evidencePageInfo.hasPrevious" @click="emit('changeReportEvidencePage', report.evidencePageInfo.page - 1)">上一頁</button><span>第 {{ report.evidencePageInfo.page }} / {{ report.evidencePageInfo.totalPages }} 頁</span><button class="pagination-button" type="button" :disabled="!report.evidencePageInfo.hasNext" @click="emit('changeReportEvidencePage', report.evidencePageInfo.page + 1)">下一頁</button></div><span v-else class="pagination-current">共 {{ report.evidencePageInfo.total }} 筆</span></div></section></section>
      </div>
    </template>
    <div v-else class="empty-state large-empty report-empty-state"><div class="empty-icon">▥</div><strong>尚未產生報告</strong><p>切換到報表後，系統會從已授權的工作紀錄建立摘要。</p></div>
  </section>
</template>
