import type { ReportPresentation, ReportPresentationExport, ReportPresentationState } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";
export interface ReportPresentationApi {
  exportReportPresentation(
    input: { summaryId: string; revision: number; locale: "zh-TW" | "en-US" },
    signal?: AbortSignal,
  ): Promise<ReportPresentationExport>;
  getReportPresentation(summaryId: string, signal?: AbortSignal): Promise<ReportPresentation>;
  updateReportPresentation(input: {
    summaryId: string;
    expectedRevision: number;
    state: ReportPresentationState;
  }): Promise<ReportPresentation>;
}
export function createReportPresentationApi(client: ApiTransport): ReportPresentationApi {
  return {
    exportReportPresentation: ({ summaryId, revision, locale }, signal) =>
      client.request(
        appendQuery(`/api/reports/summaries/${encodeURIComponent(summaryId)}/presentation/export`, {
          revision,
          locale,
        }),
        { signal },
      ),
    getReportPresentation: (id, signal) =>
      client.request(`/api/reports/summaries/${encodeURIComponent(id)}/presentation`, { signal }),
    updateReportPresentation: ({ summaryId, ...input }) =>
      client.write(`/api/reports/summaries/${encodeURIComponent(summaryId)}/presentation`, "PATCH", input),
  };
}
