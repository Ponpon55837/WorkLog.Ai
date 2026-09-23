import { computed, ref } from "vue";
import type {
  PageInfo,
  ReportEvidence,
  ReportExportFormat,
  ReportPeriod,
  ReportSummary,
  ReportSynthesisRequest,
  WorkReport,
  WorkSessionRecord
} from "@work-intelligence/core";
import { pageSizeToQuery, verificationLabels, type ListPageSize, type ReportTab } from "../utils/labels";
import { errorMessage, toDateInputValue } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { emptyPageInfo } from "./useSessions";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

export const reportSynthesisInstruction = "請處理我剛在 Work Intelligence 建立的報告提煉請求。";

const report = ref<WorkReport | null>(null);
const reportPeriod = ref<ReportPeriod>("week");
const reportDate = ref(toDateInputValue(new Date()));
const reportProjectId = ref("");
const reportTab = ref<ReportTab>("overview");
const reportLoading = ref(false);
const reportError = ref("");
const reportExportLoading = ref<ReportExportFormat | null>(null);
const reportEvidenceLoading = ref(false);
const reportEvidencePage = ref(1);
const reportEvidencePageSize = ref<ListPageSize>(10);
const reportEvidenceKind = ref<ReportEvidence["kind"] | "">("");
const reportEvidenceQuery = ref("");
const reportSessionItems = ref<WorkSessionRecord[]>([]);
const reportSessionPage = ref(1);
const reportSessionPageSize = ref<ListPageSize>(10);
const reportSessionPageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const reportSessionLoading = ref(false);
const reportSynthesisRequest = ref<ReportSynthesisRequest | null>(null);
const reportSynthesisSummary = ref<ReportSummary | null>(null);
const reportSynthesisHistory = ref<ReportSummary[]>([]);
const reportSynthesisExpanded = ref(false);
const reportSynthesisLoading = ref(false);
const reportSynthesisCreating = ref(false);
const reportSynthesisRetrying = ref(false);
const reportSynthesisCancelling = ref(false);
const reportSynthesisError = ref("");

const reportSynthesisIsActive = computed(() => {
  const status = reportSynthesisRequest.value?.status;
  return status === "pending" || status === "processing";
});

const reportSynthesisCanRetry = computed(() => {
  const status = reportSynthesisRequest.value?.status;
  return status === "failed" || status === "cancelled";
});

const reportComparisons = computed(() => {
  if (!report.value) {
    return [];
  }
  return [
    { key: "sessions", label: "完成 Sessions", comparison: report.value.comparison.sessions, foot: "與上一期比較" },
    { key: "events", label: "Recorded Events", comparison: report.value.comparison.events, foot: "可追溯事件" },
    { key: "changedFiles", label: "Changed Files", comparison: report.value.comparison.changedFiles, foot: "不等同 Git commit" }
  ];
});

const reportVerification = computed(() => {
  const current = report.value;
  if (!current) {
    return [];
  }
  const total = Math.max(current.totals.sessions, 1);
  return (["passed", "failed", "not_supplied", "not_run"] as const).map((status) => ({
    status,
    label: verificationLabels[status],
    count: current.totals.verification[status] ?? 0,
    percent: Math.round(((current.totals.verification[status] ?? 0) / total) * 100)
  }));
});

function reportScope(): { period: ReportPeriod; date?: string; projectId?: string } {
  return {
    period: reportPeriod.value,
    date: reportDate.value || undefined,
    projectId: reportProjectId.value || undefined
  };
}

async function loadReportSynthesis(): Promise<void> {
  reportSynthesisLoading.value = true;
  reportSynthesisError.value = "";
  await runKeyed(
    "report-synthesis",
    async (signal) => {
      const client = useApi().client;
      const [requests, summaries] = await Promise.all([
        client.listReportSynthesisRequests({ ...reportScope(), limit: 10 }, signal),
        client.listReportSummaries({ ...reportScope(), currentOnly: false }, signal)
      ]);
      if (requests.outcome === "report_synthesis_requests") {
        reportSynthesisRequest.value = requests.requests[0] ?? null;
      } else {
        reportSynthesisRequest.value = null;
        reportSynthesisError.value = requests.reason;
      }
      if (summaries.outcome === "report_summaries") {
        reportSynthesisHistory.value = summaries.summaries;
        reportSynthesisSummary.value = summaries.summaries.find((summary) => summary.isCurrent) ?? summaries.summaries[0] ?? null;
      } else {
        reportSynthesisHistory.value = [];
        reportSynthesisSummary.value = null;
        reportSynthesisError.value ||= summaries.reason;
      }
    },
    {
      onError: (error) => {
        reportSynthesisRequest.value = null;
        reportSynthesisHistory.value = [];
        reportSynthesisSummary.value = null;
        reportSynthesisError.value = errorMessage(error, "無法載入報告提煉狀態。");
      },
      onSettled: () => {
        reportSynthesisLoading.value = false;
      }
    }
  );
}

function selectReportSynthesisVersion(summary: ReportSummary): void {
  reportSynthesisSummary.value = summary;
}

async function createReportSynthesisRequest(): Promise<void> {
  if (!report.value || reportSynthesisCreating.value) {
    return;
  }
  reportSynthesisCreating.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await useApi().client.createReportSynthesisRequest({ ...reportScope(), idempotencyKey: crypto.randomUUID() });
    if (result.outcome !== "report_synthesis_request") {
      reportSynthesisError.value = result.reason;
      return;
    }
    reportSynthesisRequest.value = result.request;
    useToast().showToast(reportSynthesisSummary.value
      ? "已建立重新提煉請求。上一版摘要會先保留，新的 Agent 摘要完成後才會替換。"
      : `報告請求已建立。請在目前的 Agent 對話中說：「${reportSynthesisInstruction}」`);
  } catch (error) {
    reportSynthesisError.value = errorMessage(error, "建立報告提煉請求失敗。");
  } finally {
    reportSynthesisCreating.value = false;
  }
}

async function retryReportSynthesisRequest(): Promise<void> {
  const requestToRetry = reportSynthesisRequest.value;
  if (!requestToRetry || !reportSynthesisCanRetry.value || reportSynthesisRetrying.value) {
    return;
  }
  reportSynthesisRetrying.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await useApi().client.retryReportSynthesisRequest(requestToRetry.id);
    if (result.outcome !== "report_synthesis_request_retried") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這份報告目前無法重試。";
      return;
    }
    reportSynthesisRequest.value = result.request;
    useToast().showToast("已重新建立提煉請求。請在目前的 Agent 對話中處理它。");
  } catch (error) {
    reportSynthesisError.value = errorMessage(error, "重新建立報告提煉請求失敗。");
  } finally {
    reportSynthesisRetrying.value = false;
  }
}

async function cancelReportSynthesisRequest(): Promise<void> {
  const requestToCancel = reportSynthesisRequest.value;
  if (!requestToCancel || !reportSynthesisIsActive.value || reportSynthesisCancelling.value) {
    return;
  }
  if (!window.confirm("確定取消這次報告提煉嗎？既有報告與歷史版本會保留。")) {
    return;
  }
  reportSynthesisCancelling.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await useApi().client.cancelReportSynthesisRequest(requestToCancel.id);
    if (result.outcome !== "report_synthesis_request_cancelled") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這份報告目前無法取消。";
      return;
    }
    reportSynthesisRequest.value = result.request;
    useToast().showToast("已取消這次報告提煉；既有報告與歷史版本仍然保留。");
  } catch (error) {
    reportSynthesisError.value = errorMessage(error, "取消報告提煉失敗。");
  } finally {
    reportSynthesisCancelling.value = false;
  }
}

function copyReportSynthesisInstruction(): Promise<void> {
  return useToast().copyWithToast(reportSynthesisInstruction, "已複製自然語言提煉指令。");
}

async function deleteReportSynthesisVersion(summary: ReportSummary): Promise<void> {
  if (summary.isCurrent) {
    return;
  }
  if (!window.confirm(`確定移除「${summary.title}」這個歷史版本嗎？此操作無法復原。`)) {
    return;
  }
  reportSynthesisError.value = "";
  try {
    const result = await useApi().client.deleteReportSummary(summary.id);
    if (result.outcome !== "report_summary_deleted") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這個報告版本目前無法移除。";
      return;
    }
    useToast().showToast("已移除報告歷史版本。");
    await loadReportSynthesis();
  } catch (error) {
    reportSynthesisError.value = errorMessage(error, "移除報告歷史版本失敗。");
  }
}

async function loadReportSessions(resetPage = false): Promise<void> {
  const current = report.value;
  if (!current) {
    reportSessionItems.value = [];
    reportSessionPageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(reportSessionPageSize.value) };
    return;
  }
  if (resetPage) {
    reportSessionPage.value = 1;
  }
  reportSessionLoading.value = true;
  await runKeyed(
    "report-sessions",
    async (signal) => {
      const result = await useApi().client.listSessions({
        from: current.range.from,
        to: current.range.to,
        projectId: reportProjectId.value || undefined,
        page: reportSessionPage.value,
        pageSize: reportSessionPageSize.value
      }, signal);
      reportSessionItems.value = result.items;
      reportSessionPage.value = result.pageInfo.page;
      reportSessionPageInfo.value = result.pageInfo;
    },
    {
      onError: (error) => {
        reportSessionItems.value = [];
        reportSessionPageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(reportSessionPageSize.value) };
        reportSynthesisError.value ||= errorMessage(error, "無法載入報告原始 Session。");
      },
      onSettled: () => {
        reportSessionLoading.value = false;
      }
    }
  );
}

async function changeReportSessionPageSize(): Promise<void> {
  reportSessionPage.value = 1;
  await loadReportSessions();
}

async function changeReportSessionPage(page: number): Promise<void> {
  if (page < 1 || page > reportSessionPageInfo.value.totalPages || page === reportSessionPage.value) {
    return;
  }
  reportSessionPage.value = page;
  await loadReportSessions();
}

function evidenceScope() {
  return {
    ...reportScope(),
    evidencePage: reportEvidencePage.value,
    evidencePageSize: reportEvidencePageSize.value,
    evidenceKind: reportEvidenceKind.value || undefined,
    evidenceQuery: reportEvidenceQuery.value.trim() || undefined
  };
}

async function loadReportEvidence(resetPage = false): Promise<void> {
  if (!report.value || reportEvidenceLoading.value) {
    return;
  }
  if (resetPage) {
    reportEvidencePage.value = 1;
  }
  reportEvidenceLoading.value = true;
  reportError.value = "";
  await runKeyed(
    "report-evidence",
    async (signal) => {
      const result = await useApi().client.getReport(evidenceScope(), signal);
      if (result.outcome !== "report") {
        reportError.value = result.reason;
        return;
      }
      if (report.value) {
        report.value = { ...report.value, evidence: result.evidence, evidencePageInfo: result.evidencePageInfo };
      }
    },
    {
      onError: (error) => {
        reportError.value = errorMessage(error, "無法更新來源證據。");
      },
      onSettled: () => {
        reportEvidenceLoading.value = false;
      }
    }
  );
}

async function loadReport(resetEvidencePage = false): Promise<void> {
  if (resetEvidencePage) {
    reportEvidencePage.value = 1;
    reportTab.value = "overview";
  }
  reportLoading.value = true;
  reportError.value = "";
  await runKeyed(
    "report",
    async (signal) => {
      const result = await useApi().client.getReport(evidenceScope(), signal);
      if (result.outcome === "report") {
        report.value = result;
        await Promise.all([loadReportSynthesis(), loadReportSessions(resetEvidencePage)]);
      } else {
        report.value = null;
        reportSynthesisRequest.value = null;
        reportSynthesisSummary.value = null;
        reportError.value = result.reason;
      }
    },
    {
      onError: (error) => {
        report.value = null;
        reportError.value = errorMessage(error, "無法載入工作報告。");
      },
      onSettled: () => {
        reportLoading.value = false;
      }
    }
  );
}

async function changeReportEvidencePage(page: number): Promise<void> {
  if (!report.value || page < 1 || page > report.value.evidencePageInfo.totalPages || page === reportEvidencePage.value) {
    return;
  }
  reportEvidencePage.value = page;
  await loadReportEvidence();
}

async function changeReportEvidencePageSize(): Promise<void> {
  reportEvidencePage.value = 1;
  await loadReportEvidence();
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
      evidenceQuery: reportEvidenceQuery.value.trim() || undefined
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
    showToast(`已下載 ${format === "markdown" ? "Markdown" : "JSON"} 報告。`);
  } catch (error) {
    showToast(errorMessage(error, "報告匯出失敗。"));
  } finally {
    reportExportLoading.value = null;
  }
}

function openReportSession(sessionId: string | undefined): Promise<void> {
  return useSessionDetail().openSessionDetail(sessionId, "無法載入來源 Session。");
}

function openReportEvidence(evidence: ReportEvidence): Promise<void> {
  return openReportSession(evidence.sessionId);
}

export function useReports() {
  return {
    report,
    reportPeriod,
    reportDate,
    reportProjectId,
    reportTab,
    reportLoading,
    reportError,
    reportExportLoading,
    reportEvidenceLoading,
    reportEvidencePageSize,
    reportEvidenceKind,
    reportEvidenceQuery,
    reportSessionItems,
    reportSessionPageSize,
    reportSessionPageInfo,
    reportSessionLoading,
    reportSynthesisRequest,
    reportSynthesisSummary,
    reportSynthesisHistory,
    reportSynthesisExpanded,
    reportSynthesisLoading,
    reportSynthesisCreating,
    reportSynthesisRetrying,
    reportSynthesisCancelling,
    reportSynthesisError,
    reportSynthesisIsActive,
    reportSynthesisCanRetry,
    reportComparisons,
    reportVerification,
    loadReport,
    loadReportSynthesis,
    selectReportSynthesisVersion,
    createReportSynthesisRequest,
    retryReportSynthesisRequest,
    cancelReportSynthesisRequest,
    copyReportSynthesisInstruction,
    deleteReportSynthesisVersion,
    changeReportSessionPage,
    changeReportSessionPageSize,
    loadReportEvidence,
    changeReportEvidencePage,
    changeReportEvidencePageSize,
    exportReport,
    openReportSession,
    openReportEvidence
  };
}
