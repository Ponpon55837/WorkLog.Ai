import { randomUUID } from "node:crypto";
import type { OperationCoordinator, ServiceOwnerState } from "@work-intelligence/desktop-core";

/** What an Agent operation came to: its value, a lock held by another operation, or a failure of the work itself. */
export type AgentOperationResult<T> =
  { readonly status: "done"; readonly value: T } | { readonly status: "busy" } | { readonly status: "failed" };

/**
 * Runs `work` (an Agent configuration change: an apply, and the uninstall flow's removal) as an `apply-agent` operation
 * of the coordinator. The journal then holds an in-progress record for as long as the work runs, so a crash in the
 * middle is found at the next start (the Status tab says an Agent setup was interrupted); the files themselves are
 * finished or undone by the Agent setup's own journal, which start-up reads first.
 *
 * The record carries nothing but the kind: no path, no Agent content. `work` runs once, never replays, and is never
 * interrupted by a cancel (it writes files).
 */
export async function runAgentOperation<T>(
  coordinator: OperationCoordinator,
  previousOwner: ServiceOwnerState,
  work: () => Promise<T> | T,
): Promise<AgentOperationResult<T>> {
  let value: { readonly done: T } | undefined;
  const result = await coordinator.run({ operationId: randomUUID(), kind: "apply-agent", previousOwner }, [
    {
      name: "apply-agent",
      cancellable: false,
      run: async () => {
        value = { done: await work() };
        return {};
      },
    },
  ]);
  if (result.status === "busy") return { status: "busy" };
  return result.status === "completed" && value !== undefined
    ? { status: "done", value: value.done }
    : { status: "failed" };
}
