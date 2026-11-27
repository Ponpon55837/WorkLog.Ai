import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-conventions-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Saffron Farm", root);
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
  return { client, store, root };
}

async function callJson(
  client: Client,
  dispatcher: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: dispatcher, arguments: { operation, arguments: args } });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as Record<string, unknown>;
}

describe("project conventions over MCP", () => {
  it("returns conventions in work_get_context, and an Agent edit of the body withdraws them", async () => {
    const { client, store, root } = await connect();
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "rule",
      kind: "decision",
      title: "Pack saffron in glass",
      body: "Always pack saffron in glass jars.",
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    store.setKnowledgeConvention({ projectRoot: root, knowledgeId: recorded.knowledge.id, confirmed: true });

    const before = await callJson(client, "work_read", "work_get_context", { projectRoot: root });
    expect(before.conventions).toEqual({
      readWith: "work_get_knowledge_history",
      items: [{ id: recorded.knowledge.id, title: "Pack saffron in glass" }],
    });

    const updated = await callJson(client, "work_write_overwrite", "work_update_knowledge", {
      projectRoot: root,
      knowledgeId: recorded.knowledge.id,
      body: "Pack saffron in tins.",
    });
    expect(updated).toMatchObject({ outcome: "knowledge_updated" });

    const after = await callJson(client, "work_read", "work_get_context", { projectRoot: root });
    expect("conventions" in after).toBe(false);
  });
});
