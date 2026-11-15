import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-trust-"));
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

async function read<T = Record<string, unknown>>(
  client: Client,
  operation: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name: "work_read", arguments: { operation, arguments: args } });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as T;
}

function finalize(store: WorkIntelligenceStore, root: string, key: string, title: string, summary: string): void {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title,
    summary,
    workSummary: {
      outcomes: [`${title} outcome.`],
      scope: [],
      decisions: [],
      verification: [],
      nextSteps: [],
    },
    changedFiles: ["src/dryer/heater.ts"],
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") throw new Error(`Expected ${key} to finalize.`);
}

describe("MCP retrieval trust fields", () => {
  it("keeps up to four matchedIn fields in strength order and passes knowledgeConfidence through", async () => {
    const { client, store, root } = await connect();
    finalize(store, root, "dryer", "Saffron dryer calibration", "Saffron dryer calibration notes for the heater.");

    const scoped = await read<{
      confidence: string;
      knowledgeConfidence: string;
      hits: Array<{ matchedIn: string[] }>;
    }>(client, "work_recall", { projectRoot: root, q: "saffron dryer calibration", paths: ["src/dryer/heater.ts"] });
    const unscoped = await read<{ knowledgeConfidence: string; hits: Array<{ matchedIn: string[] }> }>(
      client,
      "work_recall",
      { q: "saffron dryer calibration", paths: ["src/dryer/heater.ts"] },
    );

    expect(scoped).toMatchObject({ confidence: "high", knowledgeConfidence: "none" });
    expect(unscoped.knowledgeConfidence).toBe("none");
    const storeHit = store.recall({
      projectRoot: root,
      q: "saffron dryer calibration",
      paths: ["src/dryer/heater.ts"],
    });
    if (storeHit.outcome !== "recall") throw new Error("Expected recall.");
    const full = storeHit.hits[0]?.matchedIn ?? [];
    expect(full.length).toBeGreaterThan(4);
    // Strongest first, at most four, and path (appended last) is dropped only when it falls past the cap.
    expect(scoped.hits[0]?.matchedIn).toEqual(full.slice(0, 4));
    expect(unscoped.hits[0]?.matchedIn).toEqual(full.slice(0, 4));
    expect(scoped.hits[0]?.matchedIn.length).toBeLessThanOrEqual(4);
  });

  it("passes knowledgeConfidence and the Knowledge hint through work_get_context", async () => {
    const { client, store, root } = await connect();
    finalize(store, root, "dryer", "Saffron dryer calibration", "Saffron dryer calibration notes.");

    const context = await read<{
      relevant: { confidence: string; knowledgeConfidence: string; knowledgeHint?: string };
    }>(client, "work_get_context", { projectRoot: root, task: "saffron dryer calibration" });
    expect(context.relevant).toMatchObject({ confidence: "high", knowledgeConfidence: "none" });
    expect(context.relevant.knowledgeHint).toContain("No Knowledge text matched this task");
  });

  it("marks synonym-only hits in work_search and leaves matchedIn off a hit that names no field", async () => {
    const { client, store, root } = await connect();
    finalize(store, root, "direct", "Valve status route handler", "Handler summary.");
    finalize(store, root, "synonym", "Add endpoint for valve status", "Endpoint summary.");

    const search = await read<{ hits: Array<{ title: string; matchedIn?: string; matchedVia?: string }> }>(
      client,
      "work_search",
      { projectRoot: root, q: "route" },
    );
    expect(search.hits.find((hit) => hit.title.includes("route"))).not.toHaveProperty("matchedVia");
    expect(search.hits.find((hit) => hit.title.includes("endpoint"))).toMatchObject({
      matchedVia: "synonym",
      matchedIn: expect.any(String),
    });

    const real = store.searchForAgent("route", root);
    if (real.outcome !== "search") throw new Error("Expected search.");
    vi.spyOn(store, "searchForAgent").mockReturnValue({
      ...real,
      hits: real.hits.map(({ session, excerpt }) => ({ session, excerpt })),
    });
    const unnamed = await read<{ hits: Array<Record<string, unknown>> }>(client, "work_search", {
      projectRoot: root,
      q: "route",
    });
    expect(unnamed.hits[0]).not.toHaveProperty("matchedIn");
  });

  it("passes appliesToScanTruncated, termHits and termHitsTruncated through a scoped work_search_knowledge", async () => {
    const { client, store, root } = await connect();
    const real = store.searchKnowledgeForAgent.bind(store);
    vi.spyOn(store, "searchKnowledgeForAgent").mockImplementation((input) => {
      const result = real(input);
      if (result.outcome !== "knowledge") return result;
      return {
        ...result,
        appliesToScanTruncated: true,
        termHits: [{ term: "zzyzx", count: 0 }],
        termHitsTruncated: true,
      };
    });

    const scoped = await read(client, "work_search_knowledge", { projectRoot: root, q: "zzyzx" });
    expect(scoped).toMatchObject({
      appliesToScanTruncated: true,
      termHits: [{ term: "zzyzx", count: 0 }],
      termHitsTruncated: true,
    });
    const unscoped = await read(client, "work_search_knowledge", { q: "zzyzx" });
    expect(unscoped).toMatchObject({ appliesToScanTruncated: true, termHitsTruncated: true });
  });

  it("passes termHits for a zero-hit scoped Knowledge search and says no record contains the words", async () => {
    const { client, root } = await connect();

    const result = await read<{ match: string; termHits: unknown; hint: string }>(client, "work_search_knowledge", {
      projectRoot: root,
      q: "zzyzx quuxlet",
    });
    expect(result.match).toBe("none");
    expect(result.termHits).toEqual([
      { term: "zzyzx", count: 0 },
      { term: "quuxlet", count: 0 },
    ]);
    expect(result.hint).toContain("contains any of these words");
  });

  it("passes termHitsTruncated through a scoped work_recall", async () => {
    const { client, store, root } = await connect();
    finalize(store, root, "dryer", "Saffron dryer calibration", "Notes.");
    const words = Array.from(
      { length: 34 },
      (_, index) => `qz${String.fromCharCode(97 + (index % 26))}${index < 26 ? "a" : "b"}`,
    );

    const result = await read<{ termHitsTruncated?: boolean; termHits?: unknown[] }>(client, "work_recall", {
      projectRoot: root,
      q: words.join(" "),
    });
    expect(result.termHitsTruncated).toBe(true);
    expect(result.termHits).toHaveLength(32);
  });
});
