import { loginItemSettingsFor } from "./login-item.js";

export type LoginItemSystemState = "enabled" | "disabled" | "needs-approval" | "unknown";

export interface RepairLoginItemSection {
  readonly supported: boolean;
  readonly desired: boolean;
  readonly system: LoginItemSystemState;
}

export type LoginItemNote = "none" | "disabled-by-system" | "needs-approval" | "enabled-outside-app" | "unknown";

export function loginItemQueryFor(
  platform: NodeJS.Platform,
): { readonly args?: readonly string[]; readonly type?: "mainAppService" } | undefined {
  const item = loginItemSettingsFor(platform, true);
  if (!item) return undefined;
  return { ...(item.args ? { args: item.args } : {}), ...(item.type ? { type: item.type } : {}) };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function readSystemLoginItem(platform: NodeJS.Platform, raw: unknown): LoginItemSystemState {
  const item = object(raw);
  if (!item) return "unknown";
  if (platform === "darwin") {
    switch (item.status) {
      case "enabled":
        return "enabled";
      case "not-registered":
        return "disabled";
      case "requires-approval":
        return "needs-approval";
      default:
        return "unknown";
    }
  }
  if (platform === "win32") {
    if (typeof item.openAtLogin !== "boolean") return "unknown";
    if (!item.openAtLogin) return "disabled";
    return item.executableWillLaunchAtLogin === false ? "disabled" : "enabled";
  }
  return "unknown";
}

export function loginItemNote(section: RepairLoginItemSection): LoginItemNote {
  if (!section.supported) return "none";
  if (section.system === "unknown") return "unknown";
  if (section.desired) {
    if (section.system === "needs-approval") return "needs-approval";
    return section.system === "enabled" ? "none" : "disabled-by-system";
  }
  return section.system === "enabled" || section.system === "needs-approval" ? "enabled-outside-app" : "none";
}

// An entry already registered is left alone even if disabled: rewriting `openAtLogin: true` on Windows may clear the user's "off" mark.
export function shouldApplyLoginItemAtStart(platform: NodeJS.Platform, raw: unknown, desired: boolean): boolean {
  const item = object(raw);
  let registered: boolean | undefined;
  if (platform === "win32" && typeof item?.openAtLogin === "boolean") registered = item.openAtLogin;
  if (platform === "darwin" && typeof item?.status === "string") {
    if (item.status === "enabled" || item.status === "requires-approval") registered = true;
    else if (item.status === "not-registered") registered = false;
  }
  return registered === undefined || registered !== desired;
}
