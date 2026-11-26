import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { saveKnowledgePageInputSchema } from "../../packages/schema/src/index.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

// Fictional fixtures only.
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-review-token-"));
  const store = new WorkIntelligenceStore(":memory:");
  store.updateProject(store.addProject("Apiary", root).id, { status: "tracked" });
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  let counter = 0;
  const finalize = async () => {
    counter += 1;
    await new Promise((resolve) => setTimeout(resolve, 3));
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `token-${counter}`,
      title: `Session ${counter}`,
      summary: `Session ${counter} summary.`,
      workSummary: { outcomes: [`Outcome ${counter}`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const save = async (args: Record<string, unknown>) => {
    const called = await client.callTool({
      name: "work_write_idempotent",
      arguments: { operation: "work_save_knowledge_page", arguments: { projectRoot: root, slug: "pitfalls", ...args } },
    });
    const [content] = called.content as Array<{ text: string }>;
    const { server: _status, ...body } = JSON.parse(content?.text ?? "null") as Record<string, unknown>;
    return { isError: called.isError, body };
  };
  const readToken = () => {
    const result = store.getKnowledgePageContext({ projectRoot: root, slug: "pitfalls" });
    if (result.outcome !== "knowledge_page_context") throw new Error("Expected a knowledge page context");
    return result.reviewToken;
  };
  return { store, root, save, finalize, readToken };
}

describe("reviewToken coverage through MCP", () => {
  it("answers a tampered token like storage does, without an error flag and without writing", async () => {
    const { store, root, save, finalize, readToken } = await connect();
    store.requestKnowledgePageUpdate({ projectRoot: root, slug: "pitfalls" });
    const first = await finalize();
    const sections = [{ heading: "Build", content: "Run the build first.", sourceSessionIds: [first] }];
    expect((await save({ idempotencyKey: "page-1", sections, reviewToken: readToken() })).body).toMatchObject({
      outcome: "knowledge_page_saved",
    });
    await finalize();
    const payload = JSON.parse(Buffer.from(readToken().slice("kpr1.".length), "base64url").toString("utf8"));
    const tampered = `kpr1.${Buffer.from(JSON.stringify({ ...payload, id: "no-such-session" })).toString("base64url")}`;
    const request = { idempotencyKey: "page-2", sections, reviewToken: tampered };

    const viaMcp = await save(request);
    const direct = store.saveKnowledgePage(
      saveKnowledgePageInputSchema.parse({ projectRoot: root, slug: "pitfalls", ...request }),
    );

    expect(viaMcp.isError).toBeFalsy();
    expect(viaMcp.body).toEqual(direct);
    expect(viaMcp.body).toMatchObject({
      outcome: "invalid_review_token",
      fix: expect.stringContaining("Read the page"),
    });
    const pages = store.listKnowledgePages({ projectRoot: root });
    if (pages.outcome !== "knowledge_pages") throw new Error("Expected pages");
    expect(store.listKnowledgePageVersions(pages.items[0]!.id)).toMatchObject({
      versions: [expect.objectContaining({ version: 1 })],
    });
  });

  it("keeps Sessions the Agent did not read as new when it saves without a token", async () => {
    const { store, root, save, finalize, readToken } = await connect();
    store.requestKnowledgePageUpdate({ projectRoot: root, slug: "pitfalls" });
    const first = await finalize();
    const sections = [{ heading: "Build", content: "Run the build first.", sourceSessionIds: [first] }];
    await save({ idempotencyKey: "page-1", sections, reviewToken: readToken() });
    await finalize();

    const saved = await save({ idempotencyKey: "page-2", sections });
    expect(saved.isError).toBeFalsy();
    expect(saved.body).toMatchObject({
      outcome: "knowledge_page_saved",
      warnings: [expect.stringContaining("Sessions finished after your read still count as new")],
      page: { version: 2, newSessionCount: 1 },
    });
  });
});
