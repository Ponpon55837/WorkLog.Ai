import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";

const MCP_DOC = readFileSync(fileURLToPath(new URL("../../docs/mcp-tools.md", import.meta.url)), "utf8");
const TOOL_CONTRACT_RESOURCE_URI = "work-intelligence://agent/tool-contracts";

let store: WorkIntelligenceStore;
let client: Client;
let operations: string[];
let dispatchers: string[];

beforeAll(async () => {
  store = new WorkIntelligenceStore(":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  client = new Client({ name: "docs-parity", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const content = (await client.readResource({ uri: TOOL_CONTRACT_RESOURCE_URI })).contents[0];
  const index = content && "text" in content ? content.text : "";
  operations = [...index.matchAll(/^- (work_\w+) → (work_\w+): /gm)].map((match) => match[1]!);
  dispatchers = (await client.listTools()).tools.map((tool) => tool.name);
});

afterAll(async () => {
  await client.close();
  store.close();
});

describe("MCP tool documentation", () => {
  it("names every registered operation in docs/mcp-tools.md", () => {
    expect(operations.length).toBeGreaterThan(40);
    const named = new Set([...MCP_DOC.matchAll(/`(work_\w+)`/g)].map((match) => match[1]!));
    expect(operations.filter((operation) => !named.has(operation))).toEqual([]);
  });

  it("names no operation or dispatcher that does not exist", () => {
    // A column such as `sessions.work_summary_json` is qualified by its table, so it is not taken for a name here.
    const known = new Set([...operations, ...dispatchers]);
    const named = new Set([...MCP_DOC.matchAll(/(?<![.\w])(work_[a-z_]+)\b/g)].map((match) => match[1]!));
    expect([...named].filter((name) => !known.has(name)).sort()).toEqual([]);
  });
});
