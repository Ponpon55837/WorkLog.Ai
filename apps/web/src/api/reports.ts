import type {
  CancelReportSynthesisRequestResult,
  CreateReportSynthesisRequestResult,
  DeleteReportSummaryResult,
  WorkReportPeriod,
  ReportExportFormat,
  ReportExportResult,
  ReportQueryResult,
  ReportSynthesisScopeType,
  ReportSummaryQueryResult,
  ReportSynthesisRequestListQueryResult,
  RetryReportSynthesisRequestResult,
} from "@work-intelligence/core";
import type { ReportRequest } from "./types";
import { appendQuery, type ApiTransport } from "./transport";

export interface ReportsApi {
  getReport(options: ReportRequest, signal?: AbortSignal): Promise<ReportQueryResult>;
  listReportSynthesisRequests(
    options?: {
      period?: WorkReportPeriod;
      date?: string;
      from?: string;
      to?: string;
      projectId?: string;
      scopeType?: ReportSynthesisScopeType;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<ReportSynthesisRequestListQueryResult>;
  listReportSummaries(
    options?: {
      period?: WorkReportPeriod;
      date?: string;
      from?: string;
      to?: string;
      projectId?: string;
      scopeType?: ReportSynthesisScopeType;
      currentOnly?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ReportSummaryQueryResult>;
  createReportSynthesisRequest(
    input: {
      period: WorkReportPeriod;
      date?: string;
      from?: string;
      to?: string;
      projectId?: string;
      idempotencyKey?: string;
    },
    signal?: AbortSignal,
  ): Promise<CreateReportSynthesisRequestResult>;
  retryReportSynthesisRequest(requestId: string, signal?: AbortSignal): Promise<RetryReportSynthesisRequestResult>;
  cancelReportSynthesisRequest(requestId: string, signal?: AbortSignal): Promise<CancelReportSynthesisRequestResult>;
  deleteReportSummary(summaryId: string, signal?: AbortSignal): Promise<DeleteReportSummaryResult>;
  exportReport(
    options: ReportRequest & { format: ReportExportFormat },
    signal?: AbortSignal,
  ): Promise<ReportExportResult>;
}

export function createReportsApi(client: ApiTransport): ReportsApi {
  return {
    getReport(options: ReportRequest, signal?: AbortSignal): Promise<ReportQueryResult> {
      return client.request<ReportQueryResult>(
        appendQuery("/api/reports", {
          period: options.period,
          date: options.date,
          from: options.from,
          to: options.to,
          projectId: options.projectId,
          evidencePage: options.evidencePage,
          evidencePageSize: options.evidencePageSize === "all" ? 0 : options.evidencePageSize,
          evidenceKind: options.evidenceKind,
          evidenceQuery: options.evidenceQuery,
        }),
        { signal },
      );
    },

    listReportSynthesisRequests(
      options: {
        period?: WorkReportPeriod;
        date?: string;
        from?: string;
        to?: string;
        projectId?: string;
        scopeType?: ReportSynthesisScopeType;
        limit?: number;
      } = {},
      signal?: AbortSignal,
    ): Promise<ReportSynthesisRequestListQueryResult> {
      return client.request<ReportSynthesisRequestListQueryResult>(
        appendQuery("/api/reports/synthesis-requests", {
          period: options.period,
          date: options.date,
          from: options.from,
          to: options.to,
          projectId: options.projectId,
          scopeType: options.scopeType,
          limit: options.limit,
        }),
        { signal },
      );
    },

    listReportSummaries(
      options: {
        period?: WorkReportPeriod;
        date?: string;
        from?: string;
        to?: string;
        projectId?: string;
        scopeType?: ReportSynthesisScopeType;
        currentOnly?: boolean;
      } = {},
      signal?: AbortSignal,
    ): Promise<ReportSummaryQueryResult> {
      return client.request<ReportSummaryQueryResult>(
        appendQuery("/api/reports/summaries", {
          period: options.period,
          date: options.date,
          from: options.from,
          to: options.to,
          projectId: options.projectId,
          scopeType: options.scopeType,
          currentOnly: options.currentOnly,
        }),
        { signal },
      );
    },

    createReportSynthesisRequest(
      input: {
        period: WorkReportPeriod;
        date?: string;
        from?: string;
        to?: string;
        projectId?: string;
        idempotencyKey?: string;
      },
      signal?: AbortSignal,
    ): Promise<CreateReportSynthesisRequestResult> {
      return client.write<CreateReportSynthesisRequestResult>("/api/reports/synthesis-requests", "POST", input, signal);
    },

    retryReportSynthesisRequest(requestId: string, signal?: AbortSignal): Promise<RetryReportSynthesisRequestResult> {
      return client.write<RetryReportSynthesisRequestResult>(
        `/api/reports/synthesis-requests/${encodeURIComponent(requestId)}/retry`,
        "POST",
        {},
        signal,
      );
    },

    cancelReportSynthesisRequest(requestId: string, signal?: AbortSignal): Promise<CancelReportSynthesisRequestResult> {
      return client.write<CancelReportSynthesisRequestResult>(
        `/api/reports/synthesis-requests/${encodeURIComponent(requestId)}/cancel`,
        "POST",
        {},
        signal,
      );
    },

    deleteReportSummary(summaryId: string, signal?: AbortSignal): Promise<DeleteReportSummaryResult> {
      return client.write<DeleteReportSummaryResult>(
        `/api/reports/summaries/${encodeURIComponent(summaryId)}`,
        "DELETE",
        {},
        signal,
      );
    },

    exportReport(
      options: ReportRequest & { format: ReportExportFormat },
      signal?: AbortSignal,
    ): Promise<ReportExportResult> {
      return client.request<ReportExportResult>(
        appendQuery("/api/reports/export", {
          period: options.period,
          date: options.date,
          from: options.from,
          to: options.to,
          projectId: options.projectId,
          format: options.format,
          evidencePage: options.evidencePage,
          evidencePageSize: options.evidencePageSize === "all" ? 0 : options.evidencePageSize,
          evidenceKind: options.evidenceKind,
          evidenceQuery: options.evidenceQuery,
        }),
        { signal },
      );
    },
  };
}
