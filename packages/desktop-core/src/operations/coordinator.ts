import type { JournalJson, NewOperationInput, OperationKind, OperationRecord } from "./journal-record.js";
import type { OperationJournal } from "./operation-journal.js";
import type { ServiceOwnerState } from "./service-owner-state.js";

/** Everything the journal needs to begin an operation. */
export type OperationRequest = NewOperationInput;

/** Passed to each step so it can honour cancellation and flag the point of no return. */
export interface OperationStepContext {
  readonly operationId: string;
  /** Aborted when `cancel()` was accepted during a cancellable step. */
  readonly signal: AbortSignal;
  /** Persist `migrationStarted` BEFORE the first write that may migrate or restore the DB. */
  markMigrationStarted(): Promise<void>;
}

/**
 * One unit of an operation. `phase` (optional) is the ServiceOwner state entered before the step runs;
 * `cancellable` declares whether `cancel()` may take effect while it runs (SQLite writes and installer
 * handoff must be `false`: they are never killed). Step names must be unique within an operation and
 * `run` must be safe to repeat, because a crash between `run` and its journal write replays it.
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
  | { readonly status: "cancelled" }
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
  return null;
}

/**
 * Serializes ServiceOwner operations behind ONE in-process lock (one desktop main process per user).
 * Cross-process exclusion (second app instance, CLI) is the single-instance file lock of DT-15 and is NOT done here.
 *
 * Contract: a different operationId while one runs gets `busy`; the same id returns the in-flight promise, or the
 * stored terminal result (also after a restart, because results come from the journal). An id that is still
 * `in-progress` in the journal but not running (crash) is resumed: steps already journaled are skipped.
 * Cancellation takes effect only at step boundaries and only when the running step is cancellable; the coordinator
 * does not roll back side effects, `recover(probe)` decides that from real state.
 */
export class OperationCoordinator {
  private readonly journal: OperationJournal;
  /** operationId -> run; holds at most one entry (the lock) but keeps O(1) lookup by id. */
  private readonly active = new Map<string, ActiveRun>();

  constructor(journal: OperationJournal) {
    this.journal = journal;
  }

  /** Run `steps` under the lock. See the class comment for the result semantics. */
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

  /** Ask a running operation to stop at its next step boundary. Never interrupts a non-cancellable phase. */
  cancel(operationId: string): CancelResult {
    const run = this.active.get(operationId);
    if (!run) return { accepted: false, reason: "unknown-operation" };
    if (!run.cancellable) return { accepted: false, reason: "non-cancellable-phase" };
    run.cancelRequested = true;
    run.controller.abort();
    return { accepted: true };
  }

  /** Snapshot of the lock holder, or null when idle. */
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

  /** A different id while busy: a finished earlier id still answers from the journal, everything else is busy. */
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
    if (run.cancelRequested) return this.cancelled(operationId);
    await this.journal.finish(operationId, "completed", { result: last });
    return { status: "completed", result: last };
  }

  private async cancelled(operationId: string): Promise<OperationRunResult> {
    await this.journal.finish(operationId, "cancelled");
    return { status: "cancelled" };
  }

  /** A failed operation that already moved the owner state must end in NEEDS_REPAIR (fail closed). */
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
