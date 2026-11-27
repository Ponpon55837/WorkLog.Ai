import { randomUUID } from "node:crypto";
import type { OperationCoordinator, ServiceOwnerState } from "@work-intelligence/desktop-core";

export type AgentOperationResult<T> =
  { readonly status: "done"; readonly value: T } | { readonly status: "busy" } | { readonly status: "failed" };

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
