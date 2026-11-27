import type { UsageProjectInput } from "@work-intelligence/shared/agent-usage";
import { runUsageScan, runUsageSources, type UsageScanContext, type UsageScanInput } from "./usage-scan.js";
import type { UsageWorkerReply, UsageWorkerRequest } from "./usage-worker-client.js";

function serializeError(error: unknown): { name: string; message: string } {
  // Only the kind of failure travels back: file-system error messages embed paths.
  const name = error instanceof Error && error.name.startsWith("UsageScan") ? error.name : "Error";
  return { name, message: name === "Error" ? "The usage scan failed." : name };
}

async function execute(context: UsageScanContext, request: UsageWorkerRequest): Promise<unknown> {
  const { operation } = request;
  switch (operation.type) {
    case "sources":
      return runUsageSources(operation.projects satisfies UsageProjectInput[], context);
    case "scan":
      return runUsageScan(operation.input satisfies UsageScanInput, context, {
        ...(operation.deadlineMs === undefined ? {} : { deadlineMs: operation.deadlineMs }),
      });
  }
}

function send(reply: UsageWorkerReply): void {
  process.send?.(reply, undefined, undefined, () => process.exit(0));
}

if (!process.send) {
  throw new Error("The usage worker must be started by the API process.");
}
const context = JSON.parse(process.argv[2] ?? "{}") as UsageScanContext;

process.on("disconnect", () => process.exit(0));

process.once("message", (message: UsageWorkerRequest) => {
  execute(context, message).then(
    (value) => send({ id: message.id, ok: true, value }),
    (error: unknown) => send({ id: message.id, ok: false, error: serializeError(error) }),
  );
});
