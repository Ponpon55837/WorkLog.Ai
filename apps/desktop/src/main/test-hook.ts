import { app } from "electron";
import { isAppTab, type BackendSupervisor, type ServiceOwnerState } from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Dashboard } from "./dashboard.js";
import type { RepairWindow } from "./repair-window.js";
import type { SecondInstance } from "./second-instance.js";
import type { ShellState } from "./state.js";
import type { ShellTray } from "./tray.js";

/** What the test hook shows; present only when the App is not packaged. */
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
  /** Titles of the "ready again" notifications the App tried to show. */
  readonly notifications: readonly string[];
  readonly logFile: string;
  /** No settings file yet: the first-run page is (or will be) shown instead of a start. */
  readonly needsSetup: boolean;
  /** The tab the App window shows (or would show when it opens). */
  readonly tab: string;
  /** How long the first-run detection took, once it ran. */
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
  /** What the tray's 「變更連接埠…」 item runs (the same function), so a test goes through the real path. */
  readonly openPortSettings: () => void;
  /** What the tray's 「檢查更新…」 item runs. */
  readonly openUpdateCheck: () => void;
  /** The tray: its menu items as data, and what a click on one of them runs. */
  readonly tray: Pick<ShellTray, "menu" | "activate">;
}

/**
 * `globalThis.__workIntelligenceDesktopTest.snapshot()` for the smoke tests. The caller installs it only when
 * `__WI_TEST_BUILD__` is true, so no production bundle contains this module; it is also skipped in a packaged App.
 */
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
  // The tray cannot be clicked in a test: the window's Status tab (what the old tray 「修復…」 showed), and the port section
  // through the very handler the 「變更連接埠…」 item runs, and the update check through the one 「檢查更新…」 runs.
  const openRepair = (): void => options.window.open("status");
  const openPortSettings = (): void => options.openPortSettings();
  const openUpdateCheck = (): void => options.openUpdateCheck();
  // `openWindow()` is the tray's "Open Work Intelligence…" (the window asks main which tab); `openWindow("settings")` is an
  // explicit request, as a route inside main makes it. An id that is not a tab is ignored.
  const openWindow = (tab?: string): void => {
    if (tab === undefined) options.window.open();
    else if (isAppTab(tab)) options.window.open(tab);
  };
  // What the tray shows and what a click on an item does: the very list and handler the native menu uses.
  const trayMenu = (): readonly { id: string; label: string; enabled: boolean }[] =>
    options.tray.menu().map((item) => ({ id: item.id, label: item.label, enabled: item.enabled }));
  const trayClick = (id: string): void => options.tray.activate(id);
  // A real backend cannot be made to print chosen text, so the diagnostics test adds the lines it wants to see handled
  // (a token, another user's path, a line of work content) to what the supervisor reports as the child's recent output.
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
