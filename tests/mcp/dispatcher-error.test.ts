import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect(): Promise<Client> {
  const store = new WorkIntelligenceStore(":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => store.close(),
    () => client.close(),
  );
  return client;
}

async function callTool(client: Client, dispatcher: string, operation: string) {
  const result = await client.callTool({ name: dispatcher, arguments: { operation, arguments: {} } });
  const [content] = result.content as Array<{ text: string }>;
  return { isError: result.isError, text: content?.text ?? "" };
}

describe("dispatcher mismatch errors", () => {
  it("names the dispatcher that serves a registered operation", async () => {
    const client = await connect();
    const result = await callTool(client, "work_read", "work_finalize_session");
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      code: "UNKNOWN_OPERATION",
      error: "work_finalize_session is served by work_write_idempotent; call that dispatcher.",
      dispatcher: "work_write_idempotent",
    });
  });

  it("still rejects an operation that no dispatcher serves", async () => {
    const client = await connect();
    const result = await callTool(client, "work_read", "work_does_not_exist");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid arguments for tool work_read");
  });

  it("keeps advertising only the operations of each dispatcher", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const read = tools.find((tool) => tool.name === "work_read");
    const operation = (read?.inputSchema.properties as { operation: { enum: string[] } }).operation;
    expect(operation.enum).toContain("work_get_context");
    expect(operation.enum).not.toContain("work_finalize_session");
  });
});
