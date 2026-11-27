import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import { formatMessage, type ShellMessages } from "./i18n.js";
import type { SetupMessages } from "./setup-i18n.js";
import type { UpdateMessages } from "./update-i18n.js";

export type TrayItemId =
  "legacy-status" | "complete-setup" | "open-dashboard" | "open-app" | "check-updates" | "separator" | "quit";

export interface TrayMenuItem {
  readonly id: TrayItemId;
  readonly label: string;
  readonly enabled: boolean;
}

export interface TrayMenuInputs {
  readonly messages: ShellMessages;
  readonly owner: ServiceOwnerState;
  readonly backendRunning: boolean;
  readonly setup?: {
    readonly messages: Pick<SetupMessages, "trayCompleteSetup">;
    readonly needsSetup: boolean;
  };
  readonly update?: Pick<UpdateMessages, "trayCheckUpdates">;
  readonly legacyHeld?: Pick<SetupMessages, "trayLegacyStatus">;
}

function dashboardDisabledReason(inputs: TrayMenuInputs): string | undefined {
  const { messages, owner, backendRunning } = inputs;
  if (owner === "MANAGED" && backendRunning) return undefined;
  if (owner === "NEEDS_REPAIR") return messages.trayReasonNeedsRepair;
  if (owner === "PREPARING" || owner === "QUIESCING" || owner === "STARTING") return messages.trayReasonStarting;
  return messages.trayReasonStopped;
}

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

export function trayLocationName(platform: NodeJS.Platform, messages: ShellMessages): string {
  if (platform === "darwin") return messages.trayLocationMac;
  if (platform === "win32") return messages.trayLocationWindows;
  return messages.trayLocationOther;
}

export function trayBackgroundHint(platform: NodeJS.Platform, messages: ShellMessages): string {
  return formatMessage(messages.trayBackgroundHint, { location: trayLocationName(platform, messages) });
}

export function trayTooltip(owner: ServiceOwnerState, backendRunning: boolean, messages: ShellMessages): string {
  return owner === "MANAGED" && backendRunning ? messages.trayTooltipManaged : messages.trayTooltipNeedsRepair;
}
