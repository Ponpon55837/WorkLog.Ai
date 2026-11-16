import {
  createOperationRecord,
  OPERATION_JOURNAL_VERSION,
  withCompletedStep,
  withMigrationStarted,
  withPhase,
  withRepairOnly,
  withTerminalStatus,
  type JournalJson,
  type NewOperationInput,
  type OperationRecord,
} from "./journal-record.js";
import type { OperationJournalStore } from "./journal-store.js";
import type { RecoveryDecision } from "./recovery.js";
import type { ServiceOwnerState } from "./service-owner-state.js";

/** Raised when a journal method names an operation that was never begun. */
export class UnknownOperationError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`unknown operation ${operationId}`);
    this.name = "UnknownOperationError";
    this.operationId = operationId;
  }
}

const DEFAULT_MAX_TERMINAL_RECORDS = 64;

/**
 * Write-ahead journal over an injected store. Every mutation is copy-on-write, validated by the pure helpers in
 * `journal-record.ts`, and persisted before the method resolves, so a crash leaves either the old or the new record.
 * Mutations are serialized through one promise chain so concurrent callers cannot interleave load/save.
 */
export class OperationJournal {
  private readonly store: OperationJournalStore;
  private readonly clock: () => Date;
  private readonly maxTerminalRecords: number;
  private records: Map<string, OperationRecord> | null = null;
  private loading: Promise<Map<string, OperationRecord>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    store: OperationJournalStore,
    clock: () => Date = () => new Date(),
    maxTerminalRecords = DEFAULT_MAX_TERMINAL_RECORDS,
  ) {
    this.store = store;
    this.clock = clock;
    this.maxTerminalRecords = maxTerminalRecords;
  }

  /** Read one operation (loads the store on first use; a corrupt store throws, never reads as empty). */
  async get(operationId: string): Promise<OperationRecord | null> {
    return (await this.load()).get(operationId) ?? null;
  }

  /** The operation still marked in-progress, if any (what recovery looks at after a restart). */
  async findInProgress(): Promise<OperationRecord | null> {
    for (const record of (await this.load()).values()) if (record.status === "in-progress") return record;
    return null;
  }

  /** Start an operation; beginning an existing id returns the stored record unchanged (idempotent). */
  begin(input: NewOperationInput): Promise<OperationRecord> {
    return this.enqueue(async (records) => {
      const existing = records.get(input.operationId);
      if (existing) return existing;
      const created = createOperationRecord(input, this.now());
      records.set(created.operationId, created);
      try {
        await this.persist(records);
      } catch (error) {
        records.delete(created.operationId);
        throw error;
      }
      return created;
    });
  }

  /** Enter `to`; staying in the current phase is a no-op so replays do not fail on the table. */
  enterPhase(operationId: string, to: ServiceOwnerState): Promise<OperationRecord> {
    return this.update(operationId, (record) => (record.phase === to ? record : withPhase(record, to, this.now())));
  }

  /** Persist the result of a finished step; a repeated step keeps its first result. */
  completeStep(operationId: string, step: string, result: JournalJson = null): Promise<OperationRecord> {
    return this.update(operationId, (record) => withCompletedStep(record, step, result, this.now()));
  }

  /** `(operationId, step)` applied twice yields the same record and no second side effect. */
  advance(operationId: string, step: string, to: ServiceOwnerState): Promise<OperationRecord> {
    return this.update(operationId, (record) =>
      record.completedSteps.includes(step)
        ? record
        : withCompletedStep(withPhase(record, to, this.now()), step, null, this.now()),
    );
  }

  /** Monotonic: call before the first SQLite write that may migrate or restore. */
  markMigrationStarted(operationId: string): Promise<OperationRecord> {
    return this.update(operationId, (record) => withMigrationStarted(record, this.now()));
  }

  /** Close the operation; terminal records are immutable. */
  finish(
    operationId: string,
    status: "completed" | "cancelled" | "failed",
    detail: { result?: JournalJson; error?: string } = {},
  ): Promise<OperationRecord> {
    return this.update(operationId, (record) => withTerminalStatus(record, status, this.now(), detail));
  }

  /**
   * Persist a recovery decision: migration flag first (so restore edges close), then policy, then the phase.
   * Decisions that end the operation (restore/repair) also close it so a stale in-progress record cannot linger.
   */
  applyRecovery(operationId: string, decision: RecoveryDecision): Promise<OperationRecord> {
    return this.update(operationId, (record) => {
      let next = decision.migrationStarted ? withMigrationStarted(record, this.now()) : record;
      if (decision.recoveryPolicy === "repair-only") next = withRepairOnly(next, this.now());
      if (decision.nextState !== next.phase) next = withPhase(next, decision.nextState, this.now());
      if (decision.action === "restore-previous")
        return withTerminalStatus(next, "cancelled", this.now(), { error: decision.reason });
      if (decision.action === "repair")
        return withTerminalStatus(next, "failed", this.now(), { error: decision.reason });
      return next;
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private load(): Promise<Map<string, OperationRecord>> {
    if (this.records) return Promise.resolve(this.records);
    this.loading ??= this.store
      .load()
      .then((file) => {
        this.records = new Map((file?.records ?? []).map((record) => [record.operationId, record]));
        return this.records;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private update(operationId: string, change: (record: OperationRecord) => OperationRecord): Promise<OperationRecord> {
    return this.enqueue(async (records) => {
      const current = records.get(operationId);
      if (!current) throw new UnknownOperationError(operationId);
      const next = change(current);
      if (next !== current) {
        records.set(operationId, next);
        try {
          await this.persist(records);
        } catch (error) {
          records.set(operationId, current);
          throw error;
        }
      }
      return next;
    });
  }

  private enqueue<T>(work: (records: Map<string, OperationRecord>) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => work(await this.load()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(records: Map<string, OperationRecord>): Promise<void> {
    this.prune(records);
    await this.store.save({ journalVersion: OPERATION_JOURNAL_VERSION, records: [...records.values()] });
  }

  /** Keep every in-progress record and only the newest terminal ones, so the file stays small. */
  private prune(records: Map<string, OperationRecord>): void {
    const terminal = [...records.values()].filter((record) => record.status !== "in-progress");
    for (const old of terminal.slice(0, Math.max(0, terminal.length - this.maxTerminalRecords)))
      records.delete(old.operationId);
  }
}
