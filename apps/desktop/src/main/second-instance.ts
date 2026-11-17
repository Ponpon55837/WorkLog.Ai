import {
  decideSecondInstance,
  type BackendSupervisor,
  type SecondInstanceRequest,
} from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface SecondInstance {
  /**
   * Called when another launch handed over to this instance: opens the Dashboard or the repair window. An
   * `--open-dashboard` request that arrives before the first start finished is kept until it has (see `deferDashboard`).
   */
  handle(request: SecondInstanceRequest): void;
  readonly count: number;
  readonly lastDecision: string | null;
}

export interface SecondInstanceOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly supervisor: BackendSupervisor;
  readonly openDashboard: () => void;
  /** The first start has not finished: the owner and the backend are not settled yet. */
  readonly starting: () => boolean;
  /** Remembers that the Dashboard was asked for; the first start opens it once the backend is ready. */
  readonly deferDashboard: () => void;
}

export function createSecondInstance(options: SecondInstanceOptions): SecondInstance {
  let count = 0;
  let lastDecision: string | null = null;

  return {
    handle: (request) => {
      count += 1;
      const decision = decideSecondInstance({
        repairWindowOpen: options.window.isOpen(),
        owner: options.state.owner,
        backendRunning: options.supervisor.running !== undefined,
        request,
        starting: options.starting(),
      });
      lastDecision = decision;
      if (decision === "open-dashboard") options.openDashboard();
      else if (decision === "defer-dashboard") options.deferDashboard();
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
