import { decideSecondInstance, type BackendSupervisor } from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface SecondInstance {
  /** Called when another launch handed over to this instance: opens the Dashboard or the repair window. */
  handle(): void;
  readonly count: number;
  readonly lastDecision: string | null;
}

export interface SecondInstanceOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly supervisor: BackendSupervisor;
  readonly openDashboard: () => void;
}

export function createSecondInstance(options: SecondInstanceOptions): SecondInstance {
  let count = 0;
  let lastDecision: string | null = null;

  return {
    handle: () => {
      count += 1;
      const decision = decideSecondInstance({
        repairWindowOpen: options.window.isOpen(),
        owner: options.state.owner,
        backendRunning: options.supervisor.running !== undefined,
      });
      lastDecision = decision;
      if (decision === "open-dashboard") options.openDashboard();
      else options.window.open();
    },
    get count() {
      return count;
    },
    get lastDecision() {
      return lastDecision;
    },
  };
}
