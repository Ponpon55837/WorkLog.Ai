import type {
  AttentionQuery,
  AttentionResult,
  AttentionPreferenceResult,
  UpdateAttentionPreference,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface AttentionApi {
  updateAttentionPreference(input: UpdateAttentionPreference): Promise<AttentionPreferenceResult>;
  getAttention(options?: AttentionQuery, signal?: AbortSignal): Promise<AttentionResult>;
}

export function createAttentionApi(client: ApiTransport): AttentionApi {
  return {
    updateAttentionPreference: (input) =>
      client.request<AttentionPreferenceResult>("/api/attention/preferences", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    getAttention: (options = {}, signal) =>
      client.request<AttentionResult>(appendQuery("/api/attention", { ...options }), { signal }),
  };
}
