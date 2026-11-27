import { app } from "electron";
import { isAppTab, type BackendSupervisor, type ServiceOwnerState } from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Dashboard } from "./dashboard.js";
import type { RepairWindow } from "./repair-window.js";
import type { SecondInstance } from "./second-instance.js";
import type { ShellState } from "./state.js";
import type { ShellTray } from "./tray.js";

interface TestSnapshot {
  readonly owner: ServiceOwnerState;
  readonly backend: {
    readonly pid: number;
    readonly port: number;
    readonly execPath: string;
    readonly runId: string;
  } | null;
  readonly repairWindowOpen: boolean;
  readonly secondInstanceCount: number;
  readonly lastSecondInstanceDecision: string | null;
  readonly openedExternal: readonly string[];
  readonly recentErrors: readonly string[];
  readonly notifications: readonly string[];
  readonly logFile: string;
  readonly needsSetup: boolean;
  readonly tab: string;
  readonly firstRunDetectionMs: number | null;
}

export interface TestHookOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly window: RepairWindow;
  readonly secondInstance: SecondInstance;
  readonly dashboard: Dashboard;
  readonly notifications: readonly string[];
  readonly firstRunDetectionMs: () => number | undefined;
  readonly openPortSettings: () => void;
  readonly openUpdateCheck: () => void;
  readonly tray: Pick<ShellTray, "menu" | "activate">;
}

export function installTestHook(options: TestHookOptions): void {
  if (app.isPackaged) return;
  const read = (): TestSnapshot => {
    const running = options.supervisor.running;
    return {
      owner: options.state.owner,
      backend: running
        ? { pid: running.pid, port: running.port, execPath: running.execPath, runId: running.runId }
        : null,
      repairWindowOpen: options.window.isOpen(),
      secondInstanceCount: options.secondInstance.count,
      lastSecondInstanceDecision: options.secondInstance.lastDecision,
      openedExternal: [...options.dashboard.recorded],
      recentErrors: options.state.recentErrors.list().map((entry) => entry.code),
      notifications: [...options.notifications],
      logFile: options.paths.logFile,
      needsSetup: options.state.needsSetup,
      tab: options.state.tab,
      firstRunDetectionMs: options.firstRunDetectionMs() ?? null,
    };
  };
  const openRepair = (): void => options.window.open("status");
  const openPortSettings = (): void => options.openPortSettings();
  const openUpdateCheck = (): void => options.openUpdateCheck();
  const openWindow = (tab?: string): void => {
    if (tab === undefined) options.window.open();
    else if (isAppTab(tab)) options.window.open(tab);
  };
  const trayMenu = (): readonly { id: string; label: string; enabled: boolean }[] =>
    options.tray.menu().map((item) => ({ id: item.id, label: item.label, enabled: item.enabled }));
  const trayClick = (id: string): void => options.tray.activate(id);
  const planted: string[] = [];
  const realOutput = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(options.supervisor), "recentOutput")?.get;
  if (realOutput)
    Object.defineProperty(options.supervisor, "recentOutput", {
      get: () => [...(realOutput.call(options.supervisor) as readonly string[]), ...planted],
    });
  const plantOutput = (lines: readonly string[]): void => {
    planted.push(...lines);
  };
  Object.defineProperty(globalThis, "__workIntelligenceDesktopTest", {
    value: Object.freeze({
      snapshot: read,
      openRepair,
      openPortSettings,
      openUpdateCheck,
      openWindow,
      trayMenu,
      trayClick,
      plantOutput,
    }),
  });
}
