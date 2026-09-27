import {
  cancelReportSynthesisRequestInputSchema,
  createReportSynthesisRequestInputSchema,
  reportExportQuerySchema,
  reportQuerySchema,
  reportSynthesisContextQuerySchema,
  reportSynthesisRequestQuerySchema,
  retryReportSynthesisRequestInputSchema,
  saveReportSummaryInputSchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonBody, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

/** Query parameters shared by the report and its export. */
function reportQuery(url: URL): Record<string, unknown> {
  return {
    period: url.searchParams.get("period") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    projectId: textParam(url, "projectId"),
    evidenceKind: url.searchParams.get("evidenceKind") ?? undefined,
    evidenceQuery: textParam(url, "evidenceQuery"),
    evidencePage: numberParam(url, "evidencePage"),
    evidencePageSize: numberParam(url, "evidencePageSize"),
  };
}

/** Query parameters shared by the synthesis request and summary lists. */
function synthesisQuery(url: URL): Record<string, unknown> {
  return {
    period: url.searchParams.get("period") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    projectId: textParam(url, "projectId"),
    scopeType: url.searchParams.get("scopeType") ?? undefined,
    requestId: textParam(url, "requestId"),
    limit: numberParam(url, "limit"),
  };
}

export const reportRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/dashboard",
    handler: ({ store, response }) => sendJson(response, 200, store.getDashboardSummary()),
  },
  {
    method: "GET",
    pattern: "/api/reports",
    handler: validatedRoute(
      reportQuerySchema,
      "Invalid report query.",
      ({ url }) => reportQuery(url),
      ({ store }, data) => store.getReport(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/reports/export",
    handler: validatedRoute(
      reportExportQuerySchema,
      "Invalid report export query.",
      ({ url }) => ({ ...reportQuery(url), format: url.searchParams.get("format") ?? undefined }),
      ({ store }, data) => store.exportReport(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/reports/synthesis-requests",
    handler: validatedRoute(
      createReportSynthesisRequestInputSchema,
      "Invalid report synthesis request payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.createReportSynthesisRequest(data),
      201,
    ),
  },
  {
    method: "GET",
    pattern: "/api/reports/synthesis-requests",
    handler: validatedRoute(
      reportSynthesisRequestQuerySchema,
      "Invalid report synthesis request query.",
      ({ url }) => ({ ...synthesisQuery(url), status: url.searchParams.get("status") ?? undefined }),
      ({ store }, data) => store.listReportSynthesisRequests(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/reports/synthesis-requests/:requestId/retry",
    handler: validatedRoute(
      retryReportSynthesisRequestInputSchema,
      "Invalid report synthesis retry request.",
      ({ params }) => ({ requestId: params.requestId }),
      ({ store }, data) => store.retryReportSynthesisRequest(data.requestId),
    ),
  },
  {
    method: "POST",
    pattern: "/api/reports/synthesis-requests/:requestId/cancel",
    handler: validatedRoute(
      cancelReportSynthesisRequestInputSchema,
      "Invalid report synthesis cancellation request.",
      ({ params }) => ({ requestId: params.requestId }),
      ({ store }, data) => store.cancelReportSynthesisRequest(data.requestId),
    ),
  },
  {
    method: "GET",
    pattern: "/api/reports/synthesis-requests/:requestId/context",
    handler: validatedRoute(
      reportSynthesisContextQuerySchema,
      "Invalid report synthesis context query.",
      ({ url, params }) => ({
        requestId: params.requestId,
        maxSessions: numberParam(url, "maxSessions"),
        maxEvidence: numberParam(url, "maxEvidence"),
        maxHandoffCharacters: numberParam(url, "maxHandoffCharacters"),
      }),
      ({ store }, data) => store.getReportSynthesisContext(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/reports/synthesis-requests/:requestId",
    handler: ({ store, response, params }) =>
      sendJson(response, 200, store.getReportSynthesisRequest(params.requestId!)),
  },
  {
    method: "GET",
    pattern: "/api/reports/summaries",
    handler: validatedRoute(
      reportSynthesisRequestQuerySchema,
      "Invalid report summary query.",
      ({ url }) => synthesisQuery(url),
      ({ store, url }, data) =>
        store.listReportSummaries({ ...data, currentOnly: url.searchParams.get("currentOnly") !== "false" }),
    ),
  },
  {
    method: "POST",
    pattern: "/api/reports/summaries",
    handler: validatedRoute(
      saveReportSummaryInputSchema,
      "Invalid report summary payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.saveReportSummary(data),
    ),
  },
  {
    method: "DELETE",
    pattern: "/api/reports/summaries/:summaryId",
    handler: ({ store, response, params }) => sendJson(response, 200, store.deleteReportSummary(params.summaryId!)),
  },
];
