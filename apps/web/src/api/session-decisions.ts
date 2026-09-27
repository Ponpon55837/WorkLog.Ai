import type {
  ListSessionDecisionsInput,
  ReviewSessionDecisionInput,
  ReviewSessionDecisionResult,
  SessionDecisionListQueryResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface SessionDecisionsApi {
  listSessionDecisions(
    options?: ListSessionDecisionsInput,
    signal?: AbortSignal,
  ): Promise<SessionDecisionListQueryResult>;
  reviewSessionDecision(input: ReviewSessionDecisionInput, signal?: AbortSignal): Promise<ReviewSessionDecisionResult>;
}

export function createSessionDecisionsApi(client: ApiTransport): SessionDecisionsApi {
  return {
    listSessionDecisions(options: ListSessionDecisionsInput = {}, signal?: AbortSignal) {
      return client.request<SessionDecisionListQueryResult>(
        appendQuery("/api/session-decisions", {
          projectRoot: options.projectRoot,
          status: options.status,
          limit: options.limit,
        }),
        { signal },
      );
    },

    reviewSessionDecision(input: ReviewSessionDecisionInput, signal?: AbortSignal) {
      const { decisionId, ...body } = input;
      return client.write<ReviewSessionDecisionResult>(
        `/api/session-decisions/${encodeURIComponent(decisionId)}/review`,
        "PATCH",
        body,
        signal,
      );
    },
  };
}
