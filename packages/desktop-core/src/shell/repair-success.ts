import type { BackendRunState, RepairRecovered } from "./repair-state.js";
import type { RecentErrors } from "./recent-errors.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export type RepairSource = "user" | "automatic" | "startup";

export interface RepairOutcomeFacts {
  readonly source: RepairSource;
  readonly ok: boolean;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
}

export interface RepairSuccessDeps {
  readonly errors: RecentErrors;
  clearPresenter(): void;
  setRecovered(recovered: RepairRecovered | null): void;
  notifyRecovered(): void;
  schedule(callback: () => void, ms: number): void;
  closeWindow(): void;
  openDashboard(): void;
  dashboardOpens(): number;
  readonly delayMs: number;
}

export class DashboardOpenCounter {
  private opened = 0;

  get count(): number {
    return this.opened;
  }

  mark(): void {
    this.opened += 1;
  }
}

export function shouldCelebrateRepair(facts: RepairOutcomeFacts): boolean {
  return facts.source === "user" && facts.ok && facts.owner === "MANAGED" && facts.backend === "running";
}

export function shouldOpenDashboardAfterRepair(opensAtStart: number, opensNow: number): boolean {
  return opensNow <= opensAtStart;
}

export function recordRepairFailure(errors: RecentErrors, code: string, at: Date): void {
  errors.replaceWith(code, at);
}

export function celebrateRepair(deps: RepairSuccessDeps, recovered: RepairRecovered, opensAtStart: number): void {
  deps.errors.clear();
  deps.clearPresenter();
  deps.setRecovered(recovered);
  try {
    deps.notifyRecovered();
  } catch {
    // A system without notifications must not turn a repair that worked into an error.
  }
  deps.schedule(() => {
    deps.setRecovered(null);
    deps.closeWindow();
    if (shouldOpenDashboardAfterRepair(opensAtStart, deps.dashboardOpens())) deps.openDashboard();
  }, deps.delayMs);
}
