import {
  isPristine,
  type JournalJson,
  type NewOperationInput,
  type OperationKind,
  type OperationRecord,
} from "./journal-record.js";
import type { OperationJournal } from "./operation-journal.js";
import type { ServiceOwnerState } from "./service-owner-state.js";

export type OperationRequest = NewOperationInput;

export interface OperationStepContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  markMigrationStarted(): Promise<void>;
}

/**
 * `run` must be safe to repeat (a crash before its journal write replays it); SQLite writes and installer handoff are
 * not cancellable.
 */
export interface OperationStep {
  readonly name: string;
  readonly phase?: ServiceOwnerState;
  readonly cancellable: boolean;
  run(context: OperationStepContext): Promise<JournalJson | void>;
}

export interface BusyOperationInfo {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly phase: ServiceOwnerState;
  readonly cancellable: boolean;
}

export type OperationRunResult =
  | { readonly status: "completed"; readonly result: JournalJson }
  | { readonly status: "busy"; readonly current: BusyOperationInfo }
  /**
   * `recoveryRequired`: the cancel came after side effects (or the id was resubmitted after such a cancel), so the
   * record stays in-progress with `cancelRequested` and startup recovery must decide restore vs repair.
   */
  | { readonly status: "cancelled"; readonly recoveryRequired?: true }
  | { readonly status: "interrupted"; readonly recoveredState: ServiceOwnerState; readonly reason: string }
  | { readonly status: "failed"; readonly error: string };

export type CancelResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "non-cancellable-phase" | "unknown-operation" };

interface ActiveRun {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly controller: AbortController;
  phase: ServiceOwnerState;
  cancellable: boolean;
  cancelRequested: boolean;
  promise: Promise<OperationRunResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storedResult(record: OperationRecord): OperationRunResult | null {
  if (record.status === "completed") return { status: "completed", result: record.result };
  if (record.status === "cancelled") return { status: "cancelled" };
  if (record.status === "failed") return { status: "failed", error: record.error ?? "operation failed" };
  if (record.status === "interrupted") {
    const recovered = record.result as { recoveredState?: ServiceOwnerState; reason?: string } | null;
    return {
      status: "interrupted",
      recoveredState: recovered?.recoveredState ?? record.phase,
      reason: recovered?.reason ?? "recovered",
    };
  }
  // A persisted cancel after side effects must never silently resume steps: only recovery may close it.
  if (record.cancelRequested) return { status: "cancelled", recoveryRequired: true };
  return null;
}

export class OperationCoordinator {
  private readonly journal: OperationJournal;
  private readonly active = new Map<string, ActiveRun>();

  constructor(journal: OperationJournal) {
    this.journal = journal;
  }

  run(request: OperationRequest, steps: readonly OperationStep[]): Promise<OperationRunResult> {
    const existing = this.active.get(request.operationId);
    if (existing) return existing.promise;
    if (this.currentRun()) return this.resolveWhileBusy(request, steps);
    // Take the lock synchronously: nothing may await between the check above and this registration.
    const run: ActiveRun = {
      operationId: request.operationId,
      kind: request.kind,
      controller: new AbortController(),
      phase: request.previousOwner,
      cancellable: true,
      cancelRequested: false,
      promise: Promise.resolve({ status: "cancelled" }),
    };
    this.active.set(run.operationId, run);
    run.promise = this.execute(run, request, steps).finally(() => {
      this.active.delete(run.operationId);
    });
    return run.promise;
  }

  cancel(operationId: string): CancelResult {
    const run = this.active.get(operationId);
    if (!run) return { accepted: false, reason: "unknown-operation" };
    if (!run.cancellable) return { accepted: false, reason: "non-cancellable-phase" };
    run.cancelRequested = true;
    run.controller.abort();
    return { accepted: true };
  }

  current(): BusyOperationInfo | null {
    const run = this.currentRun();
    return run ? this.info(run) : null;
  }

  private currentRun(): ActiveRun | null {
    for (const run of this.active.values()) return run;
    return null;
  }

  private info(run: ActiveRun): BusyOperationInfo {
    return { operationId: run.operationId, kind: run.kind, phase: run.phase, cancellable: run.cancellable };
  }

  private async resolveWhileBusy(
    request: OperationRequest,
    steps: readonly OperationStep[],
  ): Promise<OperationRunResult> {
    const stored = await this.journal.get(request.operationId).catch(() => null);
    const terminal = stored ? storedResult(stored) : null;
    if (terminal) return terminal;
    const now = this.currentRun();
    if (now) return { status: "busy", current: this.info(now) };
    return this.run(request, steps);
  }

  private async execute(
    run: ActiveRun,
    request: OperationRequest,
    steps: readonly OperationStep[],
  ): Promise<OperationRunResult> {
    try {
      const record = await this.journal.begin(request);
      const done = storedResult(record);
      if (done) return done;
      run.phase = record.phase;
      return await this.runSteps(run, steps);
    } catch (error) {
      return this.fail(run, error);
    }
  }

  private async runSteps(run: ActiveRun, steps: readonly OperationStep[]): Promise<OperationRunResult> {
    const { operationId } = run;
    const context: OperationStepContext = {
      operationId,
      signal: run.controller.signal,
      markMigrationStarted: async () => {
        await this.journal.markMigrationStarted(operationId);
      },
    };
    let last: JournalJson = null;
    for (const step of steps) {
      if (run.cancelRequested) return this.cancelled(operationId);
      const done = (await this.journal.get(operationId))?.stepResults[step.name];
      if (done !== undefined) {
        last = done;
        continue;
      }
      run.cancellable = step.cancellable;
      if (step.phase) run.phase = (await this.journal.enterPhase(operationId, step.phase)).phase;
      try {
        last = (await step.run(context)) ?? null;
      } catch (error) {
        if (run.cancelRequested) return this.cancelled(operationId);
        throw error;
      }
      await this.journal.completeStep(operationId, step.name, last);
    }
    run.cancellable = false;
    await this.journal.finish(operationId, "completed", { result: last });
    return { status: "completed", result: last };
  }

  private async cancelled(operationId: string): Promise<OperationRunResult> {
    const record = await this.journal.get(operationId);
    if (record && !isPristine(record)) {
      await this.journal.requestCancel(operationId);
      return { status: "cancelled", recoveryRequired: true };
    }
    await this.journal.finish(operationId, "cancelled");
    return { status: "cancelled" };
  }

  private async fail(run: ActiveRun, error: unknown): Promise<OperationRunResult> {
    const message = errorMessage(error);
    try {
      const record = await this.journal.get(run.operationId);
      if (record && record.phase !== record.previousOwner && record.phase !== "NEEDS_REPAIR") {
        await this.journal.enterPhase(run.operationId, "NEEDS_REPAIR");
      }
      if (record) await this.journal.finish(run.operationId, "failed", { error: message });
    } catch {
      // The journal itself is failing: report the original error; the next start recovers from real state.
    }
    return { status: "failed", error: message };
  }
}
