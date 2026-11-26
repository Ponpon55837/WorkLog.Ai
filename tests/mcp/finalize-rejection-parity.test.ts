import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { mcpFinalizeSessionInputSchema } from "../../packages/schema/src/index.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { FINALIZE_CONTRADICTIONS, finalizeRequest } from "../helpers/finalize-contradictions.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-finalize-parity-"));
  const store = new WorkIntelligenceStore(":memory:");
  store.updateProject(store.addProject("Lighthouse", root).id, { status: "tracked" });
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { store, root, client };
}

async function finalizeThroughMcp(client: Client, args: Record<string, unknown>) {
  const called = await client.callTool({
    name: "work_write_idempotent",
    arguments: { operation: "work_finalize_session", arguments: args },
  });
  const [content] = called.content as Array<{ text: string }>;
  const { server: _status, ...body } = JSON.parse(content?.text ?? "null") as Record<string, unknown>;
  return { isError: called.isError, body };
}

describe("finalize rejections through MCP", () => {
  it.each(FINALIZE_CONTRADICTIONS)(
    "answers $code with the storage body and writes nothing",
    async ({ code, fields, ids }) => {
      const { store, root, client } = await connect();
      const args = finalizeRequest(root, `parity-${code}`, fields);
      const tokenBefore = store.getChangeToken();

      const mcp = await finalizeThroughMcp(client, args);
      const direct = store.finalizeSession(mcpFinalizeSessionInputSchema.parse(args));

      expect(mcp.isError).toBeFalsy();
      expect(mcp.body).toEqual(direct);
      expect(mcp.body).toMatchObject({ outcome: "rejected", code, ...(ids ? { ids } : {}) });
      expect(mcp.body["reason"]).toEqual(expect.any(String));
      expect(mcp.body["fix"]).toEqual(expect.any(String));
      expect(store.listSessions()).toEqual([]);
      expect(store.getChangeToken()).toEqual(tokenBefore);
    },
  );

  it("still answers a retry of an already saved key as a duplicate", async () => {
    const { store, root, client } = await connect();
    expect(
      store.finalizeSession(mcpFinalizeSessionInputSchema.parse(finalizeRequest(root, "parity-retry"))).outcome,
    ).toBe("finalized");
    const retry = await finalizeThroughMcp(
      client,
      finalizeRequest(root, "parity-retry", { supersededOutstandingItemIds: ["item-b"] }),
    );
    expect(retry.body).toMatchObject({ outcome: "finalized", duplicate: true });
  });
});
