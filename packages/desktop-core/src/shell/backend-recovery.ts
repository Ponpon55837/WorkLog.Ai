import type { ErrorPresenter } from "./error-presentation.js";
import type { RecentErrors } from "./recent-errors.js";
import type { RestartPolicy } from "./restart-policy.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

/** `busy`: a restart or another operation is already running; nothing changed and nothing failed. */
export type RestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly busy?: false; readonly code: string }
  | { readonly ok: false; readonly busy: true };

export interface BackendRecoveryDeps {
  readonly policy: RestartPolicy;
  readonly presenter: ErrorPresenter;
  readonly errors: RecentErrors;
  /** Runs the restart operation (an ordinary managed start); `operationId` is the user's, absent for an automatic retry. */
  restart(operationId?: string): Promise<RestartOutcome>;
  /** False when a retry would be wrong now: an operation is running or a healthy backend already serves. */
  shouldAutoRetry(): boolean;
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The shell's owner state changed (for the tray and the repair page). */
  onOwnerChange(owner: ServiceOwnerState): void;
  log(line: string): void;
}

/**
 * What the shell does after the backend ends without being asked to (R4 section 6 point 4): record the error code, move to
 * NEEDS_REPAIR, show it the way the launch mode calls for, and retry on a bounded backoff unless the error is one a retry
 * cannot fix. The user's own retry is always possible and starts a fresh budget.
 */
export class BackendRecovery {
  private readonly deps: BackendRecoveryDeps;
  private timer: unknown;
  private running = false;

  constructor(deps: BackendRecoveryDeps) {
    this.deps = deps;
  }

  /** The backend ended unexpectedly, or a start failed, with `code`. */
  handleFailure(code: string): void {
    this.deps.errors.record(code, this.deps.now());
    this.deps.onOwnerChange("NEEDS_REPAIR");
    const decision = this.deps.policy.decide(code);
    if (!decision.retry) {
      this.deps.log(`[shell] no automatic retry after ${code} (${decision.reason})`);
      this.deps.presenter.present(code);
      return;
    }
    this.deps.log(`[shell] retry ${decision.attempt} after ${code} in ${decision.delayMs} ms`);
    this.schedule(decision.delayMs);
  }

  /**
   * The user pressed retry: cancel any pending automatic retry and run one now with a fresh budget. While a restart is
   * already running the answer is `busy` and the user's `operationId` is not kept for anything else.
   */
  async retryNow(operationId?: string): Promise<RestartOutcome> {
    if (this.running) return { ok: false, busy: true };
    this.cancel();
    this.deps.policy.reset();
    return this.attempt(false, operationId);
  }

  /** Cancels a pending automatic retry (the user is quitting, or a retry started by hand). */
  cancel(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Whether a restart is running right now. */
  get restarting(): boolean {
    return this.running;
  }

  private schedule(delayMs: number): void {
    this.cancel();
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.attempt(true).catch((error: unknown) => this.deps.log(`[shell] retry failed: ${describe(error)}`));
    }, delayMs);
  }

  private async attempt(automatic: boolean, operationId?: string): Promise<RestartOutcome> {
    if (this.running) return { ok: false, busy: true };
    if (automatic && !this.deps.shouldAutoRetry()) {
      this.deps.log("[shell] automatic retry skipped: an operation runs or the backend already serves");
      return { ok: false, busy: true };
    }
    this.running = true;
    try {
      const outcome = await this.restartSafely(operationId);
      if (outcome.ok) {
        this.deps.presenter.clear();
        this.deps.onOwnerChange("MANAGED");
      } else if (outcome.busy) {
        this.deps.log("[shell] restart not run: another operation holds the lock");
      } else if (automatic) {
        this.handleFailure(outcome.code);
      } else {
        this.deps.errors.record(outcome.code, this.deps.now());
        this.deps.onOwnerChange("NEEDS_REPAIR");
        this.deps.presenter.present(outcome.code);
      }
      return outcome;
    } finally {
      this.running = false;
    }
  }

  /** A restart that throws is a failed restart with the generic repair code, never an unhandled rejection. */
  private async restartSafely(operationId: string | undefined): Promise<RestartOutcome> {
    try {
      return await this.deps.restart(operationId);
    } catch (error) {
      this.deps.log(`[shell] restart threw: ${describe(error)}`);
      return { ok: false, code: "REPAIR_REQUIRED" };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
