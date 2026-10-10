import type { ReportPresentation, ReportPresentationState } from "@work-intelligence/core";
import type { ApiTransport } from "./transport";
export interface ReportPresentationApi {
  getReportPresentation(summaryId: string, signal?: AbortSignal): Promise<ReportPresentation>;
  updateReportPresentation(input: {
    summaryId: string;
    expectedRevision: number;
    state: ReportPresentationState;
  }): Promise<ReportPresentation>;
}
export function createReportPresentationApi(client: ApiTransport): ReportPresentationApi {
  return {
    getReportPresentation: (id, signal) =>
      client.request(`/api/reports/summaries/${encodeURIComponent(id)}/presentation`, { signal }),
    updateReportPresentation: ({ summaryId, ...input }) =>
      client.write(`/api/reports/summaries/${encodeURIComponent(summaryId)}/presentation`, "PATCH", input),
  };
}
