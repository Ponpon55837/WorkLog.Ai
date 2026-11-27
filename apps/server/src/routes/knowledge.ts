import {
  cancelKnowledgeCandidateRequestInputSchema,
  decideKnowledgeCandidateInputSchema,
  deleteKnowledgePageInputSchema,
  knowledgeCandidateListQuerySchema,
  knowledgeHistoryQuerySchema,
  knowledgePageListQuerySchema,
  recordKnowledgeInputSchema,
  restKnowledgeQuerySchema,
  requestKnowledgeCandidatesInputSchema,
  requestKnowledgePageUpdateInputSchema,
  reviewSessionDecisionInputSchema,
  sessionDecisionListQuerySchema,
  setKnowledgeConventionInputSchema,
  updateKnowledgeInputSchema,
  updateKnowledgePageInputSchema,
  flattenInputError,
} from "@work-intelligence/schema";
import { KnowledgePageDeletionError } from "@work-intelligence/storage";
import { numberParam, readJsonBody, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import { parseRequestInput, validatedRoute, type Route, type RouteContext } from "./router.js";

// The required JSON confirmation keeps deletion out of reach of plain links and forms.
async function deleteKnowledgePage({ store, request, response, params }: RouteContext): Promise<void> {
  const parsed = parseRequestInput(deleteKnowledgePageInputSchema, await readJsonBody(request));
  if (!parsed.success) {
    sendError(response, 400, "Invalid knowledge page deletion confirmation.", flattenInputError(parsed.error));
    return;
  }
  try {
    sendJson(response, 200, store.deleteKnowledgePage(params.pageId!));
  } catch (error) {
    if (!(error instanceof KnowledgePageDeletionError)) {
      throw error;
    }
    if (error.code === "knowledge_page_not_found") {
      sendError(response, 404, "Knowledge page not found.", undefined, error.code);
      return;
    }
    sendError(response, 409, "A default Knowledge page cannot be deleted.", undefined, error.code);
  }
}

export const knowledgeRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/knowledge",
    handler: validatedRoute(
      restKnowledgeQuerySchema,
      "Invalid knowledge query.",
      ({ url }) => ({
        projectRoot: textParam(url, "projectRoot"),
        projectId: textParam(url, "projectId"),
        q: textParam(url, "q"),
        kind: url.searchParams.get("kind") || undefined,
        status: url.searchParams.get("status") || undefined,
        convention: url.searchParams.get("convention") === "true" ? true : undefined,
        limit: numberParam(url, "limit"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, data) => store.searchKnowledge(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/knowledge",
    handler: validatedRoute(
      recordKnowledgeInputSchema,
      "Invalid knowledge payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.recordKnowledge(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/knowledge/:knowledgeId",
    handler: validatedRoute(
      updateKnowledgeInputSchema,
      "Invalid knowledge update payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), knowledgeId: params.knowledgeId }),
      ({ store }, data) => store.updateKnowledge(data, "user"),
    ),
  },
  {
    method: "PUT",
    pattern: "/api/knowledge/:knowledgeId/convention",
    handler: async (context) => {
      const parsed = parseRequestInput(setKnowledgeConventionInputSchema, {
        ...(await readJsonObject(context.request)),
        knowledgeId: context.params.knowledgeId,
      });
      if (!parsed.success) {
        sendError(context.response, 400, "Invalid knowledge convention payload.", flattenInputError(parsed.error));
        return;
      }
      const result = context.store.setKnowledgeConvention(parsed.data);
      if (result.outcome === "rejected") {
        const limit = result.reason === "convention_limit_reached";
        sendError(
          context.response,
          409,
          "This Knowledge cannot be marked as a project convention.",
          { reason: result.reason },
          limit ? "convention_limit_reached" : "conflict",
        );
        return;
      }
      sendJson(context.response, 200, result);
    },
  },
  {
    method: "GET",
    pattern: "/api/knowledge/:knowledgeId/history",
    handler: validatedRoute(
      knowledgeHistoryQuerySchema,
      "Invalid knowledge history query.",
      ({ url, params }) => ({
        projectRoot: url.searchParams.get("projectRoot") ?? "",
        knowledgeId: params.knowledgeId,
        limit: numberParam(url, "limit"),
      }),
      ({ store }, data) => store.getKnowledgeHistory(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/knowledge/candidates",
    handler: validatedRoute(
      knowledgeCandidateListQuerySchema,
      "Invalid knowledge candidate query.",
      ({ url }) => ({
        projectRoot: textParam(url, "projectRoot"),
        status: url.searchParams.get("status") || undefined,
        reviewedBy: url.searchParams.get("reviewedBy") || undefined,
      }),
      ({ store }, data) => store.listKnowledgeCandidates(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/knowledge/candidate-requests",
    handler: validatedRoute(
      requestKnowledgeCandidatesInputSchema,
      "Invalid knowledge candidate request.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.requestKnowledgeCandidates(data.projectRoot),
    ),
  },
  {
    method: "POST",
    pattern: "/api/knowledge/candidate-requests/:requestId/cancel",
    handler: validatedRoute(
      cancelKnowledgeCandidateRequestInputSchema,
      "Invalid knowledge candidate request cancellation.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), requestId: params.requestId }),
      ({ store }, data) => store.cancelKnowledgeCandidateRequest(data.requestId),
    ),
  },
  {
    method: "POST",
    pattern: "/api/knowledge/candidates/:candidateId/decision",
    handler: validatedRoute(
      decideKnowledgeCandidateInputSchema,
      "Invalid knowledge candidate decision.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), candidateId: params.candidateId }),
      ({ store }, data) => store.decideKnowledgeCandidate(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/session-decisions",
    handler: validatedRoute(
      sessionDecisionListQuerySchema,
      "Invalid Session decision query.",
      ({ url }) => ({
        projectRoot: textParam(url, "projectRoot"),
        status: url.searchParams.get("status") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      }),
      ({ store }, data) => store.listSessionDecisions(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/session-decisions/:decisionId/review",
    handler: validatedRoute(
      reviewSessionDecisionInputSchema,
      "Invalid Session decision review.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), decisionId: params.decisionId }),
      ({ store }, data) => store.reviewSessionDecision(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/knowledge-pages",
    handler: validatedRoute(
      knowledgePageListQuerySchema,
      "Invalid knowledge page query.",
      ({ url }) => ({ projectRoot: textParam(url, "projectRoot") }),
      ({ store }, data) => store.listKnowledgePages(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/knowledge-pages/update-requests",
    handler: validatedRoute(
      requestKnowledgePageUpdateInputSchema,
      "Invalid knowledge page request.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.requestKnowledgePageUpdate(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/knowledge-pages/:pageId/versions",
    handler: ({ store, response, params }) => sendJson(response, 200, store.listKnowledgePageVersions(params.pageId!)),
  },
  {
    method: "PATCH",
    pattern: "/api/knowledge-pages/:pageId",
    handler: validatedRoute(
      updateKnowledgePageInputSchema,
      "Invalid knowledge page update.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), pageId: params.pageId }),
      ({ store }, data) => store.updateKnowledgePage(data),
    ),
  },
  { method: "DELETE", pattern: "/api/knowledge-pages/:pageId", handler: deleteKnowledgePage },
];
