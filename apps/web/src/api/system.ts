import type { FolderPickResult, SystemStatus } from "@work-intelligence/core";
import type { ApiHealth } from "./types";
import { type ApiTransport } from "./transport";

export interface SystemApi {
  getHealth(signal?: AbortSignal): Promise<ApiHealth>;
  getSystemStatus(signal?: AbortSignal): Promise<SystemStatus>;
  pickFolder(): Promise<FolderPickResult>;
  /** Desktop App only: asks the App to open its Agent setup window; never writes Agent settings. */
  openDesktopAgentSetup(): Promise<{ ok: true }>;
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

    openDesktopAgentSetup(): Promise<{ ok: true }> {
      return client.write<{ ok: true }>("/api/desktop/open-agent-setup", "POST", {});
    },
  };
}
