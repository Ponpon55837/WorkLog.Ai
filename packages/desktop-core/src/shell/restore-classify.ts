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

/** What main keeps behind a backup token: the path never leaves main. */
export interface RestoreEntry {
  readonly path: string;
  readonly view: Omit<RestoreBackupView, "backupId">;
}

/** The problem a look at a file found, or null when it can be restored from. */
export function problemOf(item: Pick<DesktopInspectedBackup, "status">): BackupProblem | null {
  return item.status === "ok" ? null : item.status;
}

/** The page's view of one inspected file (without its token). */
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

/** The inspected items of an outcome, or null when the child itself could not answer. */
export function inspectedItems(outcome: BackupInspectOutcome): readonly DesktopInspectedBackup[] | null {
  return outcome.outcome === "checked" ? outcome.result.items : null;
}

/**
 * The reason a restore did not replace the database, from what the preview child answered. Every one of them means the
 * database in use was not replaced, except `outcome-unknown`: the request reached the child and no verdict came back, so
 * nothing may be claimed until the files are looked at. `failed` is what a child that never got the request comes to.
 */
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

/** What holds a restore back, from the coordinator, the backend's own report and whether a page action runs. */
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
