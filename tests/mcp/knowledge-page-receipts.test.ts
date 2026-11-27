import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const SLUG = "pitfalls";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-page-receipts-"));
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
      idempotencyKey: `receipt-${counter}`,
      title: `Session ${counter}`,
      summary: `Session ${counter} summary.`,
      workSummary: { outcomes: [`Outcome ${counter}`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const call = async (operation: string, args: Record<string, unknown>) => {
    const called = await client.callTool({
      name: "work_write_idempotent",
      arguments: { operation, arguments: { projectRoot: root, slug: SLUG, ...args } },
    });
    const [content] = called.content as Array<{ text: string }>;
    const { server: _status, ...body } = JSON.parse(content?.text ?? "null") as Record<string, unknown>;
    return { isError: called.isError, body };
  };
  const readToken = () => {
    const result = store.getKnowledgePageContext({ projectRoot: root, slug: SLUG });
    if (result.outcome !== "knowledge_page_context") throw new Error("Expected a knowledge page context");
    return result.reviewToken;
  };
  const writtenPage = async () => {
    store.requestKnowledgePageUpdate({ projectRoot: root, slug: SLUG });
    const first = await finalize();
    const saved = await call("work_save_knowledge_page", {
      idempotencyKey: "page-1",
      reviewToken: readToken(),
      sections: [{ heading: "Build", content: "Run the build first.", sourceSessionIds: [first] }],
    });
    expect(saved.body).toMatchObject({ outcome: "knowledge_page_saved" });
    return first;
  };
  return { store, root, call, finalize, readToken, writtenPage };
}

describe("work_mark_knowledge_page_checked receipt", () => {
  it("returns the page state without its sections", async () => {
    const { call, finalize, writtenPage } = await connect();
    await writtenPage();
    const second = await finalize();
    const checked = await call("work_mark_knowledge_page_checked", { throughSessionId: second });
    expect(checked.isError).toBeFalsy();
    expect(checked.body).toEqual({
      outcome: "knowledge_page_checked",
      page: {
        slug: SLUG,
        version: 1,
        status: "fresh",
        newSessionCount: 0,
        checkedThrough: { sessionId: second, completedAt: expect.any(String) },
        sourcedThrough: expect.any(String),
      },
    });
  });

  it("keeps the refusals as they are", async () => {
    const { call, writtenPage } = await connect();
    await writtenPage();
    expect((await call("work_mark_knowledge_page_checked", { throughSessionId: "missing" })).body).toMatchObject({
      outcome: "invalid_cursor",
    });
    expect(
      (await call("work_mark_knowledge_page_checked", { slug: "missing-page", throughSessionId: "any" })).body,
    ).toMatchObject({ outcome: "not_found" });
  });

  it("is smaller than the stored page record", async () => {
    const { store, root, call, finalize, writtenPage } = await connect();
    await writtenPage();
    const second = await finalize();
    const full = store.markKnowledgePageChecked({ projectRoot: root, slug: SLUG, throughSessionId: second });
    const compact = await call("work_mark_knowledge_page_checked", { throughSessionId: second });
    expect(JSON.stringify(compact.body).length).toBeLessThan(JSON.stringify(full).length);
    expect(compact.body.page).not.toHaveProperty("sections");
  });
});

describe("work_save_knowledge_page receipts", () => {
  it("advances the cursor with checkedThroughSessionId and reports the checked state", async () => {
    const { call, finalize, readToken, writtenPage } = await connect();
    const first = await writtenPage();
    const second = await finalize();
    const receipt = await call("work_save_knowledge_page", {
      idempotencyKey: "section-1",
      reviewToken: readToken(),
      checkedThroughSessionId: second,
      upsertSections: [{ heading: "Build", content: "Build shared first.", sourceSessionIds: [first, second] }],
    });
    expect(receipt.body).toMatchObject({
      outcome: "knowledge_page_saved",
      sectionChanges: { replaced: ["Build"] },
      page: { status: "fresh", newSessionCount: 0 },
    });
    expect(receipt.body).not.toHaveProperty("warnings");
  });

  it("returns invalid_cursor without writing", async () => {
    const { store, root, call, readToken, writtenPage } = await connect();
    const first = await writtenPage();
    const refused = await call("work_save_knowledge_page", {
      idempotencyKey: "section-1",
      reviewToken: readToken(),
      checkedThroughSessionId: "missing",
      upsertSections: [{ heading: "Build", content: "Changed.", sourceSessionIds: [first] }],
    });
    expect(refused.body).toMatchObject({ outcome: "invalid_cursor" });
    expect(store.listKnowledgePages({ projectRoot: root })).toMatchObject({ items: [{ version: 1 }] });
  });

  it("reminds the Agent that coverage did not advance when new Sessions are waiting", async () => {
    const { call, finalize, readToken, writtenPage } = await connect();
    const first = await writtenPage();
    await finalize();
    const receipt = await call("work_save_knowledge_page", {
      idempotencyKey: "section-1",
      reviewToken: readToken(),
      upsertSections: [{ heading: "Build", content: "Changed.", sourceSessionIds: [first] }],
    });
    expect(receipt.body).toMatchObject({ warnings: [expect.stringContaining("checkedThroughSessionId")] });
  });

  it("keeps the newest 20 sources and reports the rest in the receipt", async () => {
    const { call, finalize, readToken, writtenPage } = await connect();
    await writtenPage();
    const ids: string[] = [];
    for (let index = 0; index < 23; index += 1) ids.push(await finalize());
    const receipt = await call("work_save_knowledge_page", {
      idempotencyKey: "section-1",
      reviewToken: readToken(),
      upsertSections: [{ heading: "Build", content: "Many sources.", sourceSessionIds: ids }],
    });
    expect(receipt.isError).toBeFalsy();
    expect(receipt.body).toMatchObject({
      outcome: "knowledge_page_saved",
      droppedSourceSessionIds: [{ heading: "Build", sessionIds: ids.slice(0, 3) }],
      warnings: expect.arrayContaining([expect.stringContaining("droppedSourceSessionIds")]),
    });
  });

  it("returns retry material for a stale token", async () => {
    const { call, finalize, readToken, writtenPage } = await connect();
    const first = await writtenPage();
    const stale = readToken();
    const second = await finalize();
    await call("work_save_knowledge_page", {
      idempotencyKey: "section-1",
      reviewToken: stale,
      upsertSections: [{ heading: "Deploy", content: "Deploy last.", sourceSessionIds: [second] }],
    });
    const conflict = await call("work_save_knowledge_page", {
      idempotencyKey: "section-2",
      reviewToken: stale,
      upsertSections: [{ heading: "Build", content: "Build twice.", sourceSessionIds: [first] }],
    });
    expect(conflict.isError).toBeFalsy();
    expect(conflict.body).toMatchObject({
      outcome: "version_conflict",
      baseVersion: 1,
      currentVersion: 2,
      changedHeadings: ["Deploy"],
      reviewToken: expect.stringMatching(/^kpr1\./),
    });
  });
});
