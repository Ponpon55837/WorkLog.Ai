import type {
  OutstandingItemListQueryResult,
  UpdateOutstandingItemStatusInput,
  UpdateOutstandingItemStatusResult,
} from "@work-intelligence/core";
import type { OutstandingItemsRequest } from "./types";
import { appendQuery, type ApiTransport } from "./transport";

export interface OutstandingItemsApi {
  listOutstandingItems(
    options?: OutstandingItemsRequest,
    signal?: AbortSignal,
  ): Promise<OutstandingItemListQueryResult>;
  updateOutstandingItemStatus(
    input: UpdateOutstandingItemStatusInput,
    signal?: AbortSignal,
  ): Promise<UpdateOutstandingItemStatusResult>;
}

export function createOutstandingItemsApi(client: ApiTransport): OutstandingItemsApi {
  return {
    listOutstandingItems(options: OutstandingItemsRequest = {}, signal?: AbortSignal) {
      return client.request<OutstandingItemListQueryResult>(
        appendQuery("/api/outstanding-items", {
          projectId: options.projectId,
          status: options.status,
          page: options.page,
          pageSize: options.pageSize === "all" ? 0 : options.pageSize,
        }),
        { signal },
      );
    },

    updateOutstandingItemStatus(input: UpdateOutstandingItemStatusInput, signal?: AbortSignal) {
      const { itemId, status } = input;
      return client.write<UpdateOutstandingItemStatusResult>(
        `/api/outstanding-items/${encodeURIComponent(itemId)}`,
        "PATCH",
        { status },
        signal,
      );
    },
  };
}
