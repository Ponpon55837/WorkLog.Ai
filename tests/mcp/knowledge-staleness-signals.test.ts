import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import type { KnowledgeRecord } from "../../packages/core/src/index.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-signals-"));
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  return { client, store, root };
}

async function callJson<T = Record<string, unknown>>(
  client: Client,
  dispatcher: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name: dispatcher, arguments: { operation, arguments: args } });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as T;
}

function finalize(store: WorkIntelligenceStore, root: string, key: string, changedFiles: string[]): void {
  vi.setSystemTime(Date.now() + 60_000);
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: `${key} summary.`,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles,
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") throw new Error(`Expected ${key} to finalize.`);
}

describe("MCP Knowledge staleness signals", () => {
  it("returns the breadth and a narrowing warning from work_record_knowledge and work_update_knowledge", async () => {
    const { client, store, root } = await connect();
    for (let index = 0; index < 12; index += 1) finalize(store, root, `s${index}`, [`src/field/${index}.ts`]);

    vi.setSystemTime(Date.now() + 60_000);
    const recorded = await callJson<{
      outcome: string;
      knowledge: KnowledgeRecord;
      appliesToBreadth: { share: number; sessions: number; truncated: boolean; broad: boolean };
      warnings: string[];
    }>(client, "work_write_idempotent", "work_record_knowledge", {
      projectRoot: root,
      idempotencyKey: "wide-rule",
      kind: "gotcha",
      title: "Synthetic wide rule",
      body: "Fictional note.",
      appliesTo: ["src/**"],
    });
    expect(recorded.outcome).toBe("knowledge_recorded");
    expect(recorded.appliesToBreadth).toEqual({ share: 1, sessions: 12, truncated: false, broad: true });
    expect(recorded.warnings[0]).toContain("Narrow it");

    vi.setSystemTime(Date.now() + 60_000);
    const narrowed = await callJson<{ outcome: string; appliesToBreadth: { share: number }; warnings?: string[] }>(
      client,
      "work_write_overwrite",
      "work_update_knowledge",
      { projectRoot: root, knowledgeId: recorded.knowledge.id, appliesTo: ["src/field/3.ts"] },
    );
    expect(narrowed.outcome).toBe("knowledge_updated");
    expect(narrowed.appliesToBreadth.share).toBeCloseTo(0.083, 3);
    expect(narrowed.warnings).toBeUndefined();
  });

  it("passes possiblyStale.reason, appliesToBreadth and broadChangesSince through work_search_knowledge", async () => {
    const { client, store, root } = await connect();
    vi.setSystemTime(Date.now() + 60_000);
    const make = (key: string, appliesTo: string[]) => {
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: key,
        kind: "gotcha",
        title: `Synthetic ${key} rule`,
        body: "Fictional note.",
        appliesTo,
      });
      if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    };
    make("focused", ["src/field/**"]);
    make("bulk", ["vendor/**"]);
    finalize(store, root, "touch", ["src/field/a.ts"]);
    finalize(store, root, "bulk-change", [
      "vendor/a.ts",
      ...Array.from({ length: 24 }, (_, index) => `generated/${index}.ts`),
    ]);

    const result = await callJson<{ items: KnowledgeRecord[] }>(client, "work_read", "work_search_knowledge", {
      projectRoot: root,
    });
    const focused = result.items.find((item) => item.title === "Synthetic focused rule")!;
    const bulk = result.items.find((item) => item.title === "Synthetic bulk rule")!;
    expect(focused.possiblyStale).toMatchObject({
      sessionCount: 1,
      reason: "applies_to_changed",
      appliesToBreadth: { share: 1, sessions: 1 },
    });
    expect(focused.broadChangesSince).toBeUndefined();
    expect(bulk.possiblyStale).toBeUndefined();
    expect(bulk.broadChangesSince).toBe(1);
  });

  it("returns the rejected restore outcome with the successor id", async () => {
    const { client, store, root } = await connect();
    vi.setSystemTime(Date.now() + 60_000);
    const older = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "older",
      kind: "pattern",
      title: "Synthetic older rule",
      body: "Fictional note.",
    });
    if (older.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    vi.setSystemTime(Date.now() + 60_000);
    const newer = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "newer",
      kind: "pattern",
      title: "Synthetic newer rule",
      body: "Fictional note.",
      supersedesId: older.knowledge.id,
    });
    if (newer.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");

    const restored = await callJson(client, "work_write_overwrite", "work_update_knowledge", {
      projectRoot: root,
      knowledgeId: older.knowledge.id,
      status: "active",
    });
    expect(restored).toMatchObject({
      outcome: "rejected",
      reason: "superseded_by_active",
      knowledgeId: older.knowledge.id,
      successorId: newer.knowledge.id,
    });
  });
});
