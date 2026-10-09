import type { AttentionQuery, AttentionResult } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface AttentionApi {
  getAttention(options?: AttentionQuery, signal?: AbortSignal): Promise<AttentionResult>;
}

export function createAttentionApi(client: ApiTransport): AttentionApi {
  return {
    getAttention: (options = {}, signal) =>
      client.request<AttentionResult>(appendQuery("/api/attention", { ...options }), { signal }),
  };
}
