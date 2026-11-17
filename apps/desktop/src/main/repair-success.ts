import {
  celebrateRepair,
  recordRepairFailure,
  shouldCelebrateRepair,
  type BackendSupervisor,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { Dashboard } from "./dashboard.js";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface RepairSuccessOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly dashboard: Dashboard;
  readonly backend: BackendController;
  readonly supervisor: BackendSupervisor;
  /** The fail-open "ready again" notification. */
  readonly notifyRecovered: () => void;
  readonly delayMs: number;
}

export interface RepairSuccess {
  /** Dashboard opens so far; the repair IPC reads it before it starts the repair. */
  opens(): number;
  /**
   * The answer of a repair the user started in the repair window. Success: the feedback flow. A real failure: the page
   * shows only this error. A busy answer changes nothing.
   */
  finish(outcome: RestartOutcome, opensAtStart: number): void;
}

/** Thin Electron wiring of the decisions in desktop-core (`shouldCelebrateRepair`, `celebrateRepair`). */
export function createRepairSuccess(options: RepairSuccessOptions): RepairSuccess {
  const { state, window, dashboard, backend, supervisor } = options;

  function finish(outcome: RestartOutcome, opensAtStart: number): void {
    if (outcome.ok) {
      if (!shouldCelebrateRepair({ source: "user", ok: true, owner: state.owner, backend: state.backend })) return;
      const projectCount = supervisor.running?.projectCount;
      celebrateRepair(
        {
          errors: state.recentErrors,
          clearPresenter: () => backend.presenter().clear(),
          setRecovered: (recovered) => {
            state.recovered = recovered;
            state.touch();
          },
          notifyRecovered: options.notifyRecovered,
          schedule: (callback, ms) => void setTimeout(callback, ms),
          closeWindow: window.close,
          openDashboard: dashboard.open,
          dashboardOpens: dashboard.opens,
          delayMs: options.delayMs,
        },
        projectCount === undefined ? {} : { projectCount },
        opensAtStart,
      );
      return;
    }
    if (!outcome.busy) recordRepairFailure(state.recentErrors, outcome.code, new Date());
  }

  return { opens: dashboard.opens, finish };
}
