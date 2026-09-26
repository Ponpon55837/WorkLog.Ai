import type { GraphQuery, GraphQueryResult } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface GraphApi {
  getGraph(options?: GraphQuery, signal?: AbortSignal): Promise<GraphQueryResult>;
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
  };
}
