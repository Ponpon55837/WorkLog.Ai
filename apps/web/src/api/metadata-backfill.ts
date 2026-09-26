import type {
  CancelMetadataBackfillRequestResult,
  CreateMetadataBackfillRequestResult,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestListQueryResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface MetadataBackfillApi {
  listMetadataBackfillRequests(signal?: AbortSignal): Promise<MetadataBackfillRequestListQueryResult>;
  createMetadataBackfillRequest(projectId?: string, signal?: AbortSignal): Promise<CreateMetadataBackfillRequestResult>;
  cancelMetadataBackfillRequest(requestId: string, signal?: AbortSignal): Promise<CancelMetadataBackfillRequestResult>;
  previewMetadataBackfill(limit?: number, signal?: AbortSignal): Promise<MetadataBackfillPreviewResult>;
}

export function createMetadataBackfillApi(client: ApiTransport): MetadataBackfillApi {
  return {
    listMetadataBackfillRequests(signal?: AbortSignal): Promise<MetadataBackfillRequestListQueryResult> {
      return client.request<MetadataBackfillRequestListQueryResult>(
        "/api/backfill/metadata-requests?scopeType=all&limit=1",
        { signal },
      );
    },

    createMetadataBackfillRequest(
      projectId?: string,
      signal?: AbortSignal,
    ): Promise<CreateMetadataBackfillRequestResult> {
      return client.write<CreateMetadataBackfillRequestResult>(
        "/api/backfill/metadata-requests",
        "POST",
        { projectId },
        signal,
      );
    },

    cancelMetadataBackfillRequest(
      requestId: string,
      signal?: AbortSignal,
    ): Promise<CancelMetadataBackfillRequestResult> {
      return client.write<CancelMetadataBackfillRequestResult>(
        `/api/backfill/metadata-requests/${encodeURIComponent(requestId)}/cancel`,
        "POST",
        {},
        signal,
      );
    },

    previewMetadataBackfill(limit = 50, signal?: AbortSignal): Promise<MetadataBackfillPreviewResult> {
      return client.request<MetadataBackfillPreviewResult>(appendQuery("/api/backfill/metadata/preview", { limit }), {
        signal,
      });
    },
  };
}
