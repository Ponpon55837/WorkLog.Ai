import type { DesktopSettingsV1 } from "../settings/schema.js";
import { BACKGROUND_FLAG } from "./launch-mode.js";

export interface LoginItemSettings {
  readonly openAtLogin: boolean;
  readonly args?: readonly string[];
  readonly type?: "mainAppService";
}

export type LoginItemRequest = { readonly enable: false } | { readonly enable: true; readonly consent: true };

export type LoginItemChange =
  | { readonly ok: true; readonly settings: DesktopSettingsV1; readonly loginItem: LoginItemSettings | undefined }
  | { readonly ok: false; readonly reason: "consent-required" };

export function loginItemSettingsFor(platform: NodeJS.Platform, enable: boolean): LoginItemSettings | undefined {
  if (platform === "win32") return enable ? { openAtLogin: true, args: [BACKGROUND_FLAG] } : { openAtLogin: false };
  if (platform === "darwin") return enable ? { openAtLogin: true, type: "mainAppService" } : { openAtLogin: false };
  return undefined;
}

export function changeLoginItem(
  settings: DesktopSettingsV1,
  request: LoginItemRequest,
  platform: NodeJS.Platform,
): LoginItemChange {
  const consented = request.enable && (request as { consent?: unknown }).consent === true;
  if (request.enable && !consented) return { ok: false, reason: "consent-required" };
  return {
    ok: true,
    settings: { ...settings, desired: { ...settings.desired, launchAtLogin: request.enable } },
    loginItem: loginItemSettingsFor(platform, request.enable),
  };
}
