import type {
  HandoffImportApplyInput,
  HandoffImportBatchResult,
  HandoffImportPreviewResult,
} from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface HandoffImportApi {
  previewHandoffs(
    projectRoot: string,
    handoffDirectory?: string,
    signal?: AbortSignal,
  ): Promise<HandoffImportPreviewResult>;
  importHandoffs(input: HandoffImportApplyInput, signal?: AbortSignal): Promise<HandoffImportBatchResult>;
}

export function createHandoffImportApi(client: ApiTransport): HandoffImportApi {
  return {
    previewHandoffs(
      projectRoot: string,
      handoffDirectory?: string,
      signal?: AbortSignal,
    ): Promise<HandoffImportPreviewResult> {
      return client.request<HandoffImportPreviewResult>(
        appendQuery("/api/imports/handoffs/preview", { projectRoot, handoffDirectory }),
        { signal },
      );
    },

    importHandoffs(input: HandoffImportApplyInput, signal?: AbortSignal): Promise<HandoffImportBatchResult> {
      return client.write<HandoffImportBatchResult>("/api/imports/handoffs", "POST", input, signal);
    },
  };
}
