import type {
  GraphPathQuery,
  GraphPathResult,
  GraphQuery,
  GraphQueryResult,
  HotspotQuery,
  HotspotResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface GraphApi {
  getGraph(options?: GraphQuery, signal?: AbortSignal): Promise<GraphQueryResult>;
  getHotspots(options?: HotspotQuery, signal?: AbortSignal): Promise<HotspotResult>;
  getGraphPath(query: GraphPathQuery, signal?: AbortSignal): Promise<GraphPathResult>;
}

export function createGraphApi(client: ApiTransport): GraphApi {
  return {
    getGraph(options: GraphQuery = {}, signal?: AbortSignal): Promise<GraphQueryResult> {
      return client.request<GraphQueryResult>(
        appendQuery("/api/graph", {
          projectRoot: options.projectRoot,
          projectId: options.projectId,
          limit: options.limit,
          maxNodes: options.maxNodes,
          maxEdges: options.maxEdges,
          pageSize: options.pageSize,
          cursor: options.cursor,
          includeDerived: options.includeDerived ? "true" : undefined,
          coChangeMinSessions: options.coChangeMinSessions,
        }),
        { signal },
      );
    },

    getGraphPath(query: GraphPathQuery, signal?: AbortSignal): Promise<GraphPathResult> {
      return client.request<GraphPathResult>(
        appendQuery("/api/graph/path", {
          projectId: query.projectId,
          from: query.from,
          to: query.to,
          includeDerived: query.includeDerived ? "true" : undefined,
        }),
        { signal },
      );
    },

    getHotspots(options: HotspotQuery = {}, signal?: AbortSignal): Promise<HotspotResult> {
      return client.request<HotspotResult>(
        appendQuery("/api/insights/hotspots", {
          projectId: options.projectId,
          from: options.from,
          to: options.to,
          groupBy: options.groupBy,
          limit: options.limit,
        }),
        { signal },
      );
    },
  };
}
