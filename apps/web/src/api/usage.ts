import type { UsageProjectsResponse, UsageScanRequest, UsageScanResponse } from "@work-intelligence/core";
import { type ApiTransport } from "./transport";

export interface UsageApi {
  getUsageProjects(signal?: AbortSignal): Promise<UsageProjectsResponse>;
  scanUsage(request: UsageScanRequest, signal?: AbortSignal): Promise<UsageScanResponse>;
}

export function createUsageApi(client: ApiTransport): UsageApi {
  return {
    getUsageProjects(signal?: AbortSignal): Promise<UsageProjectsResponse> {
      return client.request<UsageProjectsResponse>("/api/usage/projects", { signal });
    },

    scanUsage(request, signal): Promise<UsageScanResponse> {
      return client.write<UsageScanResponse>("/api/usage/scan", "POST", request, signal);
    },
  };
}
