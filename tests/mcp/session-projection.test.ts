import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { WorkIntelligenceStore, LATEST_SCHEMA_VERSION } from "../../packages/storage/src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wi-projection-mcp-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Synthetic MCP", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "mcp-projection",
    title: "Fictional verification",
    summary: "Implementation done; device tests pending",
    changedFiles: ["src/example.ts"],
    verification: { status: "in_progress" },
    workSummary: {
      outcomes: ["Implemented change"],
      scope: ["src/example.ts"],
      decisions: [{ text: "Keep existing contract", origin: "agent_autonomous" }],
      verification: ["Synthetic automated check passed"],
      nextSteps: ["Physical device checks"],
    },
  });
  if (finalized.outcome !== "finalized") throw new Error("Fixture failed");
  const server = createWorkIntelligenceMcpServer(store, "test", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "synthetic-projection-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => server.close(),
    () => client.close(),
  );
  const call = async (args: Record<string, unknown>) =>
    CallToolResultSchema.parse(
      await client.callTool({
        name: "work_read",
        arguments: { operation: "work_get_session", arguments: { sessionId: finalized.session.id, ...args } },
      }),
    );
  return { client, store, id: finalized.session.id, call };
}
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
describe("MCP projected Session wire contract", () => {
  it("keeps full reads unchanged while a projected read answers in text only", async () => {
    const { call, store, id } = await setup();
    const full = await call({});
    expect(full.isError).toBeFalsy();
    const fullText = full.content.find((c) => c.type === "text");
    if (fullText?.type !== "text") throw new Error("No text");
    expect(JSON.parse(fullText.text)).toEqual(
      JSON.parse(JSON.stringify(store.getSessionDetailForAgent({ sessionId: id }))),
    );
    const result = await call({ view: "completion" });
    const text = result.content.find((c) => c.type === "text");
    if (text?.type !== "text") throw new Error("No text");
    const parsed = JSON.parse(text.text);
    expect(parsed.projection).toMatchObject({ version: 1, view: "completion" });
    expect(parsed.session.verification.status).toBe("in_progress");
    expect(parsed.session.workSummary.nextSteps).toEqual(["Physical device checks"]);
    // A client that gives the model only one of the two parts must still get the body.
    expect(result).not.toHaveProperty("structuredContent");
    const onlyFiles = await call({ select: ["session.changedFiles"] });
    expect(onlyFiles).not.toHaveProperty("structuredContent");
    const filesText = onlyFiles.content.find((c) => c.type === "text");
    if (filesText?.type !== "text") throw new Error("No text");
    expect(JSON.parse(filesText.text).session.changedFiles).toEqual(["src/example.ts"]);
    expect(store.getAgentReadsForRecord("session", id).total).toBe(3);
  });
  it("returns the handoff body in every part of the result a client may hand to the model", async () => {
    const { call } = await setup();
    const result = await call({ view: "handoff" });
    expect(result.isError).toBeFalsy();
    // Each part the server sends has to carry the body on its own: text always, structuredContent when present.
    const parts: unknown[] = result.content.flatMap((c) => (c.type === "text" ? [JSON.parse(c.text)] : []));
    if (result.structuredContent) parts.push(result.structuredContent);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part).toMatchObject({
        outcome: "session_detail",
        projection: { version: 1, view: "handoff" },
        session: {
          summary: "Implementation done; device tests pending",
          workSummary: { outcomes: ["Implemented change"], nextSteps: ["Physical device checks"] },
          files: [{ path: "src/example.ts" }],
        },
      });
    }
  });
  it("bounds projected completion wire size even when a Session has large unrelated evidence", async () => {
    const { call, store, id } = await setup();
    for (let index = 0; index < 30; index++)
      store.attachEvidence({
        sessionId: id,
        kind: "test",
        reference: `synthetic:large-${index}`,
        summary: "Fictional unrelated evidence ".repeat(150),
      });
    const full = await call({});
    const result = await call({ view: "completion" });
    const text = result.content.find((entry) => entry.type === "text");
    if (text?.type !== "text") throw new Error("No text");
    expect(text.text.length).toBeLessThanOrEqual(5000);
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(full).length * 0.2);
    expect(JSON.parse(text.text).session.workSummary.nextSteps).toEqual(["Physical device checks"]);
    expect(result).not.toHaveProperty("structuredContent");
  });
  it("rejects invalid selection through the real dispatcher and exposes complete resource schema", async () => {
    const { client, call } = await setup();
    for (const args of [
      { select: [] },
      { select: ["session"] },
      { select: ["events", "events"] },
      { view: "completion", select: ["events"] },
      { view: "handoff", includeRawSnapshots: true },
      { select: ["rawSnapshots"], unknown: true },
    ])
      expect((await call(args)).isError).toBe(true);
    const contract = await client.readResource({ uri: "work-intelligence://agent/tool-contracts/work_get_session" });
    const value = JSON.stringify(contract);
    expect(value).toContain("session.workSummary.decisions");
    expect(value).toContain("mutually exclusive");
    expect(value).toContain("unavailableFields");
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(4);
    expect(JSON.stringify(tools)).not.toContain("session.workSummary.decisions");
  });
});
