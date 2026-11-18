import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import { formatMessage, type ShellMessages } from "./i18n.js";
import type { SetupMessages } from "./setup-i18n.js";
import type { UpdateMessages } from "./update-i18n.js";

export type TrayItemId =
  "legacy-status" | "complete-setup" | "open-dashboard" | "open-app" | "check-updates" | "separator" | "quit";

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
  /**
   * The first-run item. `needsSetup`: the App has no settings yet (the first-run page was closed or never shown), so
   * "完成首次設定…" (the Setup tab) comes first. Omitted, or set up already: no item.
   */
  readonly setup?: {
    readonly messages: Pick<SetupMessages, "trayCompleteSetup">;
    readonly needsSetup: boolean;
  };
  /** The 「檢查更新…」 item (opens the Settings tab and starts the check). Omitted: no item. The App never checks by itself. */
  readonly update?: Pick<UpdateMessages, "trayCheckUpdates">;
  /**
   * A login start was held back because the old login service is enabled on this database: the disabled status line
   * says so. What to do about it is on the Status tab, which "Open Work Intelligence…" selects. Omitted when nothing
   * was held back.
   */
  readonly legacyHeld?: Pick<SetupMessages, "trayLegacyStatus">;
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
 * The tray menu, short on purpose: the old login service's status line (disabled, only while held), "完成首次設定…" (only
 * while the App needs setup), "Open Dashboard" (enabled only when the managed service runs, otherwise its label says
 * why), "Open <App name>…" (the window), "檢查更新…", a separator and "Quit" with its consequence in the label. Everything
 * else (repair, port, Agent setup, the old service) lives in the window's tabs.
 */
export function buildTrayMenu(inputs: TrayMenuInputs): TrayMenuItem[] {
  const { messages, legacyHeld, setup } = inputs;
  const reason = dashboardDisabledReason(inputs);
  return [
    ...(legacyHeld ? [{ id: "legacy-status" as const, label: legacyHeld.trayLegacyStatus, enabled: false }] : []),
    ...(setup?.needsSetup
      ? [{ id: "complete-setup" as const, label: setup.messages.trayCompleteSetup, enabled: true }]
      : []),
    {
      id: "open-dashboard",
      label: reason
        ? formatMessage(messages.trayDisabledTemplate, { label: messages.trayOpenDashboard, reason })
        : messages.trayOpenDashboard,
      enabled: reason === undefined,
    },
    { id: "open-app", label: formatMessage(messages.trayOpenApp, { name: messages.appName }), enabled: true },
    ...(inputs.update ? [{ id: "check-updates" as const, label: inputs.update.trayCheckUpdates, enabled: true }] : []),
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
