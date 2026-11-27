import type { DesktopInspectedBackup } from "@work-intelligence/schema";
import type {
  BackupInspectOutcome,
  BackendActivityReport,
  DatabaseRestoreOutcome,
} from "../backend/backend-supervisor.js";
import type { BusyOperationInfo } from "../operations/coordinator.js";
import type {
  BackupProblem,
  RestoreBackupLabel,
  RestoreBackupView,
  RestoreBusyDetail,
  RestoreFailureReason,
} from "./restore-types.js";

export interface RestoreEntry {
  readonly path: string;
  readonly view: Omit<RestoreBackupView, "backupId">;
}

export function problemOf(item: Pick<DesktopInspectedBackup, "status">): BackupProblem | null {
  return item.status === "ok" ? null : item.status;
}

export function viewOf(
  item: DesktopInspectedBackup,
  options: { readonly picked?: boolean; readonly modifiedAt?: string | null } = {},
): Omit<RestoreBackupView, "backupId"> {
  const label: RestoreBackupLabel = options.picked ? "picked" : (item.kind ?? "manual");
  return {
    label,
    fileName: item.fileName,
    createdAt: item.createdAt ?? options.modifiedAt ?? null,
    bytes: item.bytes,
    schemaVersion: item.schemaVersion ?? null,
    projects: item.projects ?? null,
    sessions: item.sessions ?? null,
    problem: problemOf(item),
  };
}

export function inspectedItems(outcome: BackupInspectOutcome): readonly DesktopInspectedBackup[] | null {
  return outcome.outcome === "checked" ? outcome.result.items : null;
}

export function restoreFailureOf(outcome: DatabaseRestoreOutcome): RestoreFailureReason | null {
  if (outcome.outcome === "unknown") return "outcome-unknown";
  if (outcome.outcome === "failed") return "failed";
  switch (outcome.result.status) {
    case "ok":
      return null;
    case "in-use":
      return "agents-running";
    case "locked":
      return "locked";
    case "no-space":
      return "no-space";
    case "newer-schema":
    case "not-database":
    case "corrupt":
    case "verify-failed":
    case "missing":
    case "same-file":
      return outcome.result.status;
    default:
      return "failed";
  }
}

export function busyDetailOf(inputs: {
  readonly current: Pick<BusyOperationInfo, "kind"> | null;
  readonly pageAction: boolean;
  readonly activity: BackendActivityReport | null;
}): RestoreBusyDetail | null {
  if (inputs.current) return { source: "operation", operation: inputs.current.kind };
  if (inputs.pageAction) return { source: "page-action" };
  if (inputs.activity === null) return null;
  if (inputs.activity.status === "unknown") return { source: "unknown" };
  return inputs.activity.busy.length > 0 ? { source: "activity", activities: [...inputs.activity.busy] } : null;
}
