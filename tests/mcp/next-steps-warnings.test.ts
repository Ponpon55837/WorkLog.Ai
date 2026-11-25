import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];
const TRANSIENT_STEP = "變更尚未 commit";
const LASTING_STEP = "為離線備份補上還原演練";
const EXPECTED_ITEMS = [{ index: 1, category: "uncommitted" }];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-warnings-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Warned project", root);
  store.updateProject(project.id, { status: "tracked" });
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { client, root };
}

function workSummary(nextSteps: string[]) {
  return { outcomes: ["Done."], scope: [], decisions: [], verification: [], nextSteps };
}

async function call(client: Client, name: string, operation: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { operation, arguments: args } });
  expect(result.isError).not.toBe(true);
  const [content] = result.content as Array<{ type: string; text: string }>;
  return {
    text: JSON.parse(content?.text ?? "null") as { session: { id: string }; nextStepsWarnings?: unknown },
    structured: result.structuredContent as { nextStepsWarnings?: unknown } | undefined,
  };
}

describe("nextStepsWarnings through the MCP server", () => {
  it("reports a transient nextSteps item on finalize in the text and structuredContent", async () => {
    const { client, root } = await connect();

    const { text, structured } = await call(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: root,
      idempotencyKey: "warn-finalize",
      title: "Finalize with a transient step",
      summary: "Finalized with a transient step.",
      workSummary: workSummary([LASTING_STEP, TRANSIENT_STEP]),
      changedFiles: [],
      verification: { status: "passed" },
    });

    expect(text.nextStepsWarnings).toMatchObject({ items: EXPECTED_ITEMS });
    expect(structured?.nextStepsWarnings).toMatchObject({ items: EXPECTED_ITEMS });
  });

  it("reports a transient nextSteps item on a work summary update in the text and structuredContent", async () => {
    const { client, root } = await connect();
    const { text: finalized } = await call(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: root,
      idempotencyKey: "warn-update-base",
      title: "Finalize before updating",
      summary: "Finalized before updating.",
      workSummary: workSummary([LASTING_STEP]),
      changedFiles: [],
      verification: { status: "passed" },
    });

    const { text, structured } = await call(client, "work_write_overwrite", "work_update_session_work_summary", {
      sessionId: finalized.session.id,
      idempotencyKey: "warn-update",
      mode: "replace",
      workSummary: workSummary([LASTING_STEP, TRANSIENT_STEP]),
    });

    expect(text.nextStepsWarnings).toMatchObject({ items: EXPECTED_ITEMS });
    expect(structured?.nextStepsWarnings).toMatchObject({ items: EXPECTED_ITEMS });
  });
});
