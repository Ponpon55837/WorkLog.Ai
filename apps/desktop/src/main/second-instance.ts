import {
  decideSecondInstance,
  type BackendSupervisor,
  type SecondInstanceRequest,
} from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface SecondInstance {
  handle(request: SecondInstanceRequest): void;
  readonly count: number;
  readonly lastDecision: string | null;
}

export interface SecondInstanceOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly supervisor: BackendSupervisor;
  readonly openDashboard: () => void;
  readonly starting: () => boolean;
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
