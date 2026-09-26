import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type {
  PageInfo,
  ReportEvidence,
  ReportExportFormat,
  ReportPeriod,
  ReportSummary,
  ReportSynthesisRequest,
  WorkReport,
  WorkReportPeriod,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import { errorMessage, toDateInputValue } from "../utils/format";
import { pageSizeToQuery, type ListPageSize } from "../utils/labels";
import { emptyPageInfo } from "./sessions";
import { queryKeys } from "./query-keys";

export const reportSynthesisInstruction = "請處理我剛在 Work Intelligence 建立的報告提煉請求。";

/** A calendar period, or "custom" for the from/to range in reportRange. */
export type ReportViewPeriod = ReportPeriod | "custom";

type ReportSynthesisInput = {
  period: WorkReportPeriod;
  date?: string;
  from?: string;
  to?: string;
  projectId?: string;
  idempotencyKey: string;
};

const MAX_CUSTOM_DAYS = 366;

/** Owns report queries, synthesis mutations, and the reports view state. */
export const useReportsStore = defineStore("reports", () => {
  const queryCache = useQueryCache();
  const reportsActive = ref(false);
  const reportPeriod = ref<ReportViewPeriod>("week");
  const reportDate = ref(toDateInputValue(new Date()));
  const reportRange = ref<{ from: string; to: string }>({ from: "", to: "" });
  const reportProjectId = ref("");
  const reportBlocked = ref(false);
  const reportActionError = ref("");
  const reportLoadingState = ref(false);
  const reportExportLoading = ref<ReportExportFormat | null>(null);
  const reportEvidenceLoadingState = ref(false);
  const reportEvidencePage = ref(1);
  const reportEvidencePageSize = ref<ListPageSize>(10);
  const reportEvidenceKind = ref<ReportEvidence["kind"] | "">("");
  const reportEvidenceQuery = ref("");
  const reportEvidenceActive = ref(false);
  const reportSessionPage = ref(1);
  const reportSessionPageSize = ref<ListPageSize>(10);
  const reportSessionLoadingState = ref(false);
  const reportSessionError = ref("");
  const reportSynthesisLoadingState = ref(false);
  const reportSynthesisActionError = ref("");
  const selectedSummaryId = ref("");

  function reportScope(): { period: ReportPeriod; date?: string; from?: string; to?: string; projectId?: string } {
    const projectId = reportProjectId.value || undefined;
    if (reportPeriod.value === "custom") {
      // The server ignores period when from/to are given; it still needs a valid value.
      return { period: "week", from: reportRange.value.from, to: reportRange.value.to, projectId };
    }
    return { period: reportPeriod.value, date: reportDate.value || undefined, projectId };
  }

  function synthesisRequestScope(): Omit<ReturnType<typeof reportScope>, "period"> & { period: WorkReportPeriod } {
    const scope = reportScope();
    const period: WorkReportPeriod = reportPeriod.value === "custom" ? "custom" : scope.period;
    return { ...scope, period };
  }

  /** Without a project, only all-project syntheses belong to this report. */
  function synthesisScope(): ReturnType<typeof synthesisRequestScope> & { scopeType?: "all" } {
    const scope = synthesisRequestScope();
    return scope.projectId ? scope : { ...scope, scopeType: "all" };
  }

  function evidenceScope() {
    return {
      ...reportScope(),
      evidencePage: reportEvidencePage.value,
      evidencePageSize: reportEvidencePageSize.value,
      evidenceKind: reportEvidenceKind.value || undefined,
      evidenceQuery: reportEvidenceQuery.value.trim() || undefined,
    };
  }

  function evidenceScopeKey(): string {
    return JSON.stringify(evidenceScope());
  }

  const reportQuery = useQuery({
    key: queryKeys.reports.report,
    enabled: reportsActive,
    query: ({ signal }) => useApi().client.getReport(evidenceScope(), signal),
  });
  const baseReport = computed<WorkReport | null>(() => {
    if (reportBlocked.value) return null;
    const result = reportQuery.data.value;
    return result?.outcome === "report" ? result : null;
  });
  const evidenceQuery = useQuery({
    key: queryKeys.reports.evidence,
    enabled: computed(() => reportsActive.value && reportEvidenceActive.value && Boolean(baseReport.value)),
    query: async ({ signal }) => ({
      scopeKey: evidenceScopeKey(),
      result: await useApi().client.getReport(evidenceScope(), signal),
    }),
  });
  const reportSessionsQuery = useQuery({
    key: queryKeys.reports.sessions,
    enabled: computed(() => reportsActive.value && Boolean(baseReport.value)),
    query: ({ signal }) => {
      const current = baseReport.value;
      if (!current) throw new Error("A report must be loaded before its source Sessions.");
      return useApi().client.listSessions(
        {
          from: current.range.from,
          to: current.range.to,
          projectId: reportProjectId.value || undefined,
          page: reportSessionPage.value,
          pageSize: reportSessionPageSize.value,
        },
        signal,
      );
    },
  });
  const synthesisQuery = useQuery({
    key: queryKeys.reports.synthesis,
    enabled: computed(() => reportsActive.value && Boolean(baseReport.value)),
    query: async ({ signal }) => {
      const scope = synthesisScope();
      const [requests, summaries] = await Promise.all([
        useApi().client.listReportSynthesisRequests({ ...scope, limit: 10 }, signal),
        useApi().client.listReportSummaries({ ...scope, currentOnly: false }, signal),
      ]);
      return { requests, summaries };
    },
  });

  const createSynthesisMutation = useMutation({
    mutation: (input: ReportSynthesisInput) => useApi().client.createReportSynthesisRequest(input),
    onSuccess: async (result) => {
      if (result.outcome !== "report_synthesis_request") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.reports.synthesis }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
      ]);
    },
  });
  const retrySynthesisMutation = useMutation({
    mutation: (requestId: string) => useApi().client.retryReportSynthesisRequest(requestId),
    onSuccess: async (result) => {
      if (result.outcome !== "report_synthesis_request_retried") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.reports.synthesis }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
      ]);
    },
  });
  const cancelSynthesisMutation = useMutation({
    mutation: (requestId: string) => useApi().client.cancelReportSynthesisRequest(requestId),
    onSuccess: async (result) => {
      if (result.outcome !== "report_synthesis_request_cancelled") return;
      await Promise.all([
        queryCache.invalidateQueries({ key: queryKeys.reports.synthesis }),
        queryCache.invalidateQueries({ key: queryKeys.dashboard.overview, exact: true }),
      ]);
    },
  });
  const deleteSynthesisMutation = useMutation({
    mutation: (summaryId: string) => useApi().client.deleteReportSummary(summaryId),
    onSuccess: async (result) => {
      if (result.outcome !== "report_summary_deleted") return;
      await queryCache.invalidateQueries({ key: queryKeys.reports.synthesis });
    },
  });

  const report = computed<WorkReport | null>(() => {
    const result = baseReport.value;
    if (!result) return null;
    const evidenceResult = evidenceQuery.data.value;
    if (evidenceResult?.scopeKey === evidenceScopeKey() && evidenceResult.result.outcome === "report") {
      return {
        ...result,
        evidence: evidenceResult.result.evidence,
        evidencePageInfo: evidenceResult.result.evidencePageInfo,
      };
    }
    return result;
  });
  const reportLoading = computed(() => reportLoadingState.value || reportQuery.isLoading.value);
  const reportError = computed(() => {
    if (reportActionError.value) return reportActionError.value;
    if (reportQuery.error.value) return errorMessage(reportQuery.error.value, "無法載入工作報告。");
    const result = reportQuery.data.value;
    return result?.outcome === "skipped" ? result.reason : "";
  });
  const reportEvidenceLoading = computed(() => reportEvidenceLoadingState.value || evidenceQuery.isLoading.value);
  const reportSessionItems = computed<WorkSessionRecord[]>(() => reportSessionsQuery.data.value?.items ?? []);
  const reportSessionPageInfo = computed<PageInfo>(
    () =>
      reportSessionsQuery.data.value?.pageInfo ?? {
        ...emptyPageInfo,
        pageSize: pageSizeToQuery(reportSessionPageSize.value),
      },
  );
  const reportSessionLoading = computed(() => reportSessionLoadingState.value || reportSessionsQuery.isLoading.value);
  const reportSynthesisRequest = computed<ReportSynthesisRequest | null>(() => {
    if (!report.value) return null;
    const result = synthesisQuery.data.value?.requests;
    return result?.outcome === "report_synthesis_requests" ? (result.requests[0] ?? null) : null;
  });
  const reportSynthesisHistory = computed<ReportSummary[]>(() => {
    if (!report.value) return [];
    const result = synthesisQuery.data.value?.summaries;
    return result?.outcome === "report_summaries" ? result.summaries : [];
  });
  const reportSynthesisSummary = computed<ReportSummary | null>(() => {
    const summaries = reportSynthesisHistory.value;
    return (
      summaries.find((summary) => summary.id === selectedSummaryId.value) ??
      summaries.find((summary) => summary.isCurrent) ??
      summaries[0] ??
      null
    );
  });
  const reportSynthesisLoading = computed(() => reportSynthesisLoadingState.value || synthesisQuery.isLoading.value);
  const reportSynthesisError = computed(() => {
    if (reportSynthesisActionError.value) return reportSynthesisActionError.value;
    if (reportSessionError.value) return reportSessionError.value;
    if (synthesisQuery.error.value) return errorMessage(synthesisQuery.error.value, "無法載入報告提煉狀態。");
    const requests = synthesisQuery.data.value?.requests;
    if (requests?.outcome === "skipped") return requests.reason;
    const summaries = synthesisQuery.data.value?.summaries;
    return summaries?.outcome === "skipped" ? summaries.reason : "";
  });
  const reportSynthesisIsActive = computed(() => {
    const status = reportSynthesisRequest.value?.status;
    return status === "pending" || status === "processing";
  });
  const reportSynthesisCanRetry = computed(() => {
    const status = reportSynthesisRequest.value?.status;
    return status === "failed" || status === "cancelled";
  });
  const reportComparisons = computed(() => {
    if (!report.value) return [];
    return [
      { key: "sessions", label: "完成 Sessions", comparison: report.value.comparison.sessions, foot: "與上一期比較" },
      { key: "events", label: "Recorded Events", comparison: report.value.comparison.events, foot: "可追溯事件" },
      {
        key: "changedFiles",
        label: "Changed Files",
        comparison: report.value.comparison.changedFiles,
        foot: "不等同 Git commit",
      },
    ];
  });

  watch(synthesisQuery.data, () => {
    selectedSummaryId.value = "";
  });
  watch(
    () => reportSessionsQuery.data.value?.pageInfo.page,
    (loadedPage) => {
      if (loadedPage !== undefined && reportSessionPage.value !== loadedPage) {
        reportSessionPage.value = loadedPage;
      }
    },
  );

  function setReportsActive(active: boolean): void {
    reportsActive.value = active;
  }

  function customRangeProblem(): string {
    const { from, to } = reportRange.value;
    if (!from || !to) return "請選擇自訂期間的起訖日期。";
    const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000 + 1;
    return days > MAX_CUSTOM_DAYS ? "自訂期間最長 " + MAX_CUSTOM_DAYS + " 天。" : "";
  }

  async function loadReport(resetEvidencePage = false): Promise<void> {
    if (resetEvidencePage) reportEvidencePage.value = 1;
    if (reportPeriod.value === "custom" && customRangeProblem()) {
      reportBlocked.value = true;
      reportActionError.value = customRangeProblem();
      return;
    }
    reportBlocked.value = false;
    reportActionError.value = "";
    reportLoadingState.value = true;
    reportsActive.value = true;
    try {
      await reportQuery.refetch(true);
      if (reportQuery.data.value?.outcome === "report") {
        await Promise.all([loadReportSynthesis(), loadReportSessions(resetEvidencePage)]);
      }
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        reportBlocked.value = true;
        reportActionError.value = errorMessage(error, "無法載入工作報告。");
      }
    } finally {
      reportLoadingState.value = false;
    }
  }

  async function loadReportSessions(resetPage = false): Promise<void> {
    if (resetPage) reportSessionPage.value = 1;
    if (!report.value) {
      reportSessionError.value = "";
      return;
    }
    reportSessionLoadingState.value = true;
    reportSessionError.value = "";
    try {
      await reportSessionsQuery.refetch(true);
      if (reportSessionsQuery.error.value) {
        reportSessionError.value = errorMessage(reportSessionsQuery.error.value, "無法載入報告原始 Session。");
      }
    } catch (error) {
      if (!useApi().isAbortError(error)) reportSessionError.value = errorMessage(error, "無法載入報告原始 Session。");
    } finally {
      reportSessionLoadingState.value = false;
    }
  }

  async function loadReportEvidence(): Promise<void> {
    if (!report.value) return;
    reportEvidenceActive.value = true;
    reportEvidenceLoadingState.value = true;
    reportActionError.value = "";
    try {
      await evidenceQuery.refetch(true);
      const result = evidenceQuery.data.value?.result;
      if (result?.outcome === "skipped") reportActionError.value = result.reason;
      if (evidenceQuery.error.value)
        reportActionError.value = errorMessage(evidenceQuery.error.value, "無法更新來源證據。");
    } catch (error) {
      if (!useApi().isAbortError(error)) reportActionError.value = errorMessage(error, "無法更新來源證據。");
    } finally {
      reportEvidenceLoadingState.value = false;
    }
  }

  async function loadReportSynthesis(): Promise<void> {
    if (!report.value) return;
    reportSynthesisLoadingState.value = true;
    reportSynthesisActionError.value = "";
    try {
      await synthesisQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        reportSynthesisActionError.value = errorMessage(error, "無法載入報告提煉狀態。");
      }
    } finally {
      reportSynthesisLoadingState.value = false;
    }
  }

  /** Re-checks without the loading indicator while an Agent is working on a request. */
  async function refreshReportSynthesis(): Promise<void> {
    if (!report.value) return;
    try {
      await synthesisQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) {
        reportSynthesisActionError.value = errorMessage(error, "無法載入報告提煉狀態。");
      }
    }
  }

  function selectReportSynthesisVersion(summary: ReportSummary): void {
    selectedSummaryId.value = summary.id;
  }

  async function createReportSynthesisRequest(): Promise<void> {
    if (
      !report.value ||
      createSynthesisMutation.isLoading.value ||
      (reportPeriod.value === "custom" && customRangeProblem().length > 0)
    )
      return;
    reportSynthesisActionError.value = "";
    try {
      const result = await createSynthesisMutation.mutateAsync({
        ...synthesisRequestScope(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.outcome !== "report_synthesis_request") {
        reportSynthesisActionError.value = result.reason;
        return;
      }
      useToast().showToast(
        reportSynthesisSummary.value
          ? "已建立重新提煉請求。上一版摘要會先保留，新的 Agent 摘要完成後才會替換。"
          : "報告請求已建立。請在目前的 Agent 對話中說：「" + reportSynthesisInstruction + "」",
      );
    } catch (error) {
      reportSynthesisActionError.value = errorMessage(error, "建立報告提煉請求失敗。");
    }
  }

  async function retryReportSynthesisRequest(): Promise<void> {
    const requestToRetry = reportSynthesisRequest.value;
    if (!requestToRetry || !reportSynthesisCanRetry.value || retrySynthesisMutation.isLoading.value) return;
    reportSynthesisActionError.value = "";
    try {
      const result = await retrySynthesisMutation.mutateAsync(requestToRetry.id);
      if (result.outcome !== "report_synthesis_request_retried") {
        reportSynthesisActionError.value = "reason" in result ? result.reason : "這份報告目前無法重試。";
        return;
      }
      useToast().showToast("已重新建立提煉請求。請在目前的 Agent 對話中處理它。");
    } catch (error) {
      reportSynthesisActionError.value = errorMessage(error, "重新建立報告提煉請求失敗。");
    }
  }

  async function cancelReportSynthesisRequest(): Promise<void> {
    const requestToCancel = reportSynthesisRequest.value;
    if (!requestToCancel || !reportSynthesisIsActive.value || cancelSynthesisMutation.isLoading.value) return;
    if (
      !(await confirmAction({
        title: "取消這次報告提煉？",
        message: "既有報告與歷史版本會保留。",
        confirmLabel: "取消提煉",
        cancelLabel: "繼續等待",
        danger: true,
      }))
    )
      return;
    reportSynthesisActionError.value = "";
    try {
      const result = await cancelSynthesisMutation.mutateAsync(requestToCancel.id);
      if (result.outcome !== "report_synthesis_request_cancelled") {
        reportSynthesisActionError.value = "reason" in result ? result.reason : "這份報告目前無法取消。";
        return;
      }
      useToast().showToast("已取消這次報告提煉；既有報告與歷史版本仍然保留。");
    } catch (error) {
      reportSynthesisActionError.value = errorMessage(error, "取消報告提煉失敗。");
    }
  }

  async function deleteReportSynthesisVersion(summary: ReportSummary): Promise<void> {
    if (summary.isCurrent) return;
    if (
      !(await confirmAction({
        title: "移除這個歷史版本？",
        message: "「" + summary.title + "」將被移除，此操作無法復原。",
        confirmLabel: "移除版本",
        danger: true,
      }))
    )
      return;
    reportSynthesisActionError.value = "";
    try {
      const result = await deleteSynthesisMutation.mutateAsync(summary.id);
      if (result.outcome !== "report_summary_deleted") {
        reportSynthesisActionError.value = "reason" in result ? result.reason : "這個報告版本目前無法移除。";
        return;
      }
      useToast().showToast("已移除報告歷史版本。");
    } catch (error) {
      reportSynthesisActionError.value = errorMessage(error, "移除報告歷史版本失敗。");
    }
  }

  async function exportReport(format: ReportExportFormat): Promise<void> {
    const { showToast } = useToast();
    if (!report.value) {
      showToast("請先載入一份報告，再進行匯出。");
      return;
    }
    reportExportLoading.value = format;
    try {
      const result = await useApi().client.exportReport({
        ...reportScope(),
        format,
        evidenceKind: reportEvidenceKind.value || undefined,
        evidenceQuery: reportEvidenceQuery.value.trim() || undefined,
      });
      if (result.outcome !== "report_export") {
        showToast(result.reason);
        return;
      }
      const blob = new Blob([result.content], { type: result.contentType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast("已下載 " + (format === "markdown" ? "Markdown" : "JSON") + " 報告。");
    } catch (error) {
      showToast(errorMessage(error, "報告匯出失敗。"));
    } finally {
      reportExportLoading.value = null;
    }
  }

  return {
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
    reportSynthesisRequest,
    reportSynthesisSummary,
    reportSynthesisHistory,
    reportSynthesisLoading,
    reportSynthesisCreating: computed(() => createSynthesisMutation.isLoading.value),
    reportSynthesisRetrying: computed(() => retrySynthesisMutation.isLoading.value),
    reportSynthesisCancelling: computed(() => cancelSynthesisMutation.isLoading.value),
    reportSynthesisError,
    reportSynthesisIsActive,
    reportSynthesisCanRetry,
    reportComparisons,
    setReportsActive,
    loadReport,
    loadReportSessions,
    loadReportEvidence,
    loadReportSynthesis,
    refreshReportSynthesis,
    selectReportSynthesisVersion,
    createReportSynthesisRequest,
    retryReportSynthesisRequest,
    cancelReportSynthesisRequest,
    deleteReportSynthesisVersion,
    exportReport,
  };
});
