import {
  createOperationRecord,
  OPERATION_JOURNAL_VERSION,
  withCancelRequested,
  withCompletedStep,
  withMigrationStarted,
  withNoticeAcknowledged,
  withPhase,
  withRecoveryNotice,
  withRepairOnly,
  withTerminalStatus,
  type JournalJson,
  type NewOperationInput,
  type OperationRecord,
  type RecoveryNotice,
} from "./journal-record.js";
import type { OperationJournalStore } from "./journal-store.js";
import type { RecoveryDecision } from "./recovery.js";
import type { ServiceOwnerState } from "./service-owner-state.js";

export class UnknownOperationError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`unknown operation ${operationId}`);
    this.name = "UnknownOperationError";
    this.operationId = operationId;
  }
}

const DEFAULT_MAX_TERMINAL_RECORDS = 64;

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

  async pendingNotices(): Promise<OperationRecord[]> {
    return [...(await this.load()).values()]
      .filter((record) => record.recoveryNotice !== null && !record.recoveryNotice.acknowledged)
      .reverse();
  }

  async acknowledgeNotice(operationId: string): Promise<boolean> {
    const before = await this.get(operationId);
    if (!before?.recoveryNotice || before.recoveryNotice.acknowledged) return false;
    await this.update(operationId, (record) => withNoticeAcknowledged(record, this.now()));
    return true;
  }

  async get(operationId: string): Promise<OperationRecord | null> {
    return (await this.load()).get(operationId) ?? null;
  }

  async findInProgress(): Promise<OperationRecord | null> {
    for (const record of (await this.load()).values()) if (record.status === "in-progress") return record;
    return null;
  }

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

  enterPhase(operationId: string, to: ServiceOwnerState): Promise<OperationRecord> {
    return this.update(operationId, (record) => (record.phase === to ? record : withPhase(record, to, this.now())));
  }

  completeStep(operationId: string, step: string, result: JournalJson = null): Promise<OperationRecord> {
    return this.update(operationId, (record) => withCompletedStep(record, step, result, this.now()));
  }

  markMigrationStarted(operationId: string): Promise<OperationRecord> {
    return this.update(operationId, (record) => withMigrationStarted(record, this.now()));
  }

  requestCancel(operationId: string): Promise<OperationRecord> {
    return this.update(operationId, (record) => withCancelRequested(record, this.now()));
  }

  finish(
    operationId: string,
    status: "completed" | "cancelled" | "failed" | "interrupted",
    detail: { result?: JournalJson; error?: string } = {},
  ): Promise<OperationRecord> {
    return this.update(operationId, (record) => withTerminalStatus(record, status, this.now(), detail));
  }

  applyRecovery(
    operationId: string,
    decision: RecoveryDecision,
    notice?: Omit<RecoveryNotice, "acknowledged">,
  ): Promise<OperationRecord> {
    return this.update(operationId, (stored) => {
      const record = notice ? withRecoveryNotice(stored, notice, this.now()) : stored;
      let next = decision.migrationStarted ? withMigrationStarted(record, this.now()) : record;
      if (decision.recoveryPolicy === "repair-only") next = withRepairOnly(next, this.now());
      if (decision.nextState !== next.phase) next = withPhase(next, decision.nextState, this.now());
      if (decision.action === "restore-previous")
        return withTerminalStatus(next, "cancelled", this.now(), { error: decision.reason });
      if (decision.action === "repair")
        return withTerminalStatus(next, "failed", this.now(), { error: decision.reason });
      if (decision.action === "none") {
        const recovered = { recoveredState: decision.nextState, reason: decision.reason };
        return withTerminalStatus(next, "interrupted", this.now(), { result: recovered });
      }
      return next;
    });
  }

  recordUnreadableJournal(): Promise<OperationRecord> {
    return this.enqueue(async (records) => {
      const now = this.now();
      const created = createOperationRecord(
        { operationId: `journal-unreadable-${now}`, kind: "restart", previousOwner: "UNCONFIGURED" },
        now,
      );
      const closed = withTerminalStatus(
        withRecoveryNotice(
          created,
          { kind: "journal-unreadable", operation: "restart", port: null, attemptedPort: null },
          now,
        ),
        "failed",
        now,
        { error: "the operations journal could not be read and was set aside" },
      );
      records.set(closed.operationId, closed);
      try {
        await this.persist(records);
      } catch (error) {
        records.delete(closed.operationId);
        throw error;
      }
      return closed;
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

  private prune(records: Map<string, OperationRecord>): void {
    const terminal = [...records.values()].filter((record) => record.status !== "in-progress");
    for (const old of terminal.slice(0, Math.max(0, terminal.length - this.maxTerminalRecords)))
      records.delete(old.operationId);
  }
}
