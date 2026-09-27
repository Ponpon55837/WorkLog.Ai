import type { GraphQuery, GraphQueryResult, HotspotQuery, HotspotResult } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface GraphApi {
  getGraph(options?: GraphQuery, signal?: AbortSignal): Promise<GraphQueryResult>;
  getHotspots(options?: HotspotQuery, signal?: AbortSignal): Promise<HotspotResult>;
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
