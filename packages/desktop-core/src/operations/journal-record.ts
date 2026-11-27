import { z } from "zod";
import { databaseIdentitySchema, type DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import { assertTransition, SERVICE_OWNER_STATES, type ServiceOwnerState } from "./service-owner-state.js";

/** Version of the persisted journal document; bump when the shape changes incompatibly. */
export const OPERATION_JOURNAL_VERSION = 1;

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

export type RecoveryPolicy = "restore-previous" | "repair-only";

/** JSON-safe value; the journal must never hold secrets, so callers pass only descriptive data. */
export type JournalJson = string | number | boolean | null | JournalJson[] | { [key: string]: JournalJson };

const jsonSchema = z.json() as z.ZodType<JournalJson>;

const stateSchema = z.enum(SERVICE_OWNER_STATES);
const jsonRecordSchema = z.record(z.string(), jsonSchema);

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
  "journal-unreadable",
] as const;
export type RecoveryNoticeKind = (typeof RECOVERY_NOTICE_KINDS)[number];

export const recoveryNoticeSchema = z.strictObject({
  kind: z.enum(RECOVERY_NOTICE_KINDS),
  operation: z.enum(OPERATION_KINDS),
  port: z.number().int().nullable(),
  attemptedPort: z.number().int().nullable(),
  acknowledged: z.boolean(),
});
export type RecoveryNotice = z.infer<typeof recoveryNoticeSchema>;

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
  schemaVersionAtStart: z.number().int().nonnegative().nullable(),
  /**
   * `interrupted`: recovery found the real state consistent and closed the operation without finishing its steps.
   * `in-progress` + `cancelRequested`: a cancel arrived after side effects, so only recovery may close it.
   */
  status: z.enum(["in-progress", "completed", "cancelled", "failed", "interrupted"]),
  details: jsonRecordSchema.nullable().default(null),
  recoveryNotice: recoveryNoticeSchema.nullable().default(null),
  /** Defaults to false so journals written before this field still load (version 1). */
  cancelRequested: z.boolean().default(false),
  completedSteps: z.array(z.string()),
  stepResults: z.record(z.string(), jsonSchema),
  result: jsonSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const operationJournalFileSchema = z.strictObject({
  journalVersion: z.literal(OPERATION_JOURNAL_VERSION),
  records: z.array(operationRecordSchema),
});

export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type OperationJournalFile = z.infer<typeof operationJournalFileSchema>;

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

export function withPhase(record: OperationRecord, to: ServiceOwnerState, now: string): OperationRecord {
  assertTransition(record.phase, to, record.migrationStarted);
  return { ...record, phase: to, updatedAt: now };
}

/** Monotonic: once true the policy is forced to repair-only, because the old program must never reopen a possibly upgraded DB (ADR-22). */
export function withMigrationStarted(record: OperationRecord, now: string): OperationRecord {
  if (record.migrationStarted && record.recoveryPolicy === "repair-only") return record;
  return { ...record, migrationStarted: true, recoveryPolicy: "repair-only", updatedAt: now };
}

export function withRepairOnly(record: OperationRecord, now: string): OperationRecord {
  return record.recoveryPolicy === "repair-only"
    ? record
    : { ...record, recoveryPolicy: "repair-only", updatedAt: now };
}

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

export function withCancelRequested(record: OperationRecord, now: string): OperationRecord {
  if (record.status !== "in-progress" || record.cancelRequested) return record;
  return { ...record, cancelRequested: true, updatedAt: now };
}

export function isPristine(record: OperationRecord): boolean {
  return record.phase === record.previousOwner && !record.migrationStarted && record.completedSteps.length === 0;
}

export function withTerminalStatus(
  record: OperationRecord,
  status: "completed" | "cancelled" | "failed" | "interrupted",
  now: string,
  detail: { readonly result?: JournalJson; readonly error?: string } = {},
): OperationRecord {
  if (record.status !== "in-progress") return record;
  return { ...record, status, result: detail.result ?? null, error: detail.error ?? null, updatedAt: now };
}

export function withRecoveryNotice(
  record: OperationRecord,
  notice: Omit<RecoveryNotice, "acknowledged">,
  now: string,
): OperationRecord {
  return { ...record, recoveryNotice: { ...notice, acknowledged: false }, updatedAt: now };
}

export function withNoticeAcknowledged(record: OperationRecord, now: string): OperationRecord {
  if (!record.recoveryNotice || record.recoveryNotice.acknowledged) return record;
  return { ...record, recoveryNotice: { ...record.recoveryNotice, acknowledged: true }, updatedAt: now };
}
