import { compareDatabaseIdentity } from "../db-source/identity-compare.js";
import type { DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import type { OperationRecord, RecoveryPolicy } from "./journal-record.js";
import { isLegalTransition, type ServiceOwnerState } from "./service-owner-state.js";

export interface ProbeReport {
  readonly oldServiceRegistered: boolean;
  readonly oldServiceEnabled: boolean;
  readonly oldServiceRunning: boolean;
  readonly desktopChild: { readonly running: boolean; readonly identityVerified: boolean };
  readonly dbSchemaVersion: number | null;
  readonly dbIdentity: DatabaseIdentityRecord | null;
  readonly migrationEvidence: boolean;
  readonly settingsPort: number | null;
  readonly settingsState: "absent" | "active" | "no-active";
}

/** May throw when state cannot be determined; recovery treats that as unknown and fails closed to repair. */
export type StateProbe = () => ProbeReport | Promise<ProbeReport>;

export interface RestorePlan {
  readonly register: boolean;
  readonly enable: boolean;
  readonly start: boolean;
}

export type RecoveryAction = "none" | "resume" | "restore-previous" | "repair";

export interface RecoveryDecision {
  readonly nextState: ServiceOwnerState;
  readonly action: RecoveryAction;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly migrationStarted: boolean;
  readonly restore: RestorePlan | null;
  readonly reason: string;
}

function isSameDatabase(expected: DatabaseIdentityRecord | null, actual: DatabaseIdentityRecord | null): boolean {
  return expected !== null && actual !== null && compareDatabaseIdentity(expected, actual).same;
}

function repair(record: OperationRecord, migrationStarted: boolean, reason: string): RecoveryDecision {
  return {
    nextState: "NEEDS_REPAIR",
    action: "repair",
    recoveryPolicy: "repair-only",
    migrationStarted,
    restore: null,
    reason,
  };
}

export { repair as repairDecision };

function planRestore(record: OperationRecord, report: ProbeReport): RestorePlan {
  return {
    register: record.oldServiceDefinition !== null && !report.oldServiceRegistered,
    enable: record.oldEnabledState === true && !report.oldServiceEnabled,
    start: record.oldRunningState === true && !report.oldServiceRunning,
  };
}

function rollback(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  if (record.recoveryPolicy === "repair-only") return repair(record, false, "policy is repair-only");
  if (record.previousOwner === "EXTERNAL") {
    return {
      nextState: "EXTERNAL",
      action: "restore-previous",
      recoveryPolicy: record.recoveryPolicy,
      migrationStarted: false,
      restore: planRestore(record, report),
      reason: "no migration evidence; previous external service can be restored",
    };
  }
  if (
    record.previousOwner === "MANAGED" &&
    record.phase === "PREPARING" &&
    report.desktopChild.running &&
    report.desktopChild.identityVerified
  ) {
    return {
      nextState: "MANAGED",
      action: "restore-previous",
      recoveryPolicy: record.recoveryPolicy,
      migrationStarted: false,
      restore: null,
      reason: "re-operation was interrupted before any change; the verified child is still running",
    };
  }
  return repair(record, false, `cannot safely roll back to ${record.previousOwner} from ${record.phase}`);
}

function decideWithMigration(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  const verifiedChild = report.desktopChild.running && report.desktopChild.identityVerified;
  if (record.phase === "MANAGED" && !report.oldServiceRunning) {
    return {
      nextState: "MANAGED",
      action: "none",
      recoveryPolicy: "repair-only",
      migrationStarted: true,
      restore: null,
      reason: "migrated and managed; nothing to recover",
    };
  }
  if (record.phase === "STARTING" && verifiedChild) {
    return {
      nextState: "STARTING",
      action: "resume",
      recoveryPolicy: "repair-only",
      migrationStarted: true,
      restore: null,
      reason: "migration done and verified child is running; resume verification",
    };
  }
  return repair(record, true, "migration started: the old service must not be restarted automatically (ADR-22)");
}

function untouched(record: OperationRecord, reason: string): RecoveryDecision {
  const nextState = isLegalTransition(record.phase, "MANAGED") ? "MANAGED" : record.phase;
  return {
    nextState,
    action: "none",
    recoveryPolicy: record.recoveryPolicy,
    migrationStarted: false,
    restore: null,
    reason,
  };
}

function detailNumber(record: OperationRecord, key: string): number | null {
  const value = record.details?.[key];
  return typeof value === "number" ? value : null;
}

function decidePortChange(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  const from = detailNumber(record, "from");
  const to = detailNumber(record, "to");
  if (report.settingsPort === null || from === null || to === null) {
    return repair(record, false, "a port change was interrupted and the settings do not say which port is in use");
  }
  if (report.settingsPort === to) return untouched(record, "the port change was committed before the interruption");
  if (report.settingsPort === from) {
    return untouched(record, "the port change never committed; the settings name the old port");
  }
  return repair(record, false, "the settings name neither the old nor the new port");
}

function decideDatabaseChange(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  if (record.selectedDb === null || report.dbIdentity === null) {
    return repair(record, false, "a database switch was interrupted and the database now named could not be verified");
  }
  return untouched(
    record,
    isSameDatabase(record.selectedDb, report.dbIdentity)
      ? "the database switch was committed before the interruption"
      : "the database switch never committed; the settings name the previous database",
  );
}

function decideLegacyDisable(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  if (report.oldServiceRegistered || report.oldServiceRunning) {
    return untouched(record, "the old login service is still installed; the App never restarts it");
  }
  if (record.oldRunningState === true && report.dbIdentity === null) {
    return repair(record, false, "the old service was ended while running and the database check did not pass");
  }
  return untouched(record, "the old login service is gone");
}

function decideByKind(record: OperationRecord, report: ProbeReport): RecoveryDecision | undefined {
  if (report.desktopChild.running) return undefined;
  switch (record.kind) {
    case "change-port":
      return decidePortChange(record, report);
    case "change-db":
      return decideDatabaseChange(record, report);
    case "legacy-disable":
      return decideLegacyDisable(record, report);
    case "apply-agent":
      return untouched(record, "an Agent setup was interrupted; its own journal was finished or undone at start-up");
    case "takeover":
    case "restart":
      if (record.previousOwner !== "EXTERNAL" && report.settingsState !== "no-active") {
        return untouched(record, "an ordinary start was interrupted; the settings already hold its result");
      }
      return undefined;
    case "restore":
    case "maintenance":
      return undefined;
  }
}

function decideWithoutMigration(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  const child = report.desktopChild;
  switch (record.phase) {
    case "PREPARING":
      return rollback(record, report);
    case "QUIESCING":
      return child.running
        ? repair(record, false, "desktop child is running while QUIESCING")
        : rollback(record, report);
    case "STARTING":
      if (child.running && child.identityVerified) {
        return {
          nextState: "STARTING",
          action: "resume",
          recoveryPolicy: record.recoveryPolicy,
          migrationStarted: false,
          restore: null,
          reason: "verified child is running; resume verification",
        };
      }
      return child.running
        ? repair(record, false, "a child is running but its identity is unverified")
        : rollback(record, report);
    case "MANAGED":
      if (report.oldServiceRunning && child.running)
        return repair(record, false, "old service and desktop child both run");
      return {
        nextState: "MANAGED",
        action: "none",
        recoveryPolicy: record.recoveryPolicy,
        migrationStarted: false,
        restore: null,
        reason: "managed state is consistent",
      };
    case "NEEDS_REPAIR":
      return repair(record, false, "already needs repair");
    default:
      return {
        nextState: record.phase,
        action: "none",
        recoveryPolicy: record.recoveryPolicy,
        migrationStarted: false,
        restore: null,
        reason: "no managed change in progress",
      };
  }
}

export async function recover(record: OperationRecord, probe: StateProbe): Promise<RecoveryDecision> {
  let report: ProbeReport;
  try {
    report = await probe();
  } catch (error) {
    return repair(
      record,
      record.migrationStarted,
      `state probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const advanced =
    record.schemaVersionAtStart !== null &&
    report.dbSchemaVersion !== null &&
    report.dbSchemaVersion > record.schemaVersionAtStart;
  const migration = record.migrationStarted || report.migrationEvidence || advanced;
  const touchesDb = record.phase !== "UNCONFIGURED" && record.phase !== "EXTERNAL" && record.phase !== "NEEDS_REPAIR";
  // A database switch records the TARGET database, so a settings file naming another one is its normal "never committed"
  // case; for any other operation a different or unverifiable database is repair.
  const identityDiffers =
    touchesDb && record.selectedDb !== null && !isSameDatabase(record.selectedDb, report.dbIdentity);
  if (identityDiffers && (record.kind !== "change-db" || migration)) {
    return repair(record, migration, "database identity differs from the selected database or is unknown");
  }
  if (!migration) {
    const byKind = decideByKind(record, report);
    if (byKind) return byKind;
  }
  if (migration) {
    if (record.phase === "UNCONFIGURED" || record.phase === "EXTERNAL" || record.phase === "NEEDS_REPAIR") {
      return {
        nextState: record.phase,
        action: record.phase === "NEEDS_REPAIR" ? "repair" : "none",
        recoveryPolicy: "repair-only",
        migrationStarted: true,
        restore: null,
        reason: "migration evidence recorded",
      };
    }
    return decideWithMigration(record, report);
  }
  return decideWithoutMigration(record, report);
}
