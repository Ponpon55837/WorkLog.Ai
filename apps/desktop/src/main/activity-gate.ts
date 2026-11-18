import type { BackendSupervisor, RepairBusyReason } from "@work-intelligence/desktop-core";

export interface ActivityGateOptions {
  /** Whether an App operation (a start, a port change, a restore...) holds the coordinator. */
  readonly operationRunning: () => boolean;
  readonly supervisor: Pick<BackendSupervisor, "queryActivity"> & { readonly running: unknown };
}

/** Why the App's work on the service must wait; `operation` is another App operation, `activity` the Dashboard's data work. */
export type ActivityRefusal = "operation" | "activity" | "unknown";

/**
 * What a restart or a stop of the running backend would throw away. One question for every path that does it (port
 * change, database change, copy to a local disk, quit), so none of them cuts an import or a backup short unasked.
 * The backend is asked only while one runs; an idle staged import preview is not work, it is only reported.
 */
export type ActivityGate = { readonly refusal: ActivityRefusal } | { readonly pendingImport: boolean };

export async function checkActivity(options: ActivityGateOptions): Promise<ActivityGate> {
  const { operationRunning, supervisor } = options;
  if (operationRunning()) return { refusal: "operation" };
  if (supervisor.running === undefined) return { pendingImport: false };
  const activity = await supervisor.queryActivity();
  if (activity.status === "unknown") return { refusal: "unknown" };
  return activity.busy.length > 0 ? { refusal: "activity" } : { pendingImport: activity.pendingImport };
}

/** The reason the repair page shows for a refusal: the running operation's own name, or the Dashboard's data work. */
export function busyReasonOf(refusal: ActivityRefusal, operation: RepairBusyReason): RepairBusyReason {
  return refusal === "operation" ? operation : { source: refusal };
}
