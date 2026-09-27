import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkIntelligenceStore, LATEST_SCHEMA_VERSION } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";

interface ConnectedFixture {
  client: Client;
  projectRoot: string;
  store: WorkIntelligenceStore;
}

interface SerializedMcpPayload {
  length: number;
  value: unknown;
}

const cleanups: Array<() => Promise<void> | void> = [];
const query = "agent context retrieval budget";
const retrievalQuery = "agent context retrieval budget gotcha";
const RESPONSE_BUDGETS = {
  contextWithoutTask: 19_000,
  contextWithTask: 28_000,
  recallDefault: 7_000,
  recallFive: 6_500,
  searchDefault: 17_000,
} as const;
const sharedPlan = [
  "## Historical proposal: Agent context retrieval budget",
  "The old plan proposes returning every recent Session, decision, Knowledge page, and raw handoff excerpt together.",
  "It repeats the same planning passage across imported Sessions and does not distinguish completed work from open ideas.",
  "A focused Agent should keep the verified decision, implementation trap, and source id available while leaving full text one read away.",
].join("\n");
const longSummary = [
  "Completed the retrieval-budget decision: preserve the confirmed implementation and its constraints while keeping repetitive planning detail out of the first response.",
].join(" ");
const longDecision =
  "Keep Agent context focused on the completed implementation; preserve its source id and verified decision, and read the full Session when more evidence is needed.";
const longOpenItem = "Check one more verified example before changing the persistent Agent context guidance.";
const pageContent = `${"Agent context retrieval budget: preserve the decision, trap, source, and verification details; keep repeated plans out of the first response. ".repeat(2)}`;

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connectWithSyntheticHistory(): Promise<ConnectedFixture> {
  const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-response-size-"));
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Synthetic Cedar", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 8, 1));

  const sessionIds: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    vi.setSystemTime(Date.now() + 60_000);
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `response-size-session-${index}`,
      title: `Agent context retrieval budget ${index.toString().padStart(2, "0")}`,
      summary: longSummary,
      workSummary: {
        outcomes: [`Completed the retrieval-budget implementation for fixture ${index}.`],
        scope: [`Synthetic storage and MCP response measurement fixture ${index}.`],
        decisions: index < 8 ? [longDecision] : [],
        verification: [`The fictional test fixture ${index} preserves source and verification metadata.`],
        nextSteps: index < 4 ? [longOpenItem] : [],
      },
      changedFiles: [`packages/example-${index}/src/context.ts`],
      ...(index < 10 ? { handoffContent: sharedPlan } : {}),
      verification: { status: "passed", summary: "Synthetic fixture verification passed." },
    });
    if (result.outcome !== "finalized") {
      throw new Error(`Expected synthetic Session ${index} to finalize; received ${result.outcome}.`);
    }
    sessionIds.push(result.session.id);
  }

  for (let index = 0; index < 4; index += 1) {
    for (let relatedIndex = 4; relatedIndex < 7; relatedIndex += 1) {
      const linked = store.linkSessions({
        sessionId: sessionIds[index]!,
        relatedSessionId: sessionIds[relatedIndex]!,
        relation: "related",
        linked: true,
      });
      if (linked.outcome !== "session_link_updated") {
        throw new Error(`Expected a synthetic Session link; received ${linked.outcome}.`);
      }
    }
  }

  for (let index = 0; index < 4; index += 1) {
    const result = store.recordKnowledge({
      projectRoot,
      idempotencyKey: `response-size-knowledge-${index}`,
      kind: index % 2 === 0 ? "pattern" : "gotcha",
      title: `Agent context retrieval budget ${index % 2 === 0 ? "pattern" : "gotcha"} ${index}`,
      body: `${longDecision} Trap: do not let repeated old handoff plans outrank the verified implementation. ${"Synthetic Knowledge detail retained for the response-size fixture. ".repeat(8)}`,
      tags: ["agent", "context", "retrieval", "budget"],
    });
    if (result.outcome !== "knowledge_recorded") {
      throw new Error(`Expected synthetic Knowledge ${index} to record; received ${result.outcome}.`);
    }
  }

  const pages = [
    { slug: "architecture", title: undefined, question: undefined },
    { slug: "pitfalls", title: undefined, question: undefined },
    { slug: "response-budget", title: "Agent response budget", question: "Which verified details belong in context?" },
  ];
  for (const page of pages) {
    store.requestKnowledgePageUpdate({ projectRoot, ...page });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: page.slug,
      idempotencyKey: `response-size-page-${page.slug}`,
      sections: [
        { heading: "Agent context retrieval budget", content: pageContent, sourceSessionIds: [sessionIds[0]!] },
      ],
    });
    if (saved.outcome !== "knowledge_page_saved") {
      throw new Error(`Expected synthetic Knowledge page ${page.slug} to save; received ${saved.outcome}.`);
    }
  }

  const server = createWorkIntelligenceMcpServer(store, "0.1.0-test", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "response-size-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(projectRoot, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { client, projectRoot, store };
}

async function serializedMcpPayload(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<SerializedMcpPayload> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, name).not.toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  expect(text, `${name} must return a text payload`).toBeTypeOf("string");
  return { length: text!.length, value: JSON.parse(text!) as unknown };
}

describe("synthetic MCP response-size baseline", () => {
  it("measures context with and without a task, default recall, and default search", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const contextWithoutTask = await serializedMcpPayload(client, "work_get_context", { projectRoot });
    const contextWithTask = await serializedMcpPayload(client, "work_get_context", { projectRoot, task: query });
    const recallDefault = await serializedMcpPayload(client, "work_recall", { projectRoot, q: retrievalQuery });
    const recallFive = await serializedMcpPayload(client, "work_recall", {
      projectRoot,
      q: retrievalQuery,
      limit: 5,
    });
    const searchDefault = await serializedMcpPayload(client, "work_search", { projectRoot, q: retrievalQuery });
    const recallFivePayload = recallFive.value as { hits: Array<{ title: string }> };
    const searchPayload = searchDefault.value as unknown[];

    const taskContext = store.getContext(projectRoot, { task: query });
    expect(taskContext.outcome).toBe("context");
    if (taskContext.outcome !== "context") throw new Error("Expected scoped task context.");
    expect(taskContext.knowledgePages.length).toBe(3);
    expect(taskContext.recentSessions).toHaveLength(12);
    expect(taskContext.recentDecisions.length).toBeGreaterThan(0);
    expect(taskContext.relevant?.sessions.some((hit) => hit.title.includes("03"))).toBe(true);
    expect(taskContext.relevant?.knowledge.some((hit) => hit.title.includes("gotcha"))).toBe(true);

    console.info(
      `Synthetic MCP response sizes (characters): ${JSON.stringify({
        contextWithoutTask: contextWithoutTask.length,
        contextWithTask: contextWithTask.length,
        recallDefault: recallDefault.length,
        recallFive: recallFive.length,
        searchDefault: searchDefault.length,
      })}`,
    );
    expect(contextWithoutTask.length).toBeGreaterThan(0);
    expect(contextWithTask.length).toBeGreaterThan(contextWithoutTask.length);
    expect(recallDefault.length).toBeGreaterThan(0);
    expect(searchDefault.length).toBeGreaterThan(recallDefault.length);
    expect(recallFivePayload.hits).toHaveLength(5);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("03"))).toBe(true);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("gotcha"))).toBe(true);
    expect(searchPayload).toHaveLength(20);
    expect(contextWithoutTask.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithoutTask);
    expect(contextWithTask.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    expect(recallDefault.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallDefault);
    expect(recallFive.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallFive);
    expect(searchDefault.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.searchDefault);
  });
});
