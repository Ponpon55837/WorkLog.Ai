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
  readonly logFile: string;
}

export interface TestHookOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly window: RepairWindow;
  readonly secondInstance: SecondInstance;
  readonly dashboard: Dashboard;
}

/** `globalThis.__workIntelligenceDesktopTest.snapshot()` for the smoke tests; never installed in a packaged App. */
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
      logFile: options.paths.logFile,
    };
  };
  Object.defineProperty(globalThis, "__workIntelligenceDesktopTest", { value: Object.freeze({ snapshot: read }) });
}
