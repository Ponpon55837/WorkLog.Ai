import {
  activityQuerySchema,
  graphPathQuerySchema,
  graphQuerySchema,
  hotspotQuerySchema,
  searchQuerySchema,
  timelineQuerySchema,
} from "@work-intelligence/schema";
import { numberParam, sendJson, textParam } from "../http.js";
import { validatedRoute, type Route } from "./router.js";

export const insightRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/api/graph",
    handler: validatedRoute(
      graphQuerySchema,
      "Invalid graph query.",
      ({ url }) => ({
        projectRoot: textParam(url, "projectRoot"),
        projectId: textParam(url, "projectId"),
        limit: numberParam(url, "limit"),
        maxNodes: numberParam(url, "maxNodes"),
        maxEdges: numberParam(url, "maxEdges"),
        pageSize: numberParam(url, "pageSize"),
        cursor: textParam(url, "cursor"),
        includeDerived: url.searchParams.get("includeDerived") === "true" || undefined,
        coChangeMinSessions: numberParam(url, "coChangeMinSessions"),
      }),
      ({ store }, data) => store.getGraph(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/graph/path",
    handler: validatedRoute(
      graphPathQuerySchema,
      "Invalid graph path query.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
        includeDerived: url.searchParams.get("includeDerived") === "true" || undefined,
      }),
      ({ store }, data) => store.getGraphPath(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/insights/timeline",
    handler: validatedRoute(
      timelineQuerySchema,
      "Invalid timeline query.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
      }),
      ({ store }, data) => store.getTimeline(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/insights/activity",
    handler: validatedRoute(
      activityQuerySchema,
      "Invalid activity query.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
      }),
      ({ store }, data) => store.getActivity(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/insights/hotspots",
    handler: validatedRoute(
      hotspotQuerySchema,
      "Invalid hotspot query.",
      ({ url }) => ({
        projectId: textParam(url, "projectId"),
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        groupBy: url.searchParams.get("groupBy") || undefined,
        limit: numberParam(url, "limit"),
      }),
      ({ store }, data) => store.getHotspots(data),
    ),
  },
  {
    method: "GET",
    pattern: "/api/context",
    handler: ({ store, response, url }) =>
      sendJson(response, 200, store.getContext(url.searchParams.get("projectRoot") ?? undefined)),
  },
  {
    method: "GET",
    pattern: "/api/search",
    handler: validatedRoute(
      searchQuerySchema,
      "A non-empty search query is required.",
      ({ url }) => ({
        q: url.searchParams.get("q") ?? "",
        projectRoot: url.searchParams.get("projectRoot") ?? undefined,
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
      }),
      ({ store }, data) => store.search(data.q, data.projectRoot, { from: data.from, to: data.to }),
    ),
  },
];
