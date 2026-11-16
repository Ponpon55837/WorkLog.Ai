import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import { formatMessage, type ShellMessages } from "./i18n.js";

export type TrayItemId = "open-dashboard" | "repair" | "separator" | "quit";

/** One row of the tray menu as data; the Electron layer only turns it into a native menu. */
export interface TrayMenuItem {
  readonly id: TrayItemId;
  readonly label: string;
  readonly enabled: boolean;
}

export interface TrayMenuInputs {
  readonly messages: ShellMessages;
  readonly owner: ServiceOwnerState;
  readonly backendRunning: boolean;
}

/** Why the Dashboard cannot open right now, in the user's words; undefined when it can. */
function dashboardDisabledReason(inputs: TrayMenuInputs): string | undefined {
  const { messages, owner, backendRunning } = inputs;
  if (owner === "MANAGED" && backendRunning) return undefined;
  if (owner === "NEEDS_REPAIR") return messages.trayReasonNeedsRepair;
  if (owner === "PREPARING" || owner === "QUIESCING" || owner === "STARTING") return messages.trayReasonStarting;
  return messages.trayReasonStopped;
}

/**
 * The tray menu: "Open Dashboard" always comes first and is enabled only when the managed service runs, otherwise its
 * label says why it is disabled. Then "Repair…", a separator, and "Quit" with its consequence in the label.
 */
export function buildTrayMenu(inputs: TrayMenuInputs): TrayMenuItem[] {
  const { messages } = inputs;
  const reason = dashboardDisabledReason(inputs);
  return [
    {
      id: "open-dashboard",
      label: reason
        ? formatMessage(messages.trayDisabledTemplate, { label: messages.trayOpenDashboard, reason })
        : messages.trayOpenDashboard,
      enabled: reason === undefined,
    },
    { id: "repair", label: messages.trayRepair, enabled: true },
    { id: "separator", label: "", enabled: false },
    { id: "quit", label: messages.trayQuit, enabled: true },
  ];
}

/** macOS calls the tray area the menu bar, Windows the notification area. */
export function trayLocationName(platform: NodeJS.Platform, messages: ShellMessages): string {
  if (platform === "darwin") return messages.trayLocationMac;
  if (platform === "win32") return messages.trayLocationWindows;
  return messages.trayLocationOther;
}

/** The sentence that tells a user the App keeps running in the tray, with the platform's own word for it. */
export function trayBackgroundHint(platform: NodeJS.Platform, messages: ShellMessages): string {
  return formatMessage(messages.trayBackgroundHint, { location: trayLocationName(platform, messages) });
}

/** Tooltip of the tray icon. */
export function trayTooltip(owner: ServiceOwnerState, backendRunning: boolean, messages: ShellMessages): string {
  return owner === "MANAGED" && backendRunning ? messages.trayTooltipManaged : messages.trayTooltipNeedsRepair;
}
