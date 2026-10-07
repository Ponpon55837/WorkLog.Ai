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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-read-audit-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Read audit fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "fiction-audit-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { client, store, root };
}

function auditRows(store: WorkIntelligenceStore): Array<Record<string, unknown>> {
  return (store as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db
    .prepare("SELECT * FROM agent_read_audit ORDER BY created_at, rowid")
    .all();
}

async function call(client: Client, dispatcher: string, operation: string, args: Record<string, unknown>) {
  return client.callTool({ name: dispatcher, arguments: { operation, arguments: args } });
}

describe("MCP passive read audit", () => {
  it("records one row per successful read with the client name, and none for writes", async () => {
    const { client, store, root } = await connect();
    const finalize = await call(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: root,
      idempotencyKey: "audit-mcp-1",
      title: "Synthetic audit lantern",
      summary: "Synthetic audit lantern summary.",
      workSummary: { outcomes: ["Done."], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/a.ts"],
      verification: { status: "passed" },
    });
    expect(finalize.isError).toBeFalsy();
    expect(auditRows(store)).toEqual([]);

    const recall = await call(client, "work_read", "work_recall", { projectRoot: root, q: "lantern" });
    expect(recall.isError).toBeFalsy();
    const rows = auditRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "work_recall", agent_client: "fiction-audit-agent", outcome: "recall" });
    expect(Number(rows[0]!.returned_count)).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain("lantern");
  });

  it("does not fail the read when the audit insert fails", async () => {
    const { client, store, root } = await connect();
    (store as unknown as { db: { exec(sql: string): void } }).db.exec("DROP TABLE agent_read_audit");
    const result = await call(client, "work_read", "work_get_context", { projectRoot: root });
    expect(result.isError).toBeFalsy();
  });
});
