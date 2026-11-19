import { loginItemSettingsFor } from "./login-item.js";

/** What the operating system says about this App's login item. */
export type LoginItemSystemState = "enabled" | "disabled" | "needs-approval" | "unknown";

/** The 「登入時自動啟動」 section of the Settings tab: what the user asked for and what the system really does. */
export interface RepairLoginItemSection {
  /** Windows and macOS only; elsewhere there is no login item to switch. */
  readonly supported: boolean;
  /** The user's choice, as kept in the App's settings. */
  readonly desired: boolean;
  /** What the system reports now (read from Electron, never from the settings file). */
  readonly system: LoginItemSystemState;
}

/** Why the two differ, or `none` when they agree. */
export type LoginItemNote = "none" | "disabled-by-system" | "needs-approval" | "enabled-outside-app" | "unknown";

/** Arguments for `app.getLoginItemSettings` that make it look at the same entry `setLoginItemSettings` wrote. */
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

/**
 * Reads Electron's `getLoginItemSettings` answer. Windows: `executableWillLaunchAtLogin` is false when the user turned
 * the entry off in the system's startup settings. macOS: `status` says whether the entry is registered, enabled or
 * waiting for the user's approval. Anything else is `unknown`, which the page words neutrally.
 */
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

/** The sentence the page adds under the switch, chosen from the user's choice and the system's answer. */
export function loginItemNote(section: RepairLoginItemSection): LoginItemNote {
  if (!section.supported) return "none";
  if (section.system === "unknown") return "unknown";
  if (section.desired) {
    if (section.system === "needs-approval") return "needs-approval";
    return section.system === "enabled" ? "none" : "disabled-by-system";
  }
  return section.system === "enabled" || section.system === "needs-approval" ? "enabled-outside-app" : "none";
}
