import { useQuery } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { MetadataBackfillRequest, ReportSynthesisRequest, WorkReport } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { reportPeriodLabels } from "../utils/labels";
import { toDateInputValue } from "../utils/format";
import { queryKeys } from "./query-keys";

export type InboxItem =
  | { kind: "synthesis"; request: ReportSynthesisRequest; title: string; meta: string }
  | { kind: "backfill"; request: MetadataBackfillRequest; title: string; meta: string };

type DashboardOverview = {
  weekReport: WorkReport | null;
  synthesisRequests: ReportSynthesisRequest[];
  backfillRequest: MetadataBackfillRequest | null;
};

/** Owns the dashboard overview and its app-shell inbox counts. */
export const useDashboardStore = defineStore("dashboard", () => {
  const overviewEnabled = ref(false);
  const overviewQuery = useQuery({
    key: queryKeys.dashboard.overview,
    enabled: overviewEnabled,
    query: async ({ signal }): Promise<DashboardOverview> => {
      const client = useApi().client;
      const [reportResult, synthesisResult, backfillResult] = await Promise.all([
        client
          .getReport({ period: "week", date: toDateInputValue(new Date()), evidencePageSize: 1 }, signal)
          .catch((error: unknown) => {
            if (useApi().isAbortError(error)) throw error;
            return null;
          }),
        client.listReportSynthesisRequests({ limit: 50 }, signal).catch((error: unknown) => {
          if (useApi().isAbortError(error)) throw error;
          return null;
        }),
        client.listMetadataBackfillRequests(signal).catch((error: unknown) => {
          if (useApi().isAbortError(error)) throw error;
          return null;
        }),
      ]);

      return {
        weekReport: reportResult?.outcome === "report" ? reportResult : null,
        synthesisRequests: synthesisResult?.outcome === "report_synthesis_requests" ? synthesisResult.requests : [],
        backfillRequest:
          backfillResult?.outcome === "metadata_backfill_requests" ? (backfillResult.requests[0] ?? null) : null,
      };
    },
  });

  const weekReport = computed(() => overviewQuery.data.value?.weekReport ?? null);
  const synthesisRequests = computed(() => overviewQuery.data.value?.synthesisRequests ?? []);
  const backfillRequest = computed(() => overviewQuery.data.value?.backfillRequest ?? null);
  const dashboardLoading = computed(() => overviewQuery.isLoading.value);

  /** Only the newest request per report scope matters; older completed requests are not pending work. */
  function latestPerScope(requests: readonly ReportSynthesisRequest[]): ReportSynthesisRequest[] {
    const seen = new Set<string>();
    return requests.filter((request) => {
      const key = `${request.period}:${request.range.from}:${request.range.to}:${request.projectId ?? "all"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const inbox = computed<InboxItem[]>(() => {
    const items: InboxItem[] = latestPerScope(synthesisRequests.value)
      .filter(
        (request) => request.status === "pending" || request.status === "processing" || request.status === "failed",
      )
      .map((request) => ({
        kind: "synthesis",
        request,
        title: `${reportPeriodLabels[request.period]}報告${request.status === "failed" ? " AI 整理未完成" : "待 Agent 整理"}`,
        meta: `Report synthesis · ${request.range.from} – ${request.range.to} · ${request.projectName ?? "所有記錄中專案"} · ${request.sourceSessionIds.length} 個來源 Session`,
      }));
    const backfill = backfillRequest.value;
    if (
      backfill &&
      (backfill.status === "pending" || backfill.status === "processing" || backfill.status === "failed")
    ) {
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
    overviewEnabled.value = true;
    try {
      await overviewQuery.refetch(true);
    } catch (error) {
      if (!useApi().isAbortError(error)) throw error;
    }
  }

  return { weekReport, weekVerification, inbox, dashboardLoading, loadDashboardData };
});
