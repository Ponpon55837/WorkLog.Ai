import { ReportPresentationError } from "@work-intelligence/storage";
import {
  reportPresentationExportQuerySchema,
  reportPresentationQuerySchema,
  updateReportPresentationSchema,
} from "@work-intelligence/schema";
import { readJsonObject, sendError } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

function guarded(handler: Route["handler"]): Route["handler"] {
  return async (context) => {
    try {
      await handler(context);
    } catch (error) {
      if (!(error instanceof ReportPresentationError)) throw error;
      const status = error.code === "conflict" ? 409 : error.code === "invalid_input" ? 400 : 404;
      sendError(
        context.response,
        status,
        error.code === "conflict"
          ? "Report presentation changed. Reload before saving."
          : error.code === "invalid_input"
            ? "Invalid report presentation."
            : "Report source is unavailable.",
        undefined,
        error.code,
      );
    }
  };
}
export const reportPresentationRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/reports/summaries/:summaryId/presentation/export",
    handler: guarded(
      validatedRoute(
        reportPresentationExportQuerySchema,
        "Invalid report presentation export query.",
        ({ params, url }) => ({ ...Object.fromEntries(url.searchParams), summaryId: params.summaryId }),
        ({ store }, input) => store.exportReportPresentation(input),
      ),
    ),
  },
  {
    method: "GET",
    pattern: "/api/reports/summaries/:summaryId/presentation",
    handler: guarded(
      validatedRoute(
        reportPresentationQuerySchema,
        "Invalid report presentation query.",
        ({ params, url }) => ({ ...Object.fromEntries(url.searchParams), summaryId: params.summaryId }),
        ({ store }, input) => store.getReportPresentation(input.summaryId),
      ),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/reports/summaries/:summaryId/presentation",
    handler: guarded(
      validatedRoute(
        updateReportPresentationSchema,
        "Invalid report presentation payload.",
        async ({ params, request, url }) => ({
          ...Object.fromEntries(url.searchParams),
          ...(await readJsonObject(request)),
          summaryId: params.summaryId,
        }),
        ({ store }, input) => store.updateReportPresentation(input),
      ),
    ),
  },
];
