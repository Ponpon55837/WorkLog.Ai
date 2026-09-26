<script setup lang="ts">
import { ChartColumn, Download, FolderGit2, RefreshCw, Search } from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import PageToolbar from "../components/layout/PageToolbar.vue";
import ReportEvidencePanel from "../components/domain/ReportEvidencePanel.vue";
import ReportOverviewPanel from "../components/domain/ReportOverviewPanel.vue";
import ReportRawRecordsPanel from "../components/domain/ReportRawRecordsPanel.vue";
import ReportRisksPanel from "../components/domain/ReportRisksPanel.vue";
import ReportTrendPanel from "../components/domain/ReportTrendPanel.vue";
import ReportWorkPanel from "../components/domain/ReportWorkPanel.vue";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiDateRangeMenu from "../components/ui/UiDateRangeMenu.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiIconButton from "../components/ui/UiIconButton.vue";
import UiSegmentedControl from "../components/ui/UiSegmentedControl.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import { useReportsView } from "../composables/useReportsView";

const {
  description,
  reportPeriod,
  periodOptions,
  reportRange,
  reportDatePickerRange,
  reportProjectId,
  projectLabel,
  projectItems,
  exportItems,
  reportLoading,
  reportExportLoading,
  loadReport,
  exportReport,
  reportError,
  report,
  tab,
  tabs,
  reportEvidenceQuery,
  reportComparisons,
  reportSessionLoading,
  reportSessionItems,
  reportSessionPageInfo,
  reportSessionPageSize,
  reportEvidenceLoading,
  reportEvidencePageSize,
  reportEvidenceKind,
  openSession,
  openReportSession,
  openReportEvidence,
  changeRawPage,
  changeEvidencePage,
} = useReportsView();
</script>

<template>
  <PageHeader :description="description">
    <template #actions>
      <UiSegmentedControl v-model="reportPeriod" :options="periodOptions" label="選擇報表區間" />
      <div class="reports__period-control" data-testid="report-period-date-control">
        <!-- The report API requires both bounds and has no unbounded custom-range mode. -->
        <UiDateRangeMenu
          v-if="reportPeriod === 'custom'"
          v-model="reportRange"
          variant="button"
          label="自訂期間"
          :allow-all-dates="false"
        />
        <UiDateRangeMenu
          v-else
          v-model="reportDatePickerRange"
          selection-mode="single"
          variant="button"
          label="選擇報告日期"
        />
      </div>
      <UiActionMenu
        v-model="reportProjectId"
        :label="projectLabel"
        :icon="FolderGit2"
        variant="button"
        header="專案範圍"
        default-value=""
        align="end"
        :items="projectItems"
      />
      <UiActionMenu
        label="匯出"
        :icon="Download"
        variant="button"
        align="end"
        :items="exportItems"
        @select="exportReport"
      />
      <UiIconButton
        :icon="RefreshCw"
        label="重新整理報告"
        variant="default"
        :loading="reportLoading || Boolean(reportExportLoading)"
        @click="loadReport(true)"
      />
    </template>
  </PageHeader>

  <UiFlash v-if="reportError" tone="danger">{{ reportError }}</UiFlash>
  <UiSkeleton v-if="reportLoading && !report" variant="card" :count="4" />
  <UiEmptyState
    v-else-if="!report"
    :icon="ChartColumn"
    title="尚未產生報告"
    description="選擇區間後，系統會從已授權的工作紀錄建立 deterministic 報告。"
  />

  <template v-else>
    <UiFlash
      v-if="report.sessionTruncation?.currentPeriod || report.sessionTruncation?.previousPeriod"
      tone="attention"
      title="報告只涵蓋部分資料"
      data-testid="report-session-truncation"
    >
      <span v-if="report.sessionTruncation?.currentPeriod">本期超過 200 個 Session 的報告上限；</span>
      <span v-if="report.sessionTruncation?.previousPeriod">比較期間超過 200 個 Session 的報告上限；</span>
      摘要、趨勢、專案占比與比較數值只依納入報告的 Session 計算。
    </UiFlash>

    <PageToolbar>
      <UiUnderlineNav v-model="tab" :items="tabs" label="工作報告內容分頁" id-prefix="report" />
      <div v-if="tab === 'evidence'" class="reports__evidence-search">
        <UiTextInput
          v-model="reportEvidenceQuery"
          type="search"
          :icon="Search"
          label="搜尋來源證據"
          placeholder="搜尋 Session、來源或證據內容"
        />
      </div>
    </PageToolbar>

    <ReportOverviewPanel
      v-if="tab === 'overview'"
      :report="report"
      :report-comparisons="reportComparisons"
      @open="openSession"
      @show-all="tab = 'raw'"
    />
    <ReportWorkPanel
      v-else-if="tab === 'work'"
      :report="report"
      @open="openSession"
      @open-report-session="openReportSession"
    />
    <ReportTrendPanel v-else-if="tab === 'trend'" :report="report" />
    <ReportRisksPanel v-else-if="tab === 'risks'" :report="report" @open-report-session="openReportSession" />
    <ReportRawRecordsPanel
      v-else-if="tab === 'raw'"
      v-model:page-size="reportSessionPageSize"
      :items="reportSessionItems"
      :loading="reportSessionLoading"
      :page-info="reportSessionPageInfo"
      @page="changeRawPage"
      @open="openSession"
    />
    <ReportEvidencePanel
      v-else
      v-model:page-size="reportEvidencePageSize"
      v-model:kind="reportEvidenceKind"
      :report="report"
      :loading="reportEvidenceLoading"
      @page="changeEvidencePage"
      @open="openReportEvidence"
    />
  </template>
</template>

<style scoped>
.reports__period-control {
  flex: 0 0 236px;
  width: 236px;
  min-width: 0;
}

.reports__period-control :deep(.ui-date-range__trigger),
.reports__period-control :deep(.ui-text-input) {
  width: 100%;
}

.reports__period-control :deep(.ui-date-range__trigger) {
  justify-content: space-between;
}

.reports__evidence-search {
  flex: 1 1 100%;
  padding: var(--space-2) 0;
}

@media (max-width: 639px) {
  .reports__period-control {
    flex: 1 1 100%;
    width: 100%;
  }
}
</style>
