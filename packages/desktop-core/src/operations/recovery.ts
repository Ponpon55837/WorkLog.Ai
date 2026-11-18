import { compareDatabaseIdentity } from "../db-source/identity-compare.js";
import type { DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import type { OperationRecord, RecoveryPolicy } from "./journal-record.js";
import { isLegalTransition, type ServiceOwnerState } from "./service-owner-state.js";

/** What the OS, the child process and the DB really look like right now (never inferred from the journal). */
export interface ProbeReport {
  readonly oldServiceRegistered: boolean;
  readonly oldServiceEnabled: boolean;
  readonly oldServiceRunning: boolean;
  readonly desktopChild: { readonly running: boolean; readonly identityVerified: boolean };
  readonly dbSchemaVersion: number | null;
  readonly dbIdentity: DatabaseIdentityRecord | null;
  /** Probe-side proof that a migration ran (e.g. schema_migrations has newer rows than at operation start). */
  readonly migrationEvidence: boolean;
  /** The port the settings file names right now (what the next start uses); null when there are no settings. */
  readonly settingsPort: number | null;
  /**
   * What the settings file says about the service: `absent` (a new install), `active` (a verified start was recorded)
   * or `no-active` (settings without a recorded start, as an upgrade from an old version leaves them).
   */
  readonly settingsState: "absent" | "active" | "no-active";
}

/** Injected probe; it may throw when state cannot be determined, which recovery treats as unknown. */
export type StateProbe = () => ProbeReport | Promise<ProbeReport>;

/** Steps needed to bring the old service back to its recorded state. */
export interface RestorePlan {
  readonly register: boolean;
  readonly enable: boolean;
  readonly start: boolean;
}

export type RecoveryAction = "none" | "resume" | "restore-previous" | "repair";

/** The next state chosen from the probe; applying it is a separate, journaled step. */
export interface RecoveryDecision {
  readonly nextState: ServiceOwnerState;
  readonly action: RecoveryAction;
  readonly recoveryPolicy: RecoveryPolicy;
  /** True when the journal says so OR the probe shows migration evidence. */
  readonly migrationStarted: boolean;
  readonly restore: RestorePlan | null;
  readonly reason: string;
}

/** Both identities must exist and satisfy the shared {@link compareDatabaseIdentity} rule. */
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

/** Roll an interrupted operation back to the previous owner, only when that is provably safe. */
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
  // MANAGED where the table allows it (the service stays the one it was); otherwise the phase the record stopped in.
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

/**
 * A port change never edits `desired.port` before the new backend is verified, and the child ends with the App, so the
 * settings file is the one place that says which port won: the old one (nothing to undo), the new one (the commit
 * landed before the journal was closed), or neither (unknown: repair).
 */
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

/**
 * A database switch commits the new path and identity in the one atomic settings write that follows the verified start,
 * so the identity of the database the settings name (read by the probe) says what happened: the target (applied) or
 * another database that opens fine (the switch never committed; that database was never touched). Unknown: repair.
 */
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

/**
 * Disabling the old login service is OS commands plus a file removal and never restarts it. The detection says what is
 * left: still installed (nothing more to undo; the start stays held back while it is there), or gone. A service that was
 * running when it was ended may have been stopped mid-write, so "gone" counts only when the App's database then passes
 * its read-only check (`dbIdentity` is set only by a passed check); otherwise it is repair.
 */
function decideLegacyDisable(record: OperationRecord, report: ProbeReport): RecoveryDecision {
  if (report.oldServiceRegistered || report.oldServiceRunning) {
    return untouched(record, "the old login service is still installed; the App never restarts it");
  }
  if (record.oldRunningState === true && report.dbIdentity === null) {
    return repair(record, false, "the old service was ended while running and the database check did not pass");
  }
  return untouched(record, "the old login service is gone");
}

/**
 * The decisions the product's own operations need, for the case without migration. An ordinary start (takeover or
 * restart) touched nothing durable when the settings already hold its result (or do not exist yet), so it closes
 * without a notice. An Agent apply is its own file-level transaction that start-up has already finished or undone.
 */
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

/**
 * Decide the next state from REAL probe data, not from the journal phase text (ADR-21).
 * Fail closed: a throwing probe, a DB identity mismatch or any migration evidence ends in NEEDS_REPAIR/repair-only
 * unless the migrated service is demonstrably managed.
 */
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
  if (!migration) {
    const byKind = decideByKind(record, report);
    if (byKind) return byKind;
  }
  const touchesDb = record.phase !== "UNCONFIGURED" && record.phase !== "EXTERNAL" && record.phase !== "NEEDS_REPAIR";
  if (touchesDb && record.selectedDb !== null && !isSameDatabase(record.selectedDb, report.dbIdentity)) {
    return repair(record, migration, "database identity differs from the selected database or is unknown");
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
