import type { FolderPickResult, SystemStatus } from "@work-intelligence/core";
import type { ApiHealth } from "./types";
import { type ApiTransport } from "./transport";

export interface SystemApi {
  getHealth(signal?: AbortSignal): Promise<ApiHealth>;
  getSystemStatus(signal?: AbortSignal): Promise<SystemStatus>;
  pickFolder(): Promise<FolderPickResult>;
}

export function createSystemApi(client: ApiTransport): SystemApi {
  return {
    getHealth(signal?: AbortSignal): Promise<ApiHealth> {
      return client.request<ApiHealth>("/api/health", { signal });
    },

    getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
      return client.request<SystemStatus>("/api/system/status", { signal });
    },

    pickFolder(): Promise<FolderPickResult> {
      return client.write<FolderPickResult>("/api/system/pick-folder", "POST", {});
    },
  };
}
