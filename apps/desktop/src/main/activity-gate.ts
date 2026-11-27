import type { BackendSupervisor, RepairBusyReason } from "@work-intelligence/desktop-core";

export interface ActivityGateOptions {
  readonly operationRunning: () => boolean;
  readonly supervisor: Pick<BackendSupervisor, "queryActivity"> & { readonly running: unknown };
}

export type ActivityRefusal = "operation" | "activity" | "unknown";

export type ActivityGate = { readonly refusal: ActivityRefusal } | { readonly pendingImport: boolean };

export async function checkActivity(options: ActivityGateOptions): Promise<ActivityGate> {
  const { operationRunning, supervisor } = options;
  if (operationRunning()) return { refusal: "operation" };
  if (supervisor.running === undefined) return { pendingImport: false };
  const activity = await supervisor.queryActivity();
  if (activity.status === "unknown") return { refusal: "unknown" };
  return activity.busy.length > 0 ? { refusal: "activity" } : { pendingImport: activity.pendingImport };
}

export function busyReasonOf(refusal: ActivityRefusal, operation: RepairBusyReason): RepairBusyReason {
  return refusal === "operation" ? operation : { source: refusal };
}
