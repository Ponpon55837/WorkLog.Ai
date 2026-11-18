import { app } from "electron";
import type { BackendSupervisor, ServiceOwnerState } from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Dashboard } from "./dashboard.js";
import type { RepairWindow } from "./repair-window.js";
import type { SecondInstance } from "./second-instance.js";
import type { ShellState } from "./state.js";

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
  /** The page the App window shows (or would show when it opens). */
  readonly view: string;
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
      view: options.state.view,
      firstRunDetectionMs: options.firstRunDetectionMs() ?? null,
    };
  };
  // The tray cannot be clicked in a test: the repair window as the tray's 「開啟修復視窗」 shows it, and the port section
  // through the very handler the 「變更連接埠…」 item runs, and the update check through the one 「檢查更新…」 runs.
  const openRepair = (): void => options.window.open("repair");
  const openPortSettings = (): void => options.openPortSettings();
  const openUpdateCheck = (): void => options.openUpdateCheck();
  Object.defineProperty(globalThis, "__workIntelligenceDesktopTest", {
    value: Object.freeze({ snapshot: read, openRepair, openPortSettings, openUpdateCheck }),
  });
}
