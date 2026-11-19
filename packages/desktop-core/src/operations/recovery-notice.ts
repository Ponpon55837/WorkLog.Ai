import { compareDatabaseIdentity } from "../db-source/identity-compare.js";
import type { OperationRecord, RecoveryNotice } from "./journal-record.js";
import type { ProbeReport, RecoveryDecision } from "./recovery.js";

/** What a notice stores before the user has seen it. */
export type RecoveryNoticeInput = Omit<RecoveryNotice, "acknowledged">;

function portOf(record: OperationRecord, key: "from" | "to"): number | null {
  const value = record.details?.[key];
  return typeof value === "number" ? value : null;
}

function notice(
  record: OperationRecord,
  kind: RecoveryNotice["kind"],
  ports: { port?: number | null; attempted?: number | null } = {},
): RecoveryNoticeInput {
  return { kind, operation: record.kind, port: ports.port ?? null, attemptedPort: ports.attempted ?? null };
}

/**
 * What the user is told about an operation recovery just closed, or null when it needs no words (an ordinary start that
 * was interrupted and left nothing behind). The answer comes from the decision and the REAL state the probe read, so the
 * text never claims more than was verified: a port change is "kept" only when the settings really name the old port.
 */
export function describeRecovery(
  record: OperationRecord,
  decision: RecoveryDecision,
  report: ProbeReport | null,
): RecoveryNoticeInput | null {
  if (decision.action === "repair" || report === null) {
    return notice(record, "needs-repair", { port: report?.settingsPort ?? null });
  }
  switch (record.kind) {
    case "change-port": {
      const attempted = portOf(record, "to");
      return report.settingsPort !== null && report.settingsPort === attempted
        ? notice(record, "port-applied", { port: report.settingsPort, attempted })
        : notice(record, "port-kept", { port: report.settingsPort, attempted });
    }
    case "change-db":
      return record.selectedDb !== null &&
        report.dbIdentity !== null &&
        compareDatabaseIdentity(record.selectedDb, report.dbIdentity).same
        ? notice(record, "db-applied")
        : notice(record, "db-kept");
    case "legacy-disable":
      return notice(
        record,
        report.oldServiceRegistered || report.oldServiceRunning ? "legacy-present" : "legacy-disabled",
      );
    case "apply-agent":
      return notice(record, "agent-interrupted");
    case "takeover":
    case "restart":
    case "restore":
    case "maintenance":
      return null;
  }
}
