import {
  attachEvidenceInputSchema,
  finalizeSessionInputSchema,
  linkSessionsInputSchema,
  sessionsQuerySchema,
  setDiagramVoidInputSchema,
  setEvidenceVoidInputSchema,
  setSessionVoidInputSchema,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema,
  updateSessionVerificationInputSchema,
  updateSessionWorkSummaryInputSchema,
} from "@work-intelligence/schema";
import { numberParam, readJsonBody, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route, type RouteContext } from "./router.js";

/** Adding and removing a link share one handler; a DELETE names the other Session in the path. */
const linkSessions = validatedRoute(
  linkSessionsInputSchema,
  "Invalid session link payload.",
  async ({ request, params }: RouteContext) => ({
    ...(request.method === "POST" ? await readJsonObject(request) : {}),
    ...(request.method === "DELETE" ? { relatedSessionId: params.relatedSessionId, linked: false } : { linked: true }),
    sessionId: params.sessionId,
  }),
  ({ store }, data) => store.linkSessions(data, "web"),
);

export const sessionRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/sessions",
    handler: validatedRoute(
      sessionsQuerySchema,
      "Invalid session filters.",
      ({ url }) => ({
        q: textParam(url, "q"),
        projectId: textParam(url, "projectId"),
        voided: url.searchParams.get("voided") || undefined,
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, data) =>
        store.listSessionsPage({
          query: data.q,
          projectId: data.projectId,
          voided: data.voided,
          from: data.from,
          to: data.to,
          page: data.page,
          pageSize: data.pageSize,
          // Worklog shows tracked projects only, matching Session detail, search and reports.
          trackedOnly: true,
        }),
    ),
  },
  {
    method: "GET",
    pattern: "/api/sessions/:sessionId",
    handler: ({ store, response, params }) => {
      const detail = store.getSessionDetail(params.sessionId!);
      if (!detail) {
        sendError(response, 404, "Session not found.");
        return;
      }
      sendJson(response, 200, detail);
    },
  },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/metadata",
    handler: validatedRoute(
      updateSessionMetadataInputSchema,
      "Invalid session metadata payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.updateSessionMetadata(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/summary",
    handler: validatedRoute(
      updateSessionSummaryInputSchema,
      "Invalid session summary payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.updateSessionSummary(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/work-summary",
    handler: validatedRoute(
      updateSessionWorkSummaryInputSchema,
      "Invalid session workSummary payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.updateSessionWorkSummary(data, "web"),
    ),
  },
  {
    method: "POST",
    pattern: "/api/sessions/:sessionId/evidence",
    handler: validatedRoute(
      attachEvidenceInputSchema,
      "Invalid evidence payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.attachEvidence(data),
    ),
  },
  { method: "POST", pattern: "/api/sessions/:sessionId/links", handler: linkSessions },
  // Without the other Session the request fails validation (400), as it always has.
  { method: "DELETE", pattern: "/api/sessions/:sessionId/links", handler: linkSessions },
  { method: "DELETE", pattern: "/api/sessions/:sessionId/links/:relatedSessionId", handler: linkSessions },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/verification",
    handler: validatedRoute(
      updateSessionVerificationInputSchema,
      "Invalid session verification payload.",
      async ({ request, params }) => ({ verification: await readJsonBody(request), sessionId: params.sessionId }),
      ({ store }, data) => store.updateSessionVerification(data.sessionId, data.verification, "web"),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/void",
    handler: validatedRoute(
      setSessionVoidInputSchema,
      "Invalid session void payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.setSessionVoid(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/evidence/:evidenceId/void",
    handler: validatedRoute(
      setEvidenceVoidInputSchema,
      "Invalid evidence void payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), evidenceId: params.evidenceId }),
      ({ store }, data) => store.setEvidenceVoid(data),
    ),
  },
  {
    method: "PATCH",
    pattern: "/api/diagrams/:diagramId/void",
    handler: validatedRoute(
      setDiagramVoidInputSchema,
      "Invalid diagram void payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), diagramId: params.diagramId }),
      ({ store }, data) => store.setDiagramVoid(data),
    ),
  },
  {
    method: "POST",
    pattern: "/api/work/finalize",
    handler: validatedRoute(
      finalizeSessionInputSchema,
      "Invalid finalize payload.",
      ({ request }) => readJsonBody(request),
      ({ store }, data) => store.finalizeSession(data),
    ),
  },
];
