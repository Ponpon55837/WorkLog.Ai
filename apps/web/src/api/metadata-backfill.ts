import type {
  CancelMetadataBackfillRequestResult,
  CreateMetadataBackfillRequestResult,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestQuery,
  MetadataBackfillRequestListQueryResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface MetadataBackfillApi {
  listMetadataBackfillRequests(
    signal?: AbortSignal,
    query?: MetadataBackfillRequestQuery,
  ): Promise<MetadataBackfillRequestListQueryResult>;
  createMetadataBackfillRequest(projectId?: string, signal?: AbortSignal): Promise<CreateMetadataBackfillRequestResult>;
  cancelMetadataBackfillRequest(requestId: string, signal?: AbortSignal): Promise<CancelMetadataBackfillRequestResult>;
  previewMetadataBackfill(
    limit?: number,
    signal?: AbortSignal,
    projectRoot?: string,
  ): Promise<MetadataBackfillPreviewResult>;
}

export function createMetadataBackfillApi(client: ApiTransport): MetadataBackfillApi {
  return {
    listMetadataBackfillRequests(
      signal?: AbortSignal,
      query?: MetadataBackfillRequestQuery,
    ): Promise<MetadataBackfillRequestListQueryResult> {
      return client.request<MetadataBackfillRequestListQueryResult>(
        appendQuery("/api/backfill/metadata-requests", {
          scopeType: query?.projectId ? "project" : "all",
          limit: 1,
          ...query,
        }),
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

    previewMetadataBackfill(
      limit = 50,
      signal?: AbortSignal,
      projectRoot?: string,
    ): Promise<MetadataBackfillPreviewResult> {
      return client.request<MetadataBackfillPreviewResult>(
        appendQuery("/api/backfill/metadata/preview", { limit, projectRoot }),
        {
          signal,
        },
      );
    },
  };
}
