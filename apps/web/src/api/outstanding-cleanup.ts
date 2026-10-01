import type {
  CancelOutstandingCleanupRequestResult,
  CreateOutstandingCleanupRequestInput,
  CreateOutstandingCleanupRequestResult,
  DecideOutstandingCleanupProposalsInput,
  DecideOutstandingCleanupProposalsResult,
  OutstandingCleanupProposalListResult,
  OutstandingCleanupProposalQuery,
  OutstandingCleanupRequestListResult,
  OutstandingCleanupRequestQuery,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface OutstandingCleanupApi {
  listOutstandingCleanupRequests(
    input: OutstandingCleanupRequestQuery,
    signal?: AbortSignal,
  ): Promise<OutstandingCleanupRequestListResult>;
  createOutstandingCleanupRequest(
    input: CreateOutstandingCleanupRequestInput,
    signal?: AbortSignal,
  ): Promise<CreateOutstandingCleanupRequestResult>;
  listOutstandingCleanupProposals(
    input: OutstandingCleanupProposalQuery,
    signal?: AbortSignal,
  ): Promise<OutstandingCleanupProposalListResult>;
  decideOutstandingCleanupProposals(
    input: DecideOutstandingCleanupProposalsInput,
    signal?: AbortSignal,
  ): Promise<DecideOutstandingCleanupProposalsResult>;
  cancelOutstandingCleanupRequest(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<CancelOutstandingCleanupRequestResult>;
}

/** Uses the same guarded REST routes for project requests and human proposal review. */
export function createOutstandingCleanupApi(client: ApiTransport): OutstandingCleanupApi {
  return {
    listOutstandingCleanupRequests(input, signal) {
      return client.request(appendQuery("/api/outstanding-cleanup/requests", { ...input }), { signal });
    },
    createOutstandingCleanupRequest(input, signal) {
      return client.write("/api/outstanding-cleanup/requests", "POST", input, signal);
    },
    listOutstandingCleanupProposals(input, signal) {
      const { requestId, ...query } = input;
      return client.request(
        appendQuery(`/api/outstanding-cleanup/requests/${encodeURIComponent(requestId)}/proposals`, query),
        { signal },
      );
    },
    decideOutstandingCleanupProposals(input, signal) {
      const { requestId, ...body } = input;
      return client.write(
        `/api/outstanding-cleanup/requests/${encodeURIComponent(requestId)}/decisions`,
        "POST",
        body,
        signal,
      );
    },
    cancelOutstandingCleanupRequest(requestId, signal) {
      return client.write(
        `/api/outstanding-cleanup/requests/${encodeURIComponent(requestId)}/cancel`,
        "POST",
        {},
        signal,
      );
    },
  };
}
