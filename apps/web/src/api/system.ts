import type { FolderPickResult, SystemStatus } from "@work-intelligence/core";
import type { BrowserPreferences } from "@work-intelligence/schema/port-handoff";
import type { ApiHealth } from "./types";
import { type ApiTransport } from "./transport";

export interface SystemApi {
  getHealth(signal?: AbortSignal): Promise<ApiHealth>;
  getSystemStatus(signal?: AbortSignal): Promise<SystemStatus>;
  pickFolder(): Promise<FolderPickResult>;
  /** Desktop App only: asks the App to open its Agent setup window; never writes Agent settings. */
  openDesktopAgentSetup(): Promise<{ ok: true }>;
  openDesktopPortSettings(handoff: { preferences: BrowserPreferences; route: string }): Promise<{ ok: true }>;
  /** Desktop App only: tells the App which language the user picked here ("en" is this page's "en-US"). */
  setDesktopLanguage(locale: "zh-TW" | "en"): Promise<{ ok: true }>;
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

    openDesktopPortSettings(handoff): Promise<{ ok: true }> {
      return client.write<{ ok: true }>("/api/desktop/open-port-settings", "POST", handoff);
    },

    setDesktopLanguage(locale): Promise<{ ok: true }> {
      return client.write<{ ok: true }>("/api/desktop/language", "POST", { locale });
    },
  };
}
