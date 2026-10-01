import type { ServerResponse } from "node:http";
import {
  createOutstandingCleanupRequestInputSchema,
  decideOutstandingCleanupProposalsInputSchema,
  outstandingCleanupContextQuerySchema,
  outstandingCleanupProposalQuerySchema,
  outstandingCleanupRequestIdSchema,
  outstandingCleanupRequestQuerySchema,
  submitOutstandingCleanupProposalsInputSchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import type { Route, RouteContext } from "./router.js";

interface CleanupResult {
  outcome: string;
  reason?: string;
  itemIds?: string[];
  proposalIds?: string[];
  requestId?: string;
}

interface InputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

function sendResult(response: ServerResponse, result: CleanupResult, successStatus: number): void {
  if (result.outcome === "rejected") {
    const conflict = [
      "stale_proposal",
      "already_examined",
      "already_decided",
      "idempotency_conflict",
      "request_closed",
      "active_request_exists",
    ].includes(result.reason ?? "");
    sendError(
      response,
      conflict ? 409 : 400,
      "Outstanding cleanup request could not be applied.",
      { reason: result.reason, itemIds: result.itemIds, proposalIds: result.proposalIds, requestId: result.requestId },
      conflict ? "conflict" : "invalid_input",
    );
    return;
  }
  sendJson(response, ["skipped", "not_needed", "not_found"].includes(result.outcome) ? 200 : successStatus, result);
}

/** Maps domain conflicts without exposing database details; policy skips remain quiet successful results. */
function cleanupRoute<T>(
  schema: InputSchema<T>,
  input: (context: RouteContext) => unknown,
  run: (context: RouteContext, data: T) => CleanupResult,
  status = 200,
): Route["handler"] {
  return async (context) => {
    const parsed = schema.safeParse(await input(context));
    if (!parsed.success) {
      sendError(context.response, 400, "Invalid outstanding cleanup input.", parsed.error.flatten());
      return;
    }
    sendResult(context.response, run(context, parsed.data), status);
  };
}

/** Web-created cleanup requests, evidence proposals, and human-only review decisions. */
export const outstandingCleanupRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/outstanding-cleanup/requests",
    handler: cleanupRoute(
      createOutstandingCleanupRequestInputSchema,
      ({ request }) => readJsonObject(request),
      ({ store }, input) => store.createOutstandingCleanupRequest(input),
      201,
    ),
  },
  {
    method: "GET",
    pattern: "/api/outstanding-cleanup/requests",
    handler: cleanupRoute(
      outstandingCleanupRequestQuerySchema,
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        status: textParam(url, "status"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, input) => store.listOutstandingCleanupRequests(input),
    ),
  },
  {
    method: "GET",
    pattern: "/api/outstanding-cleanup/requests/:requestId/context",
    handler: cleanupRoute(
      outstandingCleanupContextQuerySchema,
      ({ url, params }) => ({
        requestId: params.requestId,
        itemPage: numberParam(url, "itemPage"),
        sessionPage: numberParam(url, "sessionPage"),
        itemPageSize: numberParam(url, "itemPageSize"),
        sessionPageSize: numberParam(url, "sessionPageSize"),
      }),
      ({ store }, input) => store.getOutstandingCleanupContext(input),
    ),
  },
  {
    method: "GET",
    pattern: "/api/outstanding-cleanup/requests/:requestId/proposals",
    handler: cleanupRoute(
      outstandingCleanupProposalQuerySchema,
      ({ url, params }) => ({
        requestId: params.requestId,
        reviewStatus: textParam(url, "reviewStatus"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, input) => store.listOutstandingCleanupProposals(input),
    ),
  },
  {
    method: "POST",
    pattern: "/api/outstanding-cleanup/requests/:requestId/proposals",
    handler: cleanupRoute(
      submitOutstandingCleanupProposalsInputSchema,
      async ({ request, params }) => ({ ...(await readJsonObject(request)), requestId: params.requestId }),
      ({ store }, input) => store.submitOutstandingCleanupProposals(input),
      201,
    ),
  },
  {
    method: "POST",
    pattern: "/api/outstanding-cleanup/requests/:requestId/decisions",
    handler: cleanupRoute(
      decideOutstandingCleanupProposalsInputSchema,
      async ({ request, params }) => ({ ...(await readJsonObject(request)), requestId: params.requestId }),
      ({ store }, input) => store.decideOutstandingCleanupProposals(input),
    ),
  },
  {
    method: "POST",
    pattern: "/api/outstanding-cleanup/requests/:requestId/cancel",
    handler: cleanupRoute(
      outstandingCleanupRequestIdSchema,
      async ({ request, params }) => ({ ...(await readJsonObject(request)), requestId: params.requestId }),
      ({ store }, input) => store.cancelOutstandingCleanupRequest(input.requestId),
    ),
  },
];
