import type {
  AgentReviewItemKind,
  AgentReviewRequestListResult,
  AgentReviewRequestQuery,
  CancelAgentReviewRequestResult,
  CreateAgentReviewRequestInput,
  CreateAgentReviewRequestResult,
  OverturnAgentReviewInput,
  OverturnAgentReviewResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface AgentReviewApi {
  listAgentReviewRequests(input: AgentReviewRequestQuery, signal?: AbortSignal): Promise<AgentReviewRequestListResult>;
  createAgentReviewRequest(
    input: CreateAgentReviewRequestInput,
    signal?: AbortSignal,
  ): Promise<CreateAgentReviewRequestResult>;
  cancelAgentReviewRequest(requestId: string, signal?: AbortSignal): Promise<CancelAgentReviewRequestResult>;
  overturnAgentReview(input: OverturnAgentReviewInput, signal?: AbortSignal): Promise<OverturnAgentReviewResult>;
}

const OVERTURN_PATHS: Record<AgentReviewItemKind, (itemId: string) => string> = {
  decision: (itemId) => `/api/session-decisions/${encodeURIComponent(itemId)}/overturn`,
  candidate: (itemId) => `/api/knowledge/candidates/${encodeURIComponent(itemId)}/overturn`,
};

/** Requests an Agent to review a project's pending items and lets a person overturn what it decided. */
export function createAgentReviewApi(client: ApiTransport): AgentReviewApi {
  return {
    listAgentReviewRequests(input, signal) {
      return client.request(appendQuery("/api/agent-review-requests", { ...input }), { signal });
    },
    createAgentReviewRequest(input, signal) {
      return client.write("/api/agent-review-requests", "POST", input, signal);
    },
    cancelAgentReviewRequest(requestId, signal) {
      return client.write(`/api/agent-review-requests/${encodeURIComponent(requestId)}/cancel`, "POST", {}, signal);
    },
    overturnAgentReview(input, signal) {
      return client.write(
        OVERTURN_PATHS[input.itemKind](input.itemId),
        "POST",
        { projectRoot: input.projectRoot },
        signal,
      );
    },
  };
}
