import {
  cancelMetadataBackfillRequestInputSchema,
  createMetadataBackfillRequestInputSchema,
  handoffImportApplyInputSchema,
  handoffImportOptionsSchema,
  metadataBackfillApplyInputSchema,
  metadataBackfillPreviewQuerySchema,
  metadataBackfillRequestContextQuerySchema,
  metadataBackfillRequestQuerySchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonBody, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

/** Metadata backfill requests and historical handoff import. */
export const backfillRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/backfill/metadata/preview",
    handler: validatedRoute(
      metadataBackfillPreviewQuerySchema,
      "Invalid metadata backfill preview query.",
      ({ url }) => ({ projectRoot: textParam(url, "projectRoot"), limit: numberParam(url, "limit") }),
      ({ store }, data) => store.previewMetadataBackfill(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/backfill/metadata-requests",
    handler: validatedRoute(
      createMetadataBackfillRequestInputSchema,
      "Invalid metadata backfill request payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.createMetadataBackfillRequest(data),
      201,
    ),
  },
  {
    method: "GET",
    pattern: "/api/backfill/metadata-requests",
    handler: validatedRoute(
      metadataBackfillRequestQuerySchema,
      "Invalid metadata backfill request query.",
      ({ url }) => ({
        scopeType: url.searchParams.get("scopeType") ?? undefined,
        projectId: textParam(url, "projectId"),
        status: url.searchParams.get("status") ?? undefined,
        requestId: textParam(url, "requestId"),
        limit: numberParam(url, "limit"),
      }),
      ({ store }, data) => store.listMetadataBackfillRequests(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/backfill/metadata-requests/:requestId/context",
    handler: validatedRoute(
      metadataBackfillRequestContextQuerySchema,
      "Invalid metadata backfill request context query.",
      ({ url, params }) => ({ requestId: params.requestId, limit: numberParam(url, "limit") }),
      ({ store }, data) => store.getMetadataBackfillContext(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/backfill/metadata-requests/:requestId/cancel",
    handler: validatedRoute(
      cancelMetadataBackfillRequestInputSchema,
      "Invalid metadata backfill cancellation request.",
      ({ params }) => ({ requestId: params.requestId }),
      ({ store }, data) => store.cancelMetadataBackfillRequest(data.requestId),
    ),
  },
  {
    method: "POST",
    pattern: "/api/backfill/metadata",
    handler: validatedRoute(
      metadataBackfillApplyInputSchema,
      "Invalid metadata backfill payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.applyMetadataBackfill(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/imports/handoffs/preview",
    handler: validatedRoute(
      handoffImportOptionsSchema,
      "Invalid handoff import preview query.",
      ({ url }) => ({
        projectRoot: url.searchParams.get("projectRoot") ?? "",
        handoffDirectory: url.searchParams.get("handoffDirectory") ?? undefined,
        excludePaths: url.searchParams.getAll("excludePath"),
        maxFiles: numberParam(url, "maxFiles"),
      }),
      ({ store }, data) => store.previewHandoffImport(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/imports/handoffs",
    handler: validatedRoute(
      handoffImportApplyInputSchema,
      "Invalid handoff import payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.importHandoffs(data),
    ),
  },
];
