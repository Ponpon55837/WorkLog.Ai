import type { OperationKind } from "../operations/journal-record.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export const APP_TABS = ["setup", "status", "agent", "settings", "data", "diagnostics"] as const;
export type AppTab = (typeof APP_TABS)[number];

export function isAppTab(value: unknown): value is AppTab {
  return typeof value === "string" && (APP_TABS as readonly string[]).includes(value);
}

export interface AppTabInputs {
  readonly needsSetup: boolean;
  readonly owner: ServiceOwnerState;
  readonly legacyHeld: boolean;
}

export function tabsFor(needsSetup: boolean): readonly AppTab[] {
  return needsSetup ? APP_TABS : APP_TABS.filter((tab) => tab !== "setup");
}

export function blockingTab(inputs: AppTabInputs): AppTab | null {
  if (inputs.needsSetup) return null;
  return inputs.owner === "NEEDS_REPAIR" || inputs.legacyHeld ? "status" : null;
}

export interface InitialTabInputs extends AppTabInputs {
  readonly requested?: AppTab | undefined;
  readonly remembered?: AppTab | undefined;
}

export function initialTab(inputs: InitialTabInputs): AppTab {
  const available = tabsFor(inputs.needsSetup);
  const usable = (tab: AppTab | null | undefined): tab is AppTab =>
    tab !== null && tab !== undefined && available.includes(tab);
  if (usable(inputs.requested)) return inputs.requested;
  const blocking = blockingTab(inputs);
  if (usable(blocking)) return blocking;
  if (usable(inputs.remembered)) return inputs.remembered;
  return inputs.needsSetup ? "setup" : "status";
}

export interface AppTabSelection {
  readonly tab: AppTab;
  readonly tabs: readonly AppTab[];
}

export interface AppTabBadge {
  readonly attention: boolean;
  readonly busy: boolean;
}

export interface AppShellState {
  readonly tabs: readonly AppTab[];
  readonly badges: Readonly<Record<AppTab, AppTabBadge>>;
}

export function tabForOperation(kind: OperationKind, needsSetup: boolean): AppTab {
  switch (kind) {
    case "takeover":
      return needsSetup ? "setup" : "status";
    case "change-port":
      return "settings";
    case "change-db":
    case "restore":
    case "maintenance":
      return "data";
    case "apply-agent":
      return "agent";
    case "restart":
    case "legacy-disable":
      return "status";
  }
}

export interface AppShellInputs extends AppTabInputs {
  readonly operation: OperationKind | null;
}

export function buildAppShellState(inputs: AppShellInputs): AppShellState {
  const blocking = blockingTab(inputs);
  const busyTab = inputs.operation === null ? null : tabForOperation(inputs.operation, inputs.needsSetup);
  const badges = Object.fromEntries(
    APP_TABS.map((tab) => [tab, { attention: tab === blocking, busy: tab === busyTab }]),
  ) as Record<AppTab, AppTabBadge>;
  return { tabs: tabsFor(inputs.needsSetup), badges };
}

export class TabMemory {
  private tab: AppTab | undefined;

  remember(tab: unknown, needsSetup: boolean): tab is AppTab {
    if (!isAppTab(tab) || !tabsFor(needsSetup).includes(tab)) return false;
    this.tab = tab;
    return true;
  }

  recall(): AppTab | undefined {
    return this.tab;
  }
}
