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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connectServer(store: WorkIntelligenceStore) {
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "fiction-shared-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-connections-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
  );
  const knowledgeIds = new Map<string, string>();
  for (const word of ["alpha1", "alpha2", "beta1", "beta2"]) {
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `knowledge-${word}`,
      kind: "gotcha",
      title: `Orchard ${word} rule`,
      body: `Prune the ${word} rows before the frost.`,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    knowledgeIds.set(word, result.knowledge.id);
  }
  return { root, store, serverA: await connectServer(store), serverB: await connectServer(store), knowledgeIds };
}

async function recallWord(client: Client, root: string, word: string) {
  const result = await client.callTool({
    name: "work_read",
    arguments: { operation: "work_recall", arguments: { projectRoot: root, q: word } },
  });
  expect(result.isError).toBeFalsy();
}

async function finalize(client: Client, root: string, key: string) {
  const result = await client.callTool({
    name: "work_write_idempotent",
    arguments: {
      operation: "work_finalize_session",
      arguments: {
        projectRoot: root,
        idempotencyKey: key,
        title: `Session ${key}`,
        summary: `${key} summary.`,
        workSummary: { outcomes: ["Done."], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      },
    },
  });
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const receipt = JSON.parse(text) as { unreportedKnowledge?: { items: Array<{ id: string }>; total: number } };
  return receipt.unreportedKnowledge;
}

describe("unreported Knowledge across MCP connections of one client", () => {
  it.each([
    ["A first", ["a", "b"]],
    ["B first", ["b", "a"]],
  ] as const)("lists only each server's own reads when finalizing %s", async (_name, order) => {
    const { root, serverA, serverB, knowledgeIds } = await setup();
    await recallWord(serverA, root, "alpha1");
    await recallWord(serverB, root, "beta1");
    await recallWord(serverA, root, "alpha2");
    await recallWord(serverB, root, "beta2");
    const works = {
      a: { client: serverA, expected: ["alpha1", "alpha2"] },
      b: { client: serverB, expected: ["beta1", "beta2"] },
    };

    for (const key of order) {
      const unreported = await finalize(works[key].client, root, `work-${key}`);
      expect(unreported?.items.map((item) => item.id).sort()).toEqual(
        works[key].expected.map((word) => knowledgeIds.get(word)!).sort(),
      );
    }
  });
});
