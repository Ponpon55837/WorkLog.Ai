import type { ErrorPresenter } from "./error-presentation.js";
import type { RecentErrors } from "./recent-errors.js";
import type { RestartPolicy } from "./restart-policy.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

export type RestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly busy?: false; readonly code: string }
  | { readonly ok: false; readonly busy: true };

export interface BackendRecoveryDeps {
  readonly policy: RestartPolicy;
  readonly presenter: ErrorPresenter;
  readonly errors: RecentErrors;
  restart(operationId?: string): Promise<RestartOutcome>;
  isServing?(): boolean;
  shouldAutoRetry(): boolean;
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onOwnerChange(owner: ServiceOwnerState): void;
  log(line: string): void;
}

const BUSY_DEFER_MS = 3_000;
const MAX_BUSY_DEFERRALS = 20;

export class BackendRecovery {
  private readonly deps: BackendRecoveryDeps;
  private timer: unknown;
  private running = false;
  private lastCode = "";
  private busyDeferrals = 0;

  constructor(deps: BackendRecoveryDeps) {
    this.deps = deps;
  }

  handleFailure(code: string): void {
    this.lastCode = code;
    this.busyDeferrals = 0;
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

  async retryNow(operationId?: string): Promise<RestartOutcome> {
    if (this.running) return { ok: false, busy: true };
    this.cancel();
    this.deps.policy.reset();
    return this.attempt(false, operationId);
  }

  cancel(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

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
      this.deferWhileBusy();
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
        if (automatic) this.deferWhileBusy();
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

  private deferWhileBusy(): void {
    if (this.deps.isServing?.()) return;
    if (this.busyDeferrals >= MAX_BUSY_DEFERRALS) {
      this.deps.log(`[shell] automatic retry gave up waiting for the lock after ${this.lastCode}`);
      this.deps.presenter.present(this.lastCode);
      return;
    }
    this.busyDeferrals += 1;
    this.schedule(BUSY_DEFER_MS);
  }

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
