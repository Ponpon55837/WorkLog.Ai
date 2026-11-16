import type { DesktopSettingsV1 } from "../settings/schema.js";
import { BACKGROUND_FLAG } from "./launch-mode.js";

/** The arguments for Electron's `app.setLoginItemSettings`. `openAsHidden` is gone since Electron 44. */
export interface LoginItemSettings {
  readonly openAtLogin: boolean;
  /** Windows: the login entry starts the App in background mode. */
  readonly args?: readonly string[];
  /** macOS: the App registers itself as its own main-app login item. */
  readonly type?: "mainAppService";
}

/** A user's request to change the login item. Turning it on needs an explicit, user-made consent. */
export type LoginItemRequest = { readonly enable: false } | { readonly enable: true; readonly consent: true };

export type LoginItemChange =
  | { readonly ok: true; readonly settings: DesktopSettingsV1; readonly loginItem: LoginItemSettings | undefined }
  | { readonly ok: false; readonly reason: "consent-required" };

/** What the login item must look like on `platform`; undefined where Electron has no login item (Linux). */
export function loginItemSettingsFor(platform: NodeJS.Platform, enable: boolean): LoginItemSettings | undefined {
  if (platform === "win32") return enable ? { openAtLogin: true, args: [BACKGROUND_FLAG] } : { openAtLogin: false };
  if (platform === "darwin") return enable ? { openAtLogin: true, type: "mainAppService" } : { openAtLogin: false };
  return undefined;
}

/**
 * Applies a login-item request to the settings. The default is off (a fresh settings file says `launchAtLogin: false`),
 * and the only way to turn it on is a request that carries `consent: true`, so no code path starts the App at login
 * without the user having asked. Turning it off never needs consent.
 */
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
