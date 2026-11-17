import type { BackendRunState, RepairRecovered } from "./repair-state.js";
import type { RecentErrors } from "./recent-errors.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

/** Who asked for the start that just ended: only a person pressing a button in the repair window is `user`. */
export type RepairSource = "user" | "automatic" | "startup";

export interface RepairOutcomeFacts {
  readonly source: RepairSource;
  readonly ok: boolean;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
}

export interface RepairSuccessDeps {
  readonly errors: RecentErrors;
  /** The error presenter's `clear()` (tray attention off, notified codes forgotten). */
  clearPresenter(): void;
  /** Stores what the page renders as its success card (`null` removes it). */
  setRecovered(recovered: RepairRecovered | null): void;
  /** One system notification; the implementation is fail-open. */
  notifyRecovered(): void;
  /** Runs `callback` after `ms`. */
  schedule(callback: () => void, ms: number): void;
  closeWindow(): void;
  openDashboard(): void;
  /** How many times the Dashboard has been opened so far. */
  dashboardOpens(): number;
  /** Pause that keeps the success card visible before the window closes. */
  readonly delayMs: number;
}

/** Counts every Dashboard open, so a flow can tell whether another request already opened it. */
export class DashboardOpenCounter {
  private opened = 0;

  get count(): number {
    return this.opened;
  }

  mark(): void {
    this.opened += 1;
  }
}

/**
 * Whether the shell tells the user "it works again": only for a repair the user started that ended with a running,
 * managed backend. Never for a login (`--background`) start, an automatic retry or a normal start.
 */
export function shouldCelebrateRepair(facts: RepairOutcomeFacts): boolean {
  return facts.source === "user" && facts.ok && facts.owner === "MANAGED" && facts.backend === "running";
}

/**
 * The Dashboard opens after a repair only when nothing opened it since the repair began (a pending `--open-dashboard`
 * request opens it as soon as the owner is MANAGED again, which can be before the success card is shown).
 */
export function shouldOpenDashboardAfterRepair(opensAtStart: number, opensNow: number): boolean {
  return opensNow <= opensAtStart;
}

/** A failed user repair shows only the current error: older ones are not mixed in. */
export function recordRepairFailure(errors: RecentErrors, code: string, at: Date): void {
  errors.replaceWith(code, at);
}

/**
 * The success feedback after a user-started repair: clear stale errors, show the success card, notify, then after a short
 * pause close the repair window and open the Dashboard once. `opensAtStart` is `dashboardOpens()` before the repair began.
 */
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
