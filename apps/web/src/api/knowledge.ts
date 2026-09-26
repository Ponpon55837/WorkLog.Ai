import type {
  KnowledgeHistoryResult,
  KnowledgeSearchResult,
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidateListResult,
  RequestKnowledgeCandidatesResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
} from "@work-intelligence/core";
import type { KnowledgeRequest } from "./types";
import { appendQuery, type ApiTransport } from "./transport";

export interface KnowledgeApi {
  listKnowledgeCandidates(projectRoot?: string, signal?: AbortSignal): Promise<KnowledgeCandidateListResult>;
  requestKnowledgeCandidates(projectRoot: string, signal?: AbortSignal): Promise<RequestKnowledgeCandidatesResult>;
  decideKnowledgeCandidate(
    input: DecideKnowledgeCandidateInput,
    signal?: AbortSignal,
  ): Promise<DecideKnowledgeCandidateResult>;
  searchKnowledge(options?: KnowledgeRequest, signal?: AbortSignal): Promise<KnowledgeSearchResult>;
  getKnowledgeHistory(
    knowledgeId: string,
    options: { projectRoot: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<KnowledgeHistoryResult>;
  updateKnowledge(
    knowledgeId: string,
    input: Omit<UpdateKnowledgeInput, "knowledgeId">,
    signal?: AbortSignal,
  ): Promise<UpdateKnowledgeResult>;
}

export function createKnowledgeApi(client: ApiTransport): KnowledgeApi {
  return {
    listKnowledgeCandidates(projectRoot?: string, signal?: AbortSignal): Promise<KnowledgeCandidateListResult> {
      return client.request<KnowledgeCandidateListResult>(appendQuery("/api/knowledge/candidates", { projectRoot }), {
        signal,
      });
    },

    requestKnowledgeCandidates(projectRoot: string, signal?: AbortSignal): Promise<RequestKnowledgeCandidatesResult> {
      return client.write<RequestKnowledgeCandidatesResult>(
        "/api/knowledge/candidate-requests",
        "POST",
        { projectRoot },
        signal,
      );
    },

    decideKnowledgeCandidate(
      input: DecideKnowledgeCandidateInput,
      signal?: AbortSignal,
    ): Promise<DecideKnowledgeCandidateResult> {
      const { candidateId, ...body } = input;
      return client.write<DecideKnowledgeCandidateResult>(
        `/api/knowledge/candidates/${encodeURIComponent(candidateId)}/decision`,
        "POST",
        body,
        signal,
      );
    },

    searchKnowledge(options: KnowledgeRequest = {}, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
      return client.request<KnowledgeSearchResult>(
        appendQuery("/api/knowledge", {
          projectId: options.projectId,
          q: options.q ?? options.query,
          kind: options.kind,
          status: options.status,
          page: options.page,
          pageSize: options.pageSize === "all" ? 0 : options.pageSize,
          limit: options.limit,
        }),
        { signal },
      );
    },

    getKnowledgeHistory(
      knowledgeId: string,
      options: { projectRoot: string; limit?: number },
      signal?: AbortSignal,
    ): Promise<KnowledgeHistoryResult> {
      return client.request<KnowledgeHistoryResult>(
        appendQuery(`/api/knowledge/${encodeURIComponent(knowledgeId)}/history`, options),
        { signal },
      );
    },

    updateKnowledge(
      knowledgeId: string,
      input: Omit<UpdateKnowledgeInput, "knowledgeId">,
      signal?: AbortSignal,
    ): Promise<UpdateKnowledgeResult> {
      return client.write<UpdateKnowledgeResult>(
        `/api/knowledge/${encodeURIComponent(knowledgeId)}`,
        "PATCH",
        { ...input, knowledgeId },
        signal,
      );
    },
  };
}
