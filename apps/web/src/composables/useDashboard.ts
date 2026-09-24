import { computed, ref } from "vue";
import type { MetadataBackfillRequest, ReportSynthesisRequest, WorkReport } from "@work-intelligence/core";
import { reportPeriodLabels } from "../utils/labels";
import { toDateInputValue } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useProjects } from "./useProjects";

export type InboxItem =
  | { kind: "synthesis"; request: ReportSynthesisRequest; title: string; meta: string }
  | { kind: "backfill"; request: MetadataBackfillRequest; title: string; meta: string };

const weekReport = ref<WorkReport | null>(null);
const synthesisRequests = ref<ReportSynthesisRequest[]>([]);
const backfillRequest = ref<MetadataBackfillRequest | null>(null);
const dashboardLoading = ref(false);
const freshForMs = 10_000;
let loadedAt = 0;

/**
 * Only the newest request per report scope matters: an older failed request that was later
 * completed must not show up as pending work.
 */
function latestPerScope(requests: readonly ReportSynthesisRequest[]): ReportSynthesisRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.period}:${request.range.from}:${request.range.to}:${request.projectId ?? "all"}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const inbox = computed<InboxItem[]>(() => {
  const items: InboxItem[] = latestPerScope(synthesisRequests.value)
    .filter((request) => request.status === "pending" || request.status === "processing" || request.status === "failed")
    .map((request) => ({
      kind: "synthesis",
      request,
      title: `${reportPeriodLabels[request.period]}報告${request.status === "failed" ? " AI 整理未完成" : "待 Agent 整理"}`,
      meta: `Report synthesis · ${request.range.from} – ${request.range.to} · ${request.projectName ?? "所有記錄中專案"} · ${request.sourceSessionIds.length} 個來源 Session`,
    }));
  const backfill = backfillRequest.value;
  if (backfill && (backfill.status === "pending" || backfill.status === "processing" || backfill.status === "failed")) {
    items.push({
      kind: "backfill",
      request: backfill,
      title: "Session metadata 待 Agent 回補",
      meta: "Metadata backfill · 只回寫已確認的 changed files 與 verification",
    });
  }
  return items;
});

const weekVerification = computed(() => {
  const totals = weekReport.value?.totals;
  return {
    total: totals?.sessions ?? 0,
    passed: totals?.verification.passed ?? 0,
    failed: totals?.verification.failed ?? 0,
    notRun: totals?.verification.not_run ?? 0,
    notSupplied: totals?.verification.not_supplied ?? 0,
  };
});

async function loadDashboardData(): Promise<void> {
  dashboardLoading.value = true;
  const client = useApi().client;
  await Promise.all([
    useProjects().loadDashboard(),
    runKeyed(
      "dashboard-week",
      async (signal) => {
        const result = await client.getReport(
          { period: "week", date: toDateInputValue(new Date()), evidencePageSize: 1 },
          signal,
        );
        weekReport.value = result.outcome === "report" ? result : null;
      },
      { onError: () => (weekReport.value = null) },
    ),
    runKeyed(
      "dashboard-synthesis",
      async (signal) => {
        const result = await client.listReportSynthesisRequests({ limit: 50 }, signal);
        synthesisRequests.value = result.outcome === "report_synthesis_requests" ? result.requests : [];
      },
      { onError: () => (synthesisRequests.value = []) },
    ),
    runKeyed(
      "dashboard-backfill",
      async (signal) => {
        const result = await client.listMetadataBackfillRequests(signal);
        backfillRequest.value = result.outcome === "metadata_backfill_requests" ? (result.requests[0] ?? null) : null;
      },
      { onError: () => (backfillRequest.value = null) },
    ),
  ]).finally(() => {
    dashboardLoading.value = false;
    loadedAt = Date.now();
  });
}

/** Skips the fetch when App (startup or header refresh) loaded the same data moments ago. */
function ensureDashboardData(): Promise<void> {
  return Date.now() - loadedAt < freshForMs ? Promise.resolve() : loadDashboardData();
}

export function useDashboard() {
  return { weekReport, weekVerification, inbox, dashboardLoading, loadDashboardData, ensureDashboardData };
}
