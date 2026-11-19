import { z } from "zod";
import { databaseIdentitySchema, type DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import { assertTransition, SERVICE_OWNER_STATES, type ServiceOwnerState } from "./service-owner-state.js";

/** Version of the persisted journal document; bump when the shape changes incompatibly. */
export const OPERATION_JOURNAL_VERSION = 1;

/** Operation kinds that move or touch the service owner. */
export const OPERATION_KINDS = [
  "takeover",
  "change-port",
  "change-db",
  "apply-agent",
  "restart",
  "restore",
  "maintenance",
  "legacy-disable",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** `restore-previous` may hand the old service back; `repair-only` never may (ADR-22). */
export type RecoveryPolicy = "restore-previous" | "repair-only";

/** JSON-safe value; the journal must never hold secrets, so callers pass only descriptive data. */
export type JournalJson = string | number | boolean | null | JournalJson[] | { [key: string]: JournalJson };

const jsonSchema = z.json() as z.ZodType<JournalJson>;

const stateSchema = z.enum(SERVICE_OWNER_STATES);
const jsonRecordSchema = z.record(z.string(), jsonSchema);

/**
 * What a startup recovery tells the user about an operation it found interrupted. The kinds are facts about the real
 * state it verified, not about the journal; the page words each of them (what happened, what the user can do).
 */
export const RECOVERY_NOTICE_KINDS = [
  "port-kept",
  "port-applied",
  "db-kept",
  "db-applied",
  "copy-removed",
  "legacy-present",
  "legacy-disabled",
  "agent-interrupted",
  "needs-repair",
  /** The journal file itself could not be read and was set aside: what an earlier operation did is unknown. */
  "journal-unreadable",
] as const;
export type RecoveryNoticeKind = (typeof RECOVERY_NOTICE_KINDS)[number];

/** Persisted notice: descriptive and non-secret (a port number at most), acknowledged by the user once. */
export const recoveryNoticeSchema = z.strictObject({
  kind: z.enum(RECOVERY_NOTICE_KINDS),
  /** The operation that was interrupted; the page maps it to the tab where the user can act. */
  operation: z.enum(OPERATION_KINDS),
  /** The port the App uses now (port notices only). */
  port: z.number().int().nullable(),
  /** The port the interrupted change was moving to (port notices only). */
  attemptedPort: z.number().int().nullable(),
  acknowledged: z.boolean(),
});
export type RecoveryNotice = z.infer<typeof recoveryNoticeSchema>;

/** Zod schema of one persisted operation (R4 §4.1 fields plus replay bookkeeping). */
export const operationRecordSchema = z.strictObject({
  operationId: z.string().min(1),
  kind: z.enum(OPERATION_KINDS),
  phase: stateSchema,
  previousOwner: stateSchema,
  selectedDb: databaseIdentitySchema.nullable(),
  oldServiceDefinition: jsonRecordSchema.nullable(),
  oldEnabledState: z.boolean().nullable(),
  oldRunningState: z.boolean().nullable(),
  lastKnownGood: jsonSchema.nullable(),
  migrationStarted: z.boolean(),
  recoveryPolicy: z.enum(["restore-previous", "repair-only"]),
  /** DB schema version observed when the operation began; later probes compare against it. */
  schemaVersionAtStart: z.number().int().nonnegative().nullable(),
  /**
   * `interrupted`: recovery found the real state consistent and closed the operation without finishing its steps.
   * `in-progress` + `cancelRequested`: a cancel arrived after side effects, so only recovery may close it.
   */
  status: z.enum(["in-progress", "completed", "cancelled", "failed", "interrupted"]),
  /** Descriptive, non-secret facts of the operation (a port change records `{ from, to }`); absent in older journals. */
  details: jsonRecordSchema.nullable().default(null),
  /** What startup recovery told the user about this operation; null when it was not interrupted or needs no notice. */
  recoveryNotice: recoveryNoticeSchema.nullable().default(null),
  /** Persisted cancel request; defaults to false so journals written before this field still load (version 1). */
  cancelRequested: z.boolean().default(false),
  completedSteps: z.array(z.string()),
  stepResults: z.record(z.string(), jsonSchema),
  result: jsonSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Zod schema of the whole journal file. */
export const operationJournalFileSchema = z.strictObject({
  journalVersion: z.literal(OPERATION_JOURNAL_VERSION),
  records: z.array(operationRecordSchema),
});

export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type OperationJournalFile = z.infer<typeof operationJournalFileSchema>;

/** Inputs for a new operation record. */
export interface NewOperationInput {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly previousOwner: ServiceOwnerState;
  readonly selectedDb?: DatabaseIdentityRecord | null;
  readonly oldServiceDefinition?: Readonly<Record<string, JournalJson>> | null;
  readonly oldEnabledState?: boolean | null;
  readonly oldRunningState?: boolean | null;
  readonly lastKnownGood?: JournalJson | null;
  readonly details?: Readonly<Record<string, JournalJson>> | null;
  readonly schemaVersionAtStart?: number | null;
  readonly migrationStarted?: boolean;
}

/** Create the initial record; phase starts at the previous owner so the first transition is validated. */
export function createOperationRecord(input: NewOperationInput, now: string): OperationRecord {
  const migrationStarted = input.migrationStarted ?? false;
  return {
    operationId: input.operationId,
    kind: input.kind,
    phase: input.previousOwner,
    previousOwner: input.previousOwner,
    selectedDb: input.selectedDb ?? null,
    oldServiceDefinition: (input.oldServiceDefinition as Record<string, JournalJson> | null | undefined) ?? null,
    oldEnabledState: input.oldEnabledState ?? null,
    oldRunningState: input.oldRunningState ?? null,
    lastKnownGood: input.lastKnownGood ?? null,
    migrationStarted,
    recoveryPolicy: migrationStarted ? "repair-only" : "restore-previous",
    schemaVersionAtStart: input.schemaVersionAtStart ?? null,
    status: "in-progress",
    details: (input.details as Record<string, JournalJson> | null | undefined) ?? null,
    recoveryNotice: null,
    cancelRequested: false,
    completedSteps: [],
    stepResults: {},
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Move to `to` after validating the table and the migration guard. Same-phase is not a transition. */
export function withPhase(record: OperationRecord, to: ServiceOwnerState, now: string): OperationRecord {
  assertTransition(record.phase, to, record.migrationStarted);
  return { ...record, phase: to, updatedAt: now };
}

/**
 * Set the monotonic migration flag. Once true it stays true and the policy is forced to repair-only,
 * because the old program must never reopen a possibly upgraded DB (ADR-22).
 */
export function withMigrationStarted(record: OperationRecord, now: string): OperationRecord {
  if (record.migrationStarted && record.recoveryPolicy === "repair-only") return record;
  return { ...record, migrationStarted: true, recoveryPolicy: "repair-only", updatedAt: now };
}

/** Force repair-only (identity uncertain) without claiming a migration happened. */
export function withRepairOnly(record: OperationRecord, now: string): OperationRecord {
  return record.recoveryPolicy === "repair-only"
    ? record
    : { ...record, recoveryPolicy: "repair-only", updatedAt: now };
}

/** Record a finished step and its JSON result; repeating a step name keeps the first result (idempotent replay). */
export function withCompletedStep(
  record: OperationRecord,
  step: string,
  result: JournalJson,
  now: string,
): OperationRecord {
  if (record.completedSteps.includes(step)) return record;
  return {
    ...record,
    completedSteps: [...record.completedSteps, step],
    stepResults: { ...record.stepResults, [step]: result },
    updatedAt: now,
  };
}

/** Persist a cancel request on a still-open operation; recovery, not the coordinator, then decides restore vs repair. */
export function withCancelRequested(record: OperationRecord, now: string): OperationRecord {
  if (record.status !== "in-progress" || record.cancelRequested) return record;
  return { ...record, cancelRequested: true, updatedAt: now };
}

/** True while no phase change, migration or finished step could have had a side effect (safe to just cancel). */
export function isPristine(record: OperationRecord): boolean {
  return record.phase === record.previousOwner && !record.migrationStarted && record.completedSteps.length === 0;
}

/** Close an operation; terminal records never change again. */
export function withTerminalStatus(
  record: OperationRecord,
  status: "completed" | "cancelled" | "failed" | "interrupted",
  now: string,
  detail: { readonly result?: JournalJson; readonly error?: string } = {},
): OperationRecord {
  if (record.status !== "in-progress") return record;
  return { ...record, status, result: detail.result ?? null, error: detail.error ?? null, updatedAt: now };
}

/** Attach the notice recovery decided on; it starts unacknowledged. */
export function withRecoveryNotice(
  record: OperationRecord,
  notice: Omit<RecoveryNotice, "acknowledged">,
  now: string,
): OperationRecord {
  return { ...record, recoveryNotice: { ...notice, acknowledged: false }, updatedAt: now };
}

/** The user dismissed the notice; a record without one, or already acknowledged, stays as it is. */
export function withNoticeAcknowledged(record: OperationRecord, now: string): OperationRecord {
  if (!record.recoveryNotice || record.recoveryNotice.acknowledged) return record;
  return { ...record, recoveryNotice: { ...record.recoveryNotice, acknowledged: true }, updatedAt: now };
}
