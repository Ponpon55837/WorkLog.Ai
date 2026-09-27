import type {
  KnowledgePageListResult,
  KnowledgePageVersionsResult,
  RequestKnowledgePageUpdateInput,
  RequestKnowledgePageUpdateResult,
  UpdateKnowledgePageInput,
  UpdateKnowledgePageResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface KnowledgePagesApi {
  listKnowledgePages(projectRoot?: string, signal?: AbortSignal): Promise<KnowledgePageListResult>;
  requestKnowledgePageUpdate(
    input: RequestKnowledgePageUpdateInput,
    signal?: AbortSignal,
  ): Promise<RequestKnowledgePageUpdateResult>;
  updateKnowledgePage(input: UpdateKnowledgePageInput, signal?: AbortSignal): Promise<UpdateKnowledgePageResult>;
  listKnowledgePageVersions(pageId: string, signal?: AbortSignal): Promise<KnowledgePageVersionsResult>;
}

export function createKnowledgePagesApi(client: ApiTransport): KnowledgePagesApi {
  return {
    listKnowledgePages(projectRoot?: string, signal?: AbortSignal) {
      return client.request<KnowledgePageListResult>(appendQuery("/api/knowledge-pages", { projectRoot }), { signal });
    },

    requestKnowledgePageUpdate(input: RequestKnowledgePageUpdateInput, signal?: AbortSignal) {
      return client.write<RequestKnowledgePageUpdateResult>(
        "/api/knowledge-pages/update-requests",
        "POST",
        input,
        signal,
      );
    },

    updateKnowledgePage(input: UpdateKnowledgePageInput, signal?: AbortSignal) {
      const { pageId, ...body } = input;
      return client.write<UpdateKnowledgePageResult>(
        `/api/knowledge-pages/${encodeURIComponent(pageId)}`,
        "PATCH",
        body,
        signal,
      );
    },

    listKnowledgePageVersions(pageId: string, signal?: AbortSignal) {
      return client.request<KnowledgePageVersionsResult>(
        `/api/knowledge-pages/${encodeURIComponent(pageId)}/versions`,
        { signal },
      );
    },
  };
}
