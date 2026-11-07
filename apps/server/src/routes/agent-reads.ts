import { agentReadStatsQuerySchema, agentReadsQuerySchema } from "@work-intelligence/schema";
import { numberParam, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

export const agentReadRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/agent-reads",
    handler: validatedRoute(
      agentReadsQuerySchema,
      "Invalid agent read filters.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        agent: textParam(url, "agent"),
        page: numberParam(url, "page"),
        pageSize: numberParam(url, "pageSize"),
      }),
      ({ store }, data) =>
        store.listAgentReads({
          projectId: data.projectId,
          agentClient: data.agent,
          page: data.page,
          pageSize: data.pageSize,
        }),
    ),
  },
  {
    method: "GET",
    pattern: "/api/agent-reads/stats",
    handler: validatedRoute(
      agentReadStatsQuerySchema,
      "Invalid agent read stats filters.",
      ({ url }) => ({ projectId: textParam(url, "projectId"), agentClient: textParam(url, "agent") }),
      ({ store }, data) => store.summarizeAgentReads({ projectId: data.projectId, agentClient: data.agentClient }),
    ),
  },
  {
    method: "GET",
    pattern: "/api/sessions/:sessionId/agent-reads",
    handler: ({ store, response, params }) =>
      sendJson(response, 200, store.getAgentReadsForRecord("session", params.sessionId!, 20)),
  },
  {
    method: "GET",
    pattern: "/api/knowledge/:knowledgeId/agent-reads",
    handler: ({ store, response, params }) =>
      sendJson(response, 200, store.getAgentReadsForRecord("knowledge", params.knowledgeId!, 20)),
  },
];
