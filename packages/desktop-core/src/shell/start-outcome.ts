import type { ManagedStartResult } from "../backend/managed-service.js";

/** What a managed start means for the shell. `busy` is not a failure: another operation holds the lock and nothing changed. */
export type StartOutcome =
  { readonly kind: "started" } | { readonly kind: "busy" } | { readonly kind: "failed"; readonly code: string };

/** Reads the coordinator's answer; anything that did not complete with a verified backend is a failure with a code. */
export function interpretManagedStart(result: ManagedStartResult): StartOutcome {
  const { operation } = result;
  if (operation.status === "busy") return { kind: "busy" };
  if (operation.status === "completed" && result.backend) return { kind: "started" };
  return { kind: "failed", code: result.errorCode ?? "REPAIR_REQUIRED" };
}
