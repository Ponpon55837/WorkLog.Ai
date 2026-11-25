import type { ServerResponse } from "node:http";
import type { z } from "zod";
import {
  agentReviewRequestIdSchema,
  agentReviewRequestQuerySchema,
  createAgentReviewRequestInputSchema,
  overturnAgentReviewInputSchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import { parseRequestInput, type Route, type RouteContext } from "./router.js";

interface ReviewResult {
  outcome: string;
  reason?: string;
  requestId?: string;
}

const CONFLICT_REASONS = new Set(["idempotency_conflict", "request_not_open", "request_closed", "not_agent_reviewed"]);
const QUIET_OUTCOMES = new Set(["skipped", "agent_review_not_needed", "not_found"]);

function sendResult(response: ServerResponse, result: ReviewResult, successStatus: number): void {
  if (result.outcome === "rejected") {
    const conflict = CONFLICT_REASONS.has(result.reason ?? "");
    sendError(
      response,
      conflict ? 409 : 400,
      "Agent review request could not be applied.",
      { reason: result.reason, requestId: result.requestId },
      conflict ? "conflict" : "invalid_input",
    );
    return;
  }
  sendJson(response, QUIET_OUTCOMES.has(result.outcome) ? 200 : successStatus, result);
}

/** Maps domain conflicts without exposing database details; policy skips remain quiet successful results. */
function reviewRoute<S extends z.ZodType>(
  schema: S,
  input: (context: RouteContext) => unknown,
  run: (context: RouteContext, data: z.output<S>) => ReviewResult,
  status = 200,
): Route["handler"] {
  return async (context) => {
    const parsed = parseRequestInput(schema, await input(context));
    if (!parsed.success) {
      sendError(context.response, 400, "Invalid Agent review input.", parsed.error.flatten());
      return;
    }
    sendResult(context.response, run(context, parsed.data), status);
  };
}

function overturnRoute(itemKind: "decision" | "candidate", param: string): Route["handler"] {
  return reviewRoute(
    overturnAgentReviewInputSchema,
    async ({ request, params }) => ({ ...(await readJsonObject(request)), itemKind, itemId: params[param] }),
    ({ store }, input) => store.overturnAgentReview(input),
  );
}

/** Web-created Agent review requests and the user's overturn of an Agent verdict. */
export const agentReviewRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/api/agent-review-requests",
    handler: reviewRoute(
      createAgentReviewRequestInputSchema,
      ({ request }) => readJsonObject(request),
      ({ store }, input) => store.createAgentReviewRequest(input),
      201,
    ),
  },
  {
    method: "GET",
    pattern: "/api/agent-review-requests",
    handler: reviewRoute(
      agentReviewRequestQuerySchema,
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        status: textParam(url, "status"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, input) => store.listAgentReviewRequests(input),
    ),
  },
  {
    method: "POST",
    pattern: "/api/agent-review-requests/:requestId/cancel",
    handler: reviewRoute(
      agentReviewRequestIdSchema,
      async ({ request, params }) => ({ ...(await readJsonObject(request)), requestId: params.requestId }),
      ({ store }, input) => store.cancelAgentReviewRequest(input.requestId),
    ),
  },
  {
    method: "POST",
    pattern: "/api/session-decisions/:decisionId/overturn",
    handler: overturnRoute("decision", "decisionId"),
  },
  {
    method: "POST",
    pattern: "/api/knowledge/candidates/:candidateId/overturn",
    handler: overturnRoute("candidate", "candidateId"),
  },
];
