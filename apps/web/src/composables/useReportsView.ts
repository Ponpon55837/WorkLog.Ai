import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import { CircleCheckBig, Download, FileText, LayoutDashboard, Link, TrendingUp, TriangleAlert } from "lucide-vue-next";
import type { ReportEvidence, ReportExportFormat, WorkSessionRecord } from "@work-intelligence/core";
import { enumQuery, stringQuery, useRouteQuery } from "../composables/useRouteQuery";
import { router } from "../router";
import { useProjectsStore } from "../stores/projects";
import { useReportsStore, type ReportViewPeriod } from "../stores/reports";
import { useSessionsStore } from "../stores/sessions";
import { toDateInputValue } from "../utils/format";
import { reportPeriodLabels, reportTabOptions, type ReportTab } from "../utils/labels";
import { t } from "../i18n";

function createReportsViewModel() {
  const route = useRoute();

  const projectsStore = useProjectsStore();
  const { trackedProjects } = storeToRefs(projectsStore);

  const reportsStore = useReportsStore();

  const {
    report,
    reportPeriod,
    reportDate,
    reportRange,
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
  } = storeToRefs(reportsStore);

  const { loadReport, refreshReport, loadReportEvidence, exportReport } = reportsStore;

  const sessionsStore = useSessionsStore();
  const { openSessionDetail, setSessionSequence } = sessionsStore;

  const periods: ReportViewPeriod[] = ["day", "week", "month", "quarter", "year", "custom"];

  const reportFrom = computed({
    get: () => reportRange.value.from,
    set: (from: string) => (reportRange.value = { ...reportRange.value, from }),
  });

  const reportTo = computed({
    get: () => reportRange.value.to,
    set: (to: string) => (reportRange.value = { ...reportRange.value, to }),
  });

  const reportDatePickerRange = computed({
    get: () => ({ from: reportDate.value, to: reportDate.value }),
    set: (range: { from: string; to: string }) => (reportDate.value = range.from || range.to),
  });

  useRouteQuery("period", reportPeriod, enumQuery(periods, "week"));

  useRouteQuery("date", reportDate, stringQuery(toDateInputValue(new Date())));

  useRouteQuery("from", reportFrom, stringQuery());

  useRouteQuery("to", reportTo, stringQuery());

  useRouteQuery("project", reportProjectId, stringQuery());

  function setDefaultCustomRange(): void {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 13);
    reportRange.value = { from: toDateInputValue(start), to: toDateInputValue(today) };
  }

  function hasIncompleteCustomRange(): boolean {
    return !reportRange.value.from || !reportRange.value.to;
  }

  if (reportPeriod.value === "custom" && hasIncompleteCustomRange()) {
    setDefaultCustomRange();
  }

  watch([reportPeriod, reportDate, reportRange, reportProjectId], ([period]) => {
    if (period === "custom" && hasIncompleteCustomRange()) {
      setDefaultCustomRange();
      return;
    }
    void loadReport(true);
  });

  void loadReport(true);

  const tabIds = reportTabOptions.map((option) => option.id);

  const tab = computed<ReportTab>({
    get: () => (tabIds.includes(route.params.tab as ReportTab) ? (route.params.tab as ReportTab) : "overview"),
    set: (value) =>
      void router.replace({
        name: "reports",
        params: { tab: value === "overview" ? undefined : value },
        query: route.query,
      }),
  });

  const tabIcons = {
    overview: LayoutDashboard,
    work: CircleCheckBig,
    trend: TrendingUp,
    risks: TriangleAlert,
    raw: FileText,
    evidence: Link,
  } as const;

  const tabs = computed(() =>
    reportTabOptions.map((option) => ({
      value: option.id,
      label: option.shortLabel,
      icon: tabIcons[option.id],
      count: tabCount(option.id),
    })),
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
      evidence: current.evidencePageInfo.total,
    };
    return counts[id];
  }

  const periodShortLabels: Record<ReportViewPeriod, string> = {
    day: t("日"),
    week: t("週"),
    month: t("月"),
    quarter: t("季"),
    year: t("年"),
    custom: t("自訂"),
  };

  const periodOptions = periods.map((period) => ({ value: period, label: periodShortLabels[period] }));

  const projectItems = computed(() => [
    { value: "", label: t("所有記錄中專案") },
    ...trackedProjects.value.map((project) => ({ value: project.id, label: project.name })),
  ]);

  const projectLabel = computed(
    () => projectItems.value.find((item) => item.value === reportProjectId.value)?.label ?? t("所有記錄中專案"),
  );

  const exportItems = [
    { value: "markdown" as ReportExportFormat, label: t("下載 Markdown"), icon: Download },
    { value: "json" as ReportExportFormat, label: t("匯出 JSON"), icon: Download },
  ];

  const description = computed(() => {
    const current = report.value;
    return current
      ? t("{value} · {from} – {to}（{timezone}）· {projectLabel}", {
          value: reportPeriodLabels[current.period],
          from: current.range.from,
          to: current.range.to,
          timezone: current.timezone,
          projectLabel: projectLabel.value,
        })
      : t("報告只聚合「記錄中」的專案，並保留每筆來源 Session。");
  });

  function openSession(session: WorkSessionRecord, list: readonly WorkSessionRecord[]): void {
    setSessionSequence(list.map((item) => item.id));
    void openSessionDetail(session.id);
  }

  function openReportSession(sessionId: string | undefined): Promise<void> {
    return openSessionDetail(sessionId, t("無法載入來源 Session。"));
  }

  function openReportEvidence(evidence: ReportEvidence): Promise<void> {
    return openReportSession(evidence.sessionId);
  }

  function changeRawPage(page: number): void {
    reportSessionPage.value = page;
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
  });

  watch([reportEvidencePageSize, reportEvidenceKind], reloadEvidenceFromFirstPage);

  let evidenceTimer: number | undefined;

  watch(reportEvidenceQuery, () => {
    window.clearTimeout(evidenceTimer);
    evidenceTimer = window.setTimeout(reloadEvidenceFromFirstPage, 300);
  });

  onBeforeUnmount(() => {
    window.clearTimeout(evidenceTimer);
    reportsStore.setReportsActive(false);
  });

  return {
    description,
    report,
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
    refreshReport,
    exportReport,
    reportError,
    tab,
    tabs,
    reportEvidenceQuery,
    reportEvidenceLoading,
    reportEvidencePageSize,
    reportEvidenceKind,
    reportSessionLoading,
    reportSessionItems,
    reportSessionPageInfo,
    reportSessionPageSize,
    reportComparisons,
    openSession,
    openReportSession,
    openReportEvidence,
    changeRawPage,
    changeEvidencePage,
  };
}

/** Coordinates report filters, route state, and query interactions for the Reports view. */
export function useReportsView(): ReturnType<typeof createReportsViewModel> {
  return createReportsViewModel();
}
