import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function latestSessionId(store: WorkIntelligenceStore): unknown {
  return (store as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db
    .prepare("SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1")
    .get().id;
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

  it("audits an unchanged Session re-read as session_unchanged with its id", async () => {
    const { client, store, root } = await connect();
    await call(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: root,
      idempotencyKey: "audit-mcp-unchanged",
      title: "Synthetic unchanged lantern",
      summary: "Synthetic unchanged summary.",
      workSummary: { outcomes: ["Done."], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/a.ts"],
      verification: { status: "passed" },
    });
    const sessionId = String(latestSessionId(store));
    const full = await call(client, "work_read", "work_get_session", { sessionId });
    const body = JSON.parse((full.content as Array<{ text: string }>)[0]!.text) as { session: { revision: string } };
    const unchanged = await call(client, "work_read", "work_get_session", {
      sessionId,
      knownRevision: body.session.revision,
    });
    expect(unchanged.isError).toBeFalsy();
    expect(JSON.parse((unchanged.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      outcome: "session_unchanged",
      session: { id: sessionId, revision: body.session.revision },
    });
    expect(unchanged.structuredContent).toEqual({
      outcome: "session_unchanged",
      sessionId,
      revision: body.session.revision,
    });
    const rows = auditRows(store);
    expect(rows.map((row) => [row.tool, row.outcome, row.session_ids_json, row.returned_count])).toEqual([
      ["work_get_session", "session_detail", JSON.stringify([sessionId]), 1],
      ["work_get_session", "session_unchanged", JSON.stringify([sessionId]), 1],
    ]);
  });

  it("does not fail the read when the audit insert fails", async () => {
    const { client, store, root } = await connect();
    (store as unknown as { db: { exec(sql: string): void } }).db.exec("DROP TABLE agent_read_audit");
    const result = await call(client, "work_read", "work_get_context", { projectRoot: root });
    expect(result.isError).toBeFalsy();
  });

  it("records the read duration in whole milliseconds", async () => {
    const { client, store, root } = await connect();
    const result = await call(client, "work_read", "work_get_project_status", { projectRoot: root });
    expect(result.isError).toBeFalsy();
    const [row] = auditRows(store);
    expect(row).toMatchObject({ tool: "work_get_project_status", error_code: null });
    expect(Number.isInteger(row!.duration_ms)).toBe(true);
    expect(Number(row!.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("records failed reads by code only and keeps each response unchanged", async () => {
    const { client, store, root } = await connect();
    const invalid = await call(client, "work_read", "work_recall", { projectRoot: root, unknownSecretKey: "x" });
    expect(invalid.isError).toBe(true);

    const busy = Object.assign(new Error("database is locked: secret detail"), { code: "SQLITE_BUSY" });
    const recall = vi.spyOn(store, "recall").mockImplementationOnce(() => {
      throw busy;
    });
    const busyResult = await call(client, "work_read", "work_recall", { projectRoot: root, q: "lantern" });
    expect(busyResult.isError).toBe(true);
    expect(JSON.stringify(busyResult.content)).toContain("DATABASE_BUSY");

    recall.mockImplementationOnce(() => {
      throw Object.assign(new Error("restart"), { code: "MCP_RESTART_REQUIRED" });
    });
    const restart = await call(client, "work_read", "work_recall", { projectRoot: root, q: "lantern" });
    expect(JSON.stringify(restart.content)).toContain("MCP_RESTART_REQUIRED");

    recall.mockImplementationOnce(() => {
      throw new Error("unexpected secret failure");
    });
    const failed = await call(client, "work_read", "work_recall", { projectRoot: root, q: "lantern" });
    expect(failed.isError).toBe(true);

    const rows = auditRows(store);
    expect(rows.map((row) => [row.tool, row.outcome, row.error_code, row.returned_count])).toEqual([
      ["work_recall", "error", "invalid_input", 0],
      ["work_recall", "error", "database_busy", 0],
      ["work_recall", "error", "restart_required", 0],
      ["work_recall", "error", "internal_error", 0],
    ]);
    expect(rows[0]!.duration_ms).toBeNull();
    for (const row of rows.slice(1)) expect(Number.isInteger(row.duration_ms)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/secret|lantern/);
  });

  it("does not audit writes that fail", async () => {
    const { client, store } = await connect();
    const result = await call(client, "work_write_idempotent", "work_finalize_session", { projectRoot: "/nowhere" });
    expect(result.isError).toBe(true);
    expect(auditRows(store)).toEqual([]);
  });
});
