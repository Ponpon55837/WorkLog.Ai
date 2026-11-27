import type { ManagedStartResult } from "../backend/managed-service.js";

export type StartOutcome =
  { readonly kind: "started" } | { readonly kind: "busy" } | { readonly kind: "failed"; readonly code: string };

export function interpretManagedStart(result: ManagedStartResult): StartOutcome {
  const { operation } = result;
  if (operation.status === "busy") return { kind: "busy" };
  if (operation.status === "completed" && result.backend) return { kind: "started" };
  return { kind: "failed", code: result.errorCode ?? "REPAIR_REQUIRED" };
}
