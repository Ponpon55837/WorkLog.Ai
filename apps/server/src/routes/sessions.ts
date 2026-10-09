import {
  attachEvidenceInputSchema,
  relatedWorkQuerySchema,
  deleteSessionInputSchema,
  finalizeSessionInputSchema,
  linkSessionsInputSchema,
  sessionsQuerySchema,
  setDiagramVoidInputSchema,
  setEvidenceVoidInputSchema,
  setSessionVoidInputSchema,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema,
  updateSessionTitleInputSchema,
  updateSessionVerificationInputSchema,
  updateSessionWorkSummaryInputSchema,
} from "@work-intelligence/schema";
import { SessionDeletionError } from "@work-intelligence/storage";
import { numberParam, readJsonBody, readJsonObject, sendError, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route, type RouteContext } from "./router.js";

/** Permanent deletion of a voided Session; the JSON confirmation keeps it out of reach of plain links and forms. */
async function deleteSession({ store, request, response, params }: RouteContext): Promise<void> {
  const parsed = deleteSessionInputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    sendError(response, 400, "Invalid session deletion confirmation.", parsed.error.flatten());
    return;
  }
  try {
    sendJson(response, 200, store.deleteSession(params.sessionId!));
  } catch (error) {
    if (!(error instanceof SessionDeletionError)) {
      throw error;
    }
    switch (error.code) {
      case "SESSION_NOT_FOUND":
        sendError(response, 404, "Session not found.", undefined, error.code);
        return;
      case "SESSION_NOT_VOIDED":
        sendError(response, 409, "Only a voided Session can be permanently deleted.", undefined, error.code);
        return;
      case "SESSION_CITED_BY_PENDING_CLEANUP":
        sendError(
          response,
          409,
          "A pending outstanding-item cleanup proposal cites this Session; review it first.",
          undefined,
          error.code,
        );
        return;
      case "SESSION_BACKUP_FAILED":
        sendError(
          response,
          503,
          "The required pre-deletion backup could not be created; the Session was not deleted.",
          undefined,
          error.code,
        );
        return;
      case "SESSION_DELETE_FAILED":
        sendError(
          response,
          500,
          "Session deletion failed; the pre-deletion backup is preserved.",
          undefined,
          error.code,
        );
        return;
    }
  }
}

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
    pattern: "/api/sessions/:sessionId/related",
    handler: validatedRoute(
      relatedWorkQuerySchema,
      "Invalid related work query.",
      ({ params, url }) => ({ ...Object.fromEntries(url.searchParams), sessionId: params.sessionId }),
      ({ store }, data) => store.getRelatedWork(data.sessionId),
    ),
  },
  {
    method: "GET",
    pattern: "/api/sessions",
    handler: validatedRoute(
      sessionsQuerySchema,
      "Invalid session filters.",
      ({ url }) => ({
        q: textParam(url, "q"),
        projectId: textParam(url, "projectId"),
        agent: textParam(url, "agent"),
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
          agentClient: data.agent,
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
    pattern: "/api/sessions/agents",
    handler: ({ store, response }) => sendJson(response, 200, { agents: store.listSessionAgentClients() }),
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
  { method: "DELETE", pattern: "/api/sessions/:sessionId", handler: deleteSession },
  {
    method: "PATCH",
    pattern: "/api/sessions/:sessionId/title",
    handler: validatedRoute(
      updateSessionTitleInputSchema,
      "Invalid session title payload.",
      async ({ request, params }) => ({ ...(await readJsonObject(request)), sessionId: params.sessionId }),
      ({ store }, data) => store.updateSessionTitle(data),
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
