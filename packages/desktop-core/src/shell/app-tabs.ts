import type { OperationKind } from "../operations/journal-record.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

/**
 * The tabs of the one App window, in display order. Main decides which tab is selected and the page only follows it
 * (`app:get-tab`, `app:select-tab`); an id the page sends back (`app:remember-tab`) is checked against this list.
 */
export const APP_TABS = ["setup", "status", "agent", "settings", "data", "diagnostics"] as const;
export type AppTab = (typeof APP_TABS)[number];

export function isAppTab(value: unknown): value is AppTab {
  return typeof value === "string" && (APP_TABS as readonly string[]).includes(value);
}

/** What decides the tab list and the blocking tab. */
export interface AppTabInputs {
  /** No settings file yet: the first-run page has not finished. */
  readonly needsSetup: boolean;
  readonly owner: ServiceOwnerState;
  /** The old login service holds this database and the App did not start (or may not start) its backend. */
  readonly legacyHeld: boolean;
}

/** The tabs shown for a state, in display order. Setup is first and exists only while the App is not set up. */
export function tabsFor(needsSetup: boolean): readonly AppTab[] {
  return needsSetup ? APP_TABS : APP_TABS.filter((tab) => tab !== "setup");
}

/**
 * The tab a blocking state sends the user to: Status, when the service needs repair or the old login service holds
 * the database. Null when nothing blocks. Setup is never displaced by it: before the first run there is no service.
 */
export function blockingTab(inputs: AppTabInputs): AppTab | null {
  if (inputs.needsSetup) return null;
  return inputs.owner === "NEEDS_REPAIR" || inputs.legacyHeld ? "status" : null;
}

export interface InitialTabInputs extends AppTabInputs {
  /** An explicit request (the tray, a launch flag, a route inside main). It always wins when its tab exists. */
  readonly requested?: AppTab | undefined;
  /** The tab the user last selected in this App session (kept in main's memory only, never written). */
  readonly remembered?: AppTab | undefined;
}

/**
 * Which tab is selected when the window opens or is asked to come forward: the requested tab, else the blocking
 * state's tab, else the remembered tab, else Setup while the App needs it, else Status. A tab that is not in the
 * list for this state (Setup after the first run) is ignored at every step.
 */
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

/** What `app:get-tab` answers. */
export interface AppTabSelection {
  readonly tab: AppTab;
  readonly tabs: readonly AppTab[];
}

/** The dots on one tab. */
export interface AppTabBadge {
  /** Something here needs the user (the old login service holds the database, the service needs repair). */
  readonly attention: boolean;
  /** An operation of the coordinator that belongs to this tab is running. */
  readonly busy: boolean;
}

/** The tab list and one badge per tab (the blocking tab carries `attention`): what the page needs to draw the tab strip. */
export interface AppShellState {
  readonly tabs: readonly AppTab[];
  readonly badges: Readonly<Record<AppTab, AppTabBadge>>;
}

/** The tab an operation of the coordinator is shown on. */
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
  /** The kind of the operation the coordinator runs right now, when one does. */
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

/**
 * The tab the user last selected in this App session. Kept in main's memory only: nothing is written, so a new App
 * start begins from the default. A value the page sends is checked here, never trusted.
 */
export class TabMemory {
  private tab: AppTab | undefined;

  /** Remembers `tab` when it is a known id that exists for this state; returns whether it did. */
  remember(tab: unknown, needsSetup: boolean): tab is AppTab {
    if (!isAppTab(tab) || !tabsFor(needsSetup).includes(tab)) return false;
    this.tab = tab;
    return true;
  }

  recall(): AppTab | undefined {
    return this.tab;
  }
}
