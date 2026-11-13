import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { projectDataExportSchema } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore, LATEST_SCHEMA_VERSION } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";

interface ConnectedFixture {
  client: Client;
  projectId: string;
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
  contextWithoutTask: 16_000,
  contextWithTask: 10_000,
  finalizeWithRelatedOutstandingItems: 4_000,
  finalizeReceipt: 2_000,
  startedAtFollowUp: 500,
  sessionUpdateReceipt: 1_200,
  outstandingItemsPage: 30_000,
  outstandingCleanupContext: 24_000,
  contextWithOutstandingCleanup: 10_000,
  outstandingCleanupRequestPage: 8_000,
  outstandingCleanupProposalPage: 30_000,
  relatedOutstandingItems: 3_000,
  contextRelatedOutstandingItems: 2_200,
  recallDefault: 3_500,
  recallFive: 2_400,
  searchDefault: 8_000,
  contextOmitted: 1_300,
  knowledgeSearchEmpty: 400,
  knowledgeSearchRelaxed: 3_000,
  sessionListScoped: 9_000,
  knowledgePageNotFound: 700,
  fileHistoryOnePath: 4_000,
  fileHistoryThreePaths: 10_000,
  knowledgePageContext: 10_000,
  sessionHandoffThirtyFiles: 6_500,
} as const;
const CONTEXT_ITEM_KEYS = new Set(["id", "sourceSessionId", "text", "textTruncated"]);
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

async function connectWithSyntheticHistory(
  getRestartStatus?: Parameters<typeof createWorkIntelligenceMcpServer>[4],
): Promise<ConnectedFixture> {
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

  const server = createWorkIntelligenceMcpServer(
    store,
    "0.1.0-test",
    LATEST_SCHEMA_VERSION,
    undefined,
    getRestartStatus,
  );
  const client = new Client({ name: "response-size-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(projectRoot, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  return { client, projectId: project.id, projectRoot, store };
}

async function serializedMcpPayload(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<SerializedMcpPayload> {
  const result = await client.callTool({ name: "work_read", arguments: { operation: name, arguments: args } });
  expect(result.isError, name).not.toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  expect(text, `${name} must return a text payload`).toBeTypeOf("string");
  return { length: text!.length, value: JSON.parse(text!) as unknown };
}

async function serializedFinalizePayload(client: Client, args: Record<string, unknown>): Promise<SerializedMcpPayload> {
  const result = await client.callTool({
    name: "work_write_idempotent",
    arguments: { operation: "work_finalize_session", arguments: args },
  });
  expect(result.isError, "work_finalize_session").not.toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  expect(text, "work_finalize_session must return a text payload").toBeTypeOf("string");
  return { length: text!.length, value: JSON.parse(text!) as unknown };
}

describe("synthetic MCP response-size baseline", () => {
  it("measures context with and without a task, default recall, and default search", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const contextWithoutTask = await serializedMcpPayload(client, "work_get_context", { projectRoot });
    const contextWithTask = await serializedMcpPayload(client, "work_get_context", { projectRoot, task: query });
    const outstandingItemsPage = await serializedMcpPayload(client, "work_list_outstanding_items", {
      projectRoot,
      pageSize: 5,
    });
    const recallDefault = await serializedMcpPayload(client, "work_recall", { projectRoot, q: retrievalQuery });
    const recallFive = await serializedMcpPayload(client, "work_recall", {
      projectRoot,
      q: retrievalQuery,
      limit: 5,
    });
    const searchDefault = await serializedMcpPayload(client, "work_search", { projectRoot, q: retrievalQuery });
    const recallFivePayload = recallFive.value as {
      hits: Array<{
        title: string;
        excerpt: string;
        truncated?: boolean;
        related?: Array<{ id: string; relation: string; title?: string }>;
      }>;
    };
    const searchResponse = searchDefault.value as {
      outcome: string;
      confidence: string;
      hits: Array<{
        id?: string;
        title?: string;
        date?: string;
        matchedIn?: string;
        excerpt?: string;
        verificationStatus?: string;
        session?: unknown;
      }>;
    };
    const searchPayload = searchResponse.hits;
    const relatedLinks = recallFivePayload.hits.flatMap((hit) => hit.related ?? []);
    const defaultContext = contextWithoutTask.value as {
      pendingOutstandingItems: Array<{
        id: string;
        sourceSessionId: string;
        sourceSessionTitle: string;
        sourceSessionCompletedAt: string;
        text: string;
        status: string;
        textTruncated?: boolean;
      }>;
      pendingOutstandingItemsTotal: number;
      pendingOutstandingItemsOmitted: number;
      pendingOutstandingItemsTruncated: number;
      omitted?: Array<{ section: string; readWith: string }>;
    };
    const outstandingPage = outstandingItemsPage.value as {
      items: Array<{ sourceSessionId: string; text: string; status: string }>;
      pageInfo: { total: number };
    };
    const sourceSessionIds = new Set(store.listSessions().map((session) => session.id));

    const taskContext = store.getContext(projectRoot, { task: query });
    expect(taskContext.outcome).toBe("context");
    if (taskContext.outcome !== "context") throw new Error("Expected scoped task context.");
    expect(taskContext.knowledgePages).toHaveLength(0);
    expect(taskContext.relevant?.knowledgePages).toHaveLength(1);
    // A decision shown in relevant.decisions is never repeated in recentDecisions.
    const relevantDecisionKeys = new Set(
      taskContext.relevant?.decisions.map((decision) => `${decision.sessionId}\u0000${decision.text}`),
    );
    expect(
      taskContext.recentDecisions.some((decision) =>
        relevantDecisionKeys.has(`${decision.sessionId}\u0000${decision.text}`),
      ),
    ).toBe(false);
    expect(taskContext.relevant?.decisions.length).toBeGreaterThan(0);
    expect(taskContext.relevant?.sessions.some((hit) => hit.title.endsWith("00"))).toBe(true);
    expect(taskContext.relevant?.sessions[0]?.excerpt).toContain("Check one more verified example");
    expect(taskContext.relevant?.knowledge.some((hit) => hit.title.includes("gotcha"))).toBe(true);
    expect(
      taskContext.relevant?.knowledgePages?.every((page) =>
        page.sections.every((section) => section.sourceSessionIds.length > 0),
      ),
    ).toBe(true);
    expect(taskContext.recentSessions).toEqual([]);
    expect(taskContext.knowledgePages).toEqual([]);
    expect(defaultContext.pendingOutstandingItemsTotal).toBe(4);
    expect(defaultContext.pendingOutstandingItems.length).toBeLessThanOrEqual(5);
    expect(defaultContext.pendingOutstandingItemsOmitted).toBe(
      defaultContext.pendingOutstandingItemsTotal - defaultContext.pendingOutstandingItems.length,
    );
    expect(defaultContext.pendingOutstandingItemsTruncated).toBe(0);
    expect(
      defaultContext.pendingOutstandingItems.every(
        (item) =>
          item.status === "pending" &&
          sourceSessionIds.has(item.sourceSessionId) &&
          item.sourceSessionTitle.length > 0 &&
          item.sourceSessionCompletedAt.length > 0 &&
          item.text.length <= 500,
      ),
    ).toBe(true);
    expect(defaultContext.pendingOutstandingItems.every((item) => !item.textTruncated)).toBe(true);
    expect(outstandingPage.pageInfo.total).toBe(4);
    expect(outstandingPage.items).toHaveLength(4);
    expect(outstandingPage.items.every((item) => item.status === "pending" && item.text === longOpenItem)).toBe(true);
    expect(outstandingItemsPage.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingItemsPage);
    expect(recallDefault.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallDefault);
    expect(recallFive.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallFive);
    for (const context of [contextWithoutTask, contextWithTask]) {
      const omitted = JSON.stringify((context.value as { omitted?: unknown }).omitted ?? []);
      expect(omitted.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextOmitted);
    }

    console.info(
      `Synthetic MCP response sizes (characters): ${JSON.stringify({
        contextWithoutTask: contextWithoutTask.length,
        contextWithTask: contextWithTask.length,
        contextWithTaskOmitted: JSON.stringify((contextWithTask.value as { omitted?: unknown }).omitted ?? []).length,
        outstandingItemsPage: outstandingItemsPage.length,
        recallDefault: recallDefault.length,
        recallFive: recallFive.length,
        searchDefault: searchDefault.length,
      })}`,
    );
    expect(contextWithoutTask.length).toBeGreaterThan(0);
    expect(contextWithTask.length).toBeLessThan(contextWithoutTask.length);
    expect(recallDefault.length).toBeGreaterThan(0);
    expect(searchDefault.length).toBeGreaterThan(recallDefault.length);
    expect(recallFivePayload.hits).toHaveLength(5);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("03"))).toBe(true);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("gotcha"))).toBe(true);
    expect(recallFivePayload.hits.some((hit) => hit.related?.length === 3)).toBe(true);
    expect(relatedLinks.every((link) => link.id && link.relation && !link.title)).toBe(true);
    // A projectRoot recall names its project once; hits do not repeat it.
    expect(recallFive.value).toMatchObject({ project: { id: expect.any(String), name: expect.any(String) } });
    expect(Object.keys((recallFive.value as { project: object }).project)).toEqual(["id", "name"]);
    expect(recallFivePayload.hits.every((hit) => !("projectId" in hit) && !("projectName" in hit))).toBe(true);
    expect(searchResponse).toMatchObject({ outcome: "search", confidence: "low" });
    expect(searchPayload).toHaveLength(20);
    expect(
      searchPayload.every((hit) => !hit.session && typeof hit.id === "string" && typeof hit.title === "string"),
    ).toBe(true);
    expect(
      searchPayload.every(
        (hit) =>
          typeof hit.date === "string" &&
          typeof hit.matchedIn === "string" &&
          typeof hit.excerpt === "string" &&
          typeof hit.verificationStatus === "string",
      ),
    ).toBe(true);
    expect(searchPayload.every((hit) => hit.excerpt!.length <= 110)).toBe(true);
    expect(searchPayload.some((hit) => hit.title?.includes("03"))).toBe(true);
    expect(searchPayload.some((hit) => hit.excerpt?.includes("preserve the confirmed implementation"))).toBe(true);
    expect(recallFivePayload.hits.every((hit) => hit.excerpt.length <= 112)).toBe(true);
    expect(contextWithoutTask.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithoutTask);
    expect(contextWithTask.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    expect(recallDefault.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallDefault);
    expect(recallFive.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.recallFive);
    expect(searchDefault.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.searchDefault);
  });

  it("bounds pending context items and points to the complete paged MCP list", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-response-size-"));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const store = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => store.close());
    const project = store.addProject("Synthetic Pending Project", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    const fullText = "Check this verified source-linked item before closing its work. "
      .repeat(100)
      .slice(0, 4_000)
      .trimEnd();

    for (let index = 0; index < 9; index += 1) {
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `outstanding-response-session-${index}`,
        title: `Synthetic pending source ${index}`,
        summary: `Saved fictional source Session ${index}.`,
        workSummary: {
          outcomes: [`Saved fictional source Session ${index}.`],
          scope: [],
          decisions: [],
          verification: ["The synthetic response fixture is valid."],
          nextSteps: [fullText],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") {
        throw new Error(`Expected synthetic pending source ${index}; received ${result.outcome}.`);
      }
    }
    const pendingBeforeUpdate = store.listOutstandingItems({ projectRoot });
    if (pendingBeforeUpdate.outcome !== "outstanding_items") {
      throw new Error("Expected pending synthetic items before status setup.");
    }
    const completedItemId = pendingBeforeUpdate.items[0]?.id;
    if (!completedItemId) throw new Error("Expected a pending synthetic item to complete.");
    expect(store.updateOutstandingItemStatus(completedItemId, "completed", "web").outcome).toBe(
      "outstanding_item_updated",
    );

    const server = createWorkIntelligenceMcpServer(store, "0.1.0-test", LATEST_SCHEMA_VERSION);
    const client = new Client({ name: "outstanding-response-size-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const context = await serializedMcpPayload(client, "work_get_context", { projectRoot });
    const contextValue = context.value as {
      pendingOutstandingItems: Array<{
        id: string;
        sourceSessionId: string;
        sourceSessionTitle: string;
        sourceSessionCompletedAt: string;
        text: string;
        status: string;
        textTruncated?: boolean;
      }>;
      pendingOutstandingItemsTotal: number;
      pendingOutstandingItemsOmitted: number;
      pendingOutstandingItemsTruncated: number;
      omitted?: Array<{ section: string; readWith: string }>;
    };
    const fullListPage = await serializedMcpPayload(client, "work_list_outstanding_items", {
      projectRoot,
      pageSize: 5,
    });
    const fullList = fullListPage.value as {
      items: Array<{ id: string; sourceSessionId: string; text: string; status: string }>;
      pageInfo: { total: number };
    };
    const defaultListPage = await serializedMcpPayload(client, "work_list_outstanding_items", { projectRoot });
    const defaultList = defaultListPage.value as { items: Array<{ id: string }>; pageInfo: { total: number } };
    const completedListPage = await serializedMcpPayload(client, "work_list_outstanding_items", {
      projectRoot,
      status: "completed",
      pageSize: 5,
    });
    const completedList = completedListPage.value as {
      items: Array<{ id: string; text: string; status: string }>;
      pageInfo: { total: number };
    };

    expect(context.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithoutTask);
    expect(contextValue.pendingOutstandingItemsTotal).toBe(8);
    expect(contextValue.pendingOutstandingItems).toHaveLength(5);
    expect(contextValue.pendingOutstandingItemsOmitted).toBe(3);
    expect(contextValue.pendingOutstandingItemsTruncated).toBe(5);
    expect(
      contextValue.pendingOutstandingItems.every(
        (item) =>
          item.status === "pending" &&
          item.sourceSessionId.length > 0 &&
          item.sourceSessionTitle.length > 0 &&
          item.sourceSessionCompletedAt.length > 0 &&
          item.text.length <= 500 &&
          item.textTruncated === true,
      ),
    ).toBe(true);
    expect(contextValue.pendingOutstandingItems.some((item) => item.id === completedItemId)).toBe(false);
    expect(contextValue.omitted?.some((section) => section.section === "pendingOutstandingItems")).toBe(true);
    expect(contextValue.omitted?.some((section) => section.readWith === "work_list_outstanding_items")).toBe(true);
    expect(fullText.length).toBeGreaterThanOrEqual(3_900);
    expect(fullList.pageInfo.total).toBe(8);
    expect(fullList.items).toHaveLength(5);
    expect(fullList.items.every((item) => item.status === "pending" && item.text === fullText)).toBe(true);
    expect(fullList.items.every((item) => item.sourceSessionId.length > 0)).toBe(true);
    console.info(`Max MCP outstanding-item page size: ${fullListPage.length} UTF-16 code units`);
    expect(fullListPage.length).toBeGreaterThan(20_000);
    expect(fullListPage.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingItemsPage);
    expect(defaultList.pageInfo.total).toBe(8);
    expect(defaultList.items).toHaveLength(5);
    expect(completedList).toMatchObject({
      pageInfo: { total: 1 },
      items: [expect.objectContaining({ id: completedItemId, text: fullText, status: "completed" })],
    });
  });

  it("keeps focused context and finalize related pointers bounded with many long pending items", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const phrase = "Quartz zephyr fixture";
    const longTail = "Synthetic quartz zephyr fixture remains open pending verification. ".repeat(45);
    const expectedItemCount = 12 * 5;

    for (let sourceIndex = 0; sourceIndex < 12; sourceIndex += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const nextSteps = Array.from(
        { length: 5 },
        (_, itemIndex) => `${phrase} source ${sourceIndex + 1} item ${itemIndex + 1}. ${longTail}`,
      );
      const longSourceTitle = `${phrase} source ${sourceIndex + 1} ${"synthetic session title details ".repeat(5)}`;
      const source = store.finalizeSession({
        projectRoot,
        idempotencyKey: `response-size-long-outstanding-${sourceIndex}`,
        title: longSourceTitle,
        summary: `Created long synthetic ${phrase.toLocaleLowerCase()} items for source ${sourceIndex + 1}.`,
        workSummary: {
          outcomes: ["Created fictional long outstanding-item fixtures."],
          scope: [],
          decisions: [],
          verification: ["The response-budget fixture is synthetic."],
          nextSteps,
        },
        changedFiles: [],
        verification: { status: "passed", summary: "Synthetic fixture verification passed." },
      });
      if (source.outcome !== "finalized") {
        throw new Error(`Expected long synthetic source ${sourceIndex}; received ${source.outcome}.`);
      }
    }

    const context = await serializedMcpPayload(client, "work_get_context", {
      projectRoot,
      task: phrase.toLocaleLowerCase(),
    });
    const contextValue = context.value as {
      relevant?: {
        outstandingItems?: {
          items: Array<{ id: string; sourceSessionId: string; text: string; textTruncated?: boolean }>;
          total: number;
          omitted: number;
          hint?: string;
        };
      };
    };
    const contextItems = contextValue.relevant?.outstandingItems;
    expect(context.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    expect(contextItems?.total).toBeGreaterThanOrEqual(expectedItemCount);
    expect(contextItems?.items).toHaveLength(5);
    expect(contextItems?.omitted).toBe((contextItems?.total ?? 0) - 5);
    expect(contextItems?.hint).toContain("仍未處理");
    expect(contextItems?.items.every((item) => item.text.length <= 240 && item.textTruncated === true)).toBe(true);
    // A context item is an id, its source Session id and an excerpt; the source title is one read away.
    expect(contextItems?.items.every((item) => Object.keys(item).every((key) => CONTEXT_ITEM_KEYS.has(key)))).toBe(
      true,
    );
    expect(JSON.stringify(contextItems).length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextRelatedOutstandingItems);

    const pending = store.listOutstandingItems({ projectRoot, status: "pending", pageSize: 100 });
    if (pending.outcome !== "outstanding_items") throw new Error("Expected pending response-budget fixture items.");
    const supersededItem = pending.items.find((item) => item.text.startsWith(`${phrase} source `));
    if (!supersededItem) throw new Error("Expected a long pending item to supersede in the finalize fixture.");

    const newNextStep = `${phrase} new follow-up for the next verification pass.`;
    const finalized = await serializedFinalizePayload(client, {
      projectRoot,
      idempotencyKey: "response-size-finalize-with-related-outstanding-items",
      title: `${phrase} replacement`,
      summary: `Replaced one old ${phrase.toLocaleLowerCase()} item after verification.`,
      workSummary: {
        outcomes: ["Recorded one verified replacement."],
        scope: [],
        decisions: [],
        verification: ["The synthetic replacement was verified."],
        nextSteps: [newNextStep],
      },
      changedFiles: [],
      verification: { status: "passed", summary: "Synthetic replacement verification passed." },
      supersededOutstandingItemIds: [supersededItem.id],
    });
    const finalizeValue = finalized.value as {
      session: { id: string };
      supersededOutstandingItemIds: string[];
      relatedOutstandingItems: {
        items: Array<{ id: string; sourceSessionId: string; text: string; textTruncated?: boolean }>;
        total: number;
        omitted: number;
        hint?: string;
      };
    };
    const related = finalizeValue.relatedOutstandingItems;
    expect(finalized.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.finalizeWithRelatedOutstandingItems);
    expect(finalizeValue.supersededOutstandingItemIds).toEqual([supersededItem.id]);
    expect(related.total).toBeGreaterThan(0);
    expect(related.items.length).toBeLessThanOrEqual(5);
    expect(related.items.every((item) => item.text.length <= 400 && item.textTruncated === true)).toBe(true);
    // Finalize pointers have the work_get_context shape: the source title and date are one read away.
    expect(related.items.every((item) => Object.keys(item).every((key) => CONTEXT_ITEM_KEYS.has(key)))).toBe(true);
    expect(related.items.map((item) => item.id)).not.toContain(supersededItem.id);
    expect(related.items.every((item) => item.sourceSessionId !== finalizeValue.session.id)).toBe(true);
    expect(related.items.map((item) => item.text)).not.toContain(newNextStep);
    expect(JSON.stringify(related).length).toBeLessThanOrEqual(RESPONSE_BUDGETS.relatedOutstandingItems);
  });

  it("returns a finalize receipt, not an echo, for a realistic request", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const changedFiles = Array.from({ length: 20 }, (_, index) =>
      index < 2 ? `packages/ledger/src/settlement-${index}.ts` : `apps/console/src/views/ledger-panel-${index}.vue`,
    );
    for (let index = 0; index < 6; index += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const source = store.finalizeSession({
        projectRoot,
        idempotencyKey: `response-size-receipt-source-${index}`,
        title: `Ledger settlement follow-up ${index}`,
        summary: "Left a fictional settlement check open for a later Session.",
        workSummary: {
          outcomes: [],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: [`Confirm the fictional settlement rounding rule ${index} against the ledger panel totals.`],
        },
        changedFiles: [changedFiles[index % 2]!],
        verification: { status: "passed" },
      });
      if (source.outcome !== "finalized") throw new Error(`Expected receipt source ${index}.`);
    }
    for (const [index, appliesTo] of [
      ["packages/ledger/src/settlement-0.ts"],
      ["apps/console/src/views/**"],
    ].entries()) {
      store.recordKnowledge({
        projectRoot,
        idempotencyKey: `response-size-receipt-knowledge-${index}`,
        kind: "gotcha",
        title: `Fictional ledger rule ${index}`,
        body: "Synthetic Knowledge for the finalize receipt budget.",
        appliesTo,
      });
    }
    const sentence = (topic: string) =>
      `Completed the fictional ${topic} change and checked its settlement totals against the synthetic ledger fixtures.`;
    const summary = `${sentence("settlement rounding")} ${sentence("ledger panel")} ${sentence("export")}`;
    const workSummary = {
      outcomes: [sentence("rounding"), sentence("panel totals"), sentence("export header")],
      scope: [sentence("storage scope"), sentence("console scope")],
      decisions: [sentence("rounding decision"), sentence("panel decision")],
      verification: [sentence("unit test"), sentence("typecheck"), sentence("benchmark")],
      nextSteps: [`Confirm the fictional settlement rounding rule with the next synthetic ledger export.`],
    };
    const args = {
      projectRoot,
      idempotencyKey: "response-size-receipt",
      title: "Settle fictional ledger rounding and panel totals",
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      summary,
      workSummary,
      changedFiles,
      changedFilesProvenance: changedFiles.map((path) => ({ path, sources: ["agent", "git"] })),
      verification: { status: "passed", summary: "Synthetic unit tests, typecheck and benchmark passed." },
    };
    expect(JSON.stringify(args).length).toBeGreaterThan(3_000);
    vi.setSystemTime(Date.now() + 60_000);
    const result = await client.callTool({
      name: "work_write_idempotent",
      arguments: { operation: "work_finalize_session", arguments: args },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")!.text!;
    const value = JSON.parse(text) as {
      outcome: string;
      session: { id: string; changedFilesCount: number; changedFiles?: unknown };
      relatedOutstandingItems?: { total: number };
      knowledgeToReview?: Array<{ id: string; path: string }>;
    };
    expect(text.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.finalizeReceipt);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(RESPONSE_BUDGETS.finalizeReceipt + 200);
    expect(value).toMatchObject({ outcome: "finalized", session: { changedFilesCount: 20 } });
    expect(result.structuredContent).toMatchObject({ outcome: "finalized", sessionId: value.session.id });
    expect(value.session).not.toHaveProperty("changedFiles");
    expect(value.relatedOutstandingItems?.total).toBeGreaterThan(0);
    expect(value.knowledgeToReview?.map((item) => item.path)).toEqual([
      "packages/ledger/src/settlement-0.ts",
      expect.stringMatching(/^apps\/console\/src\/views\//),
    ]);
    // Nothing in the receipt depends on the OS or the temp directory: paths are project-relative.
    expect(text).not.toContain(projectRoot);
    expect(text).not.toContain(tmpdir());
    for (const echoed of [args.title, summary, ...workSummary.outcomes, changedFiles[5]!]) {
      expect(text).not.toContain(echoed);
    }

    // Without a startedAt the receipt adds the evidence-only follow-up, which stays within its own small allowance.
    const { startedAt: _startedAt, ...withoutStart } = args;
    const missing = await client.callTool({
      name: "work_write_idempotent",
      arguments: {
        operation: "work_finalize_session",
        arguments: { ...withoutStart, idempotencyKey: "response-size-receipt-no-start" },
      },
    });
    const missingText = (missing.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )!.text!;
    expect(missingText).toContain("startedAtFollowUp");
    expect(missingText.length).toBeLessThanOrEqual(
      RESPONSE_BUDGETS.finalizeReceipt + RESPONSE_BUDGETS.startedAtFollowUp,
    );
  });

  it("answers the in-place Session updates with receipts, not an echo of the Session", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const sentence = (topic: string) =>
      `Completed the fictional ${topic} change and checked its settlement totals against the synthetic ledger fixtures.`;
    const changedFiles = Array.from({ length: 20 }, (_, index) => `packages/ledger/src/receipt-${index}.ts`);
    vi.setSystemTime(Date.now() + 60_000);
    const finalized = store.finalizeSession({
      projectRoot,
      idempotencyKey: "response-size-update-receipts",
      title: "Settle fictional ledger rounding before the update receipts",
      summary: `${sentence("settlement rounding")} ${sentence("ledger panel")}`,
      workSummary: {
        outcomes: [sentence("rounding"), sentence("panel totals")],
        scope: [sentence("storage scope")],
        decisions: [sentence("rounding decision")],
        verification: [sentence("unit test"), sentence("typecheck")],
        nextSteps: [],
      },
      changedFiles,
      changedFilesProvenance: changedFiles.map((path) => ({ path, sources: ["agent", "git"] })),
      verification: { status: "passed", summary: "Synthetic unit tests and typecheck passed." },
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected the update receipt source Session.");
    const sessionId = finalized.session.id;
    const workSummary = {
      outcomes: [sentence("corrected rounding"), sentence("corrected panel totals")],
      scope: [sentence("corrected storage scope")],
      decisions: [{ text: sentence("corrected rounding decision"), origin: "user_requested" }],
      verification: [sentence("corrected unit test")],
      nextSteps: [],
    };
    const calls = [
      {
        operation: "work_update_session_metadata",
        args: { sessionId, changedFiles, verification: { status: "passed", summary: "Re-ran the synthetic suite." } },
        outcome: "updated",
        echoed: [changedFiles[5]!],
      },
      {
        operation: "work_update_session_summary",
        args: { sessionId, idempotencyKey: "response-size-summary-receipt", summary: sentence("corrected summary") },
        outcome: "summary_updated",
        echoed: [sentence("corrected summary"), sentence("settlement rounding")],
      },
      {
        operation: "work_update_session_title",
        args: { sessionId, title: "Settle fictional ledger rounding after the correction" },
        outcome: "title_updated",
        echoed: ["Settle fictional ledger rounding after the correction"],
      },
      {
        operation: "work_update_session_work_summary",
        args: { sessionId, idempotencyKey: "response-size-work-summary-receipt", mode: "replace", workSummary },
        outcome: "work_summary_updated",
        echoed: [sentence("corrected rounding"), sentence("rounding"), sentence("corrected rounding decision")],
      },
    ];
    const sizes: Record<string, number> = {};
    for (const call of calls) {
      vi.setSystemTime(Date.now() + 60_000);
      const result = await client.callTool({
        name: "work_write_overwrite",
        arguments: { operation: call.operation, arguments: call.args },
      });
      expect(result.isError, call.operation).not.toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === "text",
      )!.text!;
      const value = JSON.parse(text) as { outcome: string; session: Record<string, unknown> };
      sizes[call.operation] = text.length;
      expect(text.length, call.operation).toBeLessThanOrEqual(RESPONSE_BUDGETS.sessionUpdateReceipt);
      expect(value.outcome).toBe(call.outcome);
      expect(value.session).toMatchObject({ id: sessionId, verificationStatus: "passed", changedFilesCount: 20 });
      expect(Object.keys(value.session).sort()).toEqual(
        ["changedFilesCount", "completedAt", "executionStatus", "id", "updatedAt", "verificationStatus"].sort(),
      );
      expect(result.structuredContent).toMatchObject({ sessionId, verification: { status: "passed" } });
      // Nothing the Agent sent or read before is echoed back, and paths stay project-relative.
      for (const echoed of call.echoed) expect(text, call.operation).not.toContain(echoed);
      expect(text).not.toContain(projectRoot);
    }
    console.info(`Session update receipt sizes (characters): ${JSON.stringify(sizes)}`);
    // Storage and REST keep the complete result.
    expect(store.getSessionDetail(sessionId)?.session).toMatchObject({
      title: "Settle fictional ledger rounding after the correction",
      summary: sentence("corrected summary"),
      workSummary: { decisions: [sentence("corrected rounding decision")] },
    });
  });

  it("bounds cleanup reads while retaining all selected item and later Session IDs", async () => {
    const { client, projectId, projectRoot, store } = await connectWithSyntheticHistory();

    const longItem = `Verify this synthetic cleanup obligation against later source Sessions. ${"bounded item evidence ".repeat(160)}`;
    vi.setSystemTime(Date.now() + 60_000);
    const additionalSource = store.finalizeSession({
      projectRoot,
      idempotencyKey: "response-size-cleanup-additional-source",
      title: `Long cleanup snapshot source ${"source title detail ".repeat(14)}`,
      summary: "Synthetic source Session adding the fifth cleanup snapshot item.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: ["The synthetic cleanup source is valid."],
        nextSteps: [longItem],
      },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (additionalSource.outcome !== "finalized") {
      throw new Error(`Expected the fifth cleanup source; received ${additionalSource.outcome}.`);
    }

    const laterSessionIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const source = store.finalizeSession({
        projectRoot,
        idempotencyKey: `response-size-cleanup-later-source-${index}`,
        title: `Later cleanup evidence ${index} ${"long source title detail ".repeat(12)}`,
        summary: `Synthetic later cleanup evidence summary ${"verified bounded context detail ".repeat(90)}`,
        workSummary: {
          outcomes: Array.from(
            { length: 20 },
            (_, outcomeIndex) =>
              `Verified cleanup outcome ${outcomeIndex + 1} ${"supporting evidence detail ".repeat(80)}`,
          ),
          scope: [],
          decisions: [],
          verification: ["The later evidence Session is synthetic and finalized."],
          nextSteps: [],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (source.outcome !== "finalized") {
        throw new Error(`Expected later cleanup evidence Session ${index}; received ${source.outcome}.`);
      }
      laterSessionIds.push(source.session.id);
      for (let pullRequest = 0; pullRequest < 4; pullRequest += 1) {
        const attached = store.attachEvidence({
          sessionId: source.session.id,
          kind: "pull_request",
          reference: `https://github.com/example/cleanup-fixture/pull/${index * 10 + pullRequest + 1}`,
          summary: "Synthetic later-session pull request pointer.",
        });
        if (attached.outcome !== "evidence_attached") {
          throw new Error(`Expected synthetic PR evidence; received ${attached.outcome}.`);
        }
      }
    }

    vi.setSystemTime(Date.now() + 60_000);
    const created = store.createOutstandingCleanupRequest({
      projectId,
      idempotencyKey: "response-size-cleanup-request",
    });
    if (created.outcome !== "outstanding_cleanup_request_created") {
      throw new Error(`Expected a cleanup request; received ${created.outcome}.`);
    }
    const directContext = store.getOutstandingCleanupContext({
      requestId: created.request.id,
      itemPage: 1,
      itemPageSize: 5,
      sessionPage: 1,
      sessionPageSize: 10,
    });
    if (directContext.outcome !== "outstanding_cleanup_context") {
      throw new Error("Expected bounded direct cleanup context.");
    }
    expect(directContext.items).toHaveLength(5);
    expect(directContext.sessions).toHaveLength(10);
    expect(directContext.sessions.map((session) => session.id)).toEqual(laterSessionIds.slice().reverse());
    expect(directContext.sessions.every((session) => session.pullRequests.length > 0)).toBe(true);
    expect(directContext.sessions.every((session) => session.pullRequestsOmitted > 0)).toBe(true);
    expect(directContext.truncated).toBe(true);

    const requestsPayload = await serializedMcpPayload(client, "work_list_outstanding_cleanup_requests", {
      projectId,
      status: "pending",
      page: 1,
      pageSize: 5,
    });
    const requests = requestsPayload.value as {
      requests: Array<{ id: string; itemCount: number; status: string }>;
      pageInfo: { total: number };
    };
    expect(requestsPayload.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingCleanupRequestPage);
    expect(requests.pageInfo.total).toBe(1);
    expect(requests.requests).toEqual([
      expect.objectContaining({ id: created.request.id, itemCount: 5, status: "pending" }),
    ]);

    const genericContext = await serializedMcpPayload(client, "work_get_context", {
      projectRoot,
      task: query,
    });
    const genericContextValue = genericContext.value as {
      pendingRequests: { outstandingCleanup?: Array<{ id: string; itemCount: number; status: string }> };
    };
    expect(genericContext.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithOutstandingCleanup);
    expect(genericContextValue.pendingRequests.outstandingCleanup).toEqual([
      expect.objectContaining({ id: created.request.id, itemCount: 5, status: "pending" }),
    ]);

    const contextPayload = await serializedMcpPayload(client, "work_get_outstanding_cleanup_context", {
      requestId: created.request.id,
      itemPage: 1,
      itemPageSize: 5,
      sessionPage: 1,
      sessionPageSize: 10,
    });
    const context = contextPayload.value as typeof directContext;
    expect(contextPayload.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingCleanupContext);
    expect(context.items.map((item) => item.id)).toEqual(directContext.items.map((item) => item.id));
    expect(context.sessions.map((session) => session.id)).toEqual(directContext.sessions.map((session) => session.id));
    expect(context.itemPageInfo).toMatchObject({ pageSize: 5, total: 5, hasNext: false });
    expect(context.sessionPageInfo.pageSize).toBe(10);
    expect(context.sessions).toHaveLength(10);
    expect(context.sessions.every((session) => session.pullRequests.length > 0)).toBe(true);
    expect(context.items.some((item) => item.textTruncated || item.sourceSessionTitleTruncated)).toBe(true);
    expect(
      context.sessions.some(
        (session) => session.titleTruncated || session.summaryTruncated || session.outcomesTruncated,
      ),
    ).toBe(true);
    expect(context.truncated).toBe(true);
    expect(contextPayload.length).toBeGreaterThan(15_000);
    console.info(`Max MCP cleanup evidence context size: ${contextPayload.length} UTF-16 code units`);

    const submitted = store.submitOutstandingCleanupProposals({
      requestId: created.request.id,
      idempotencyKey: "response-size-cleanup-submission",
      examinedItemIds: directContext.items.map((item) => item.id),
      proposals: directContext.items.map((item) => ({
        itemId: item.id,
        status: "completed",
        reason: "Synthetic response-size proposal backed by a later same-project source Session.",
        evidenceSessionIds: [laterSessionIds[0]!],
      })),
    });
    if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") {
      throw new Error(`Expected cleanup proposals; received ${submitted.outcome}.`);
    }
    const proposals = store.listOutstandingCleanupProposals({ requestId: created.request.id, pageSize: 100 });
    if (proposals.outcome !== "outstanding_cleanup_proposals") {
      throw new Error("Expected a synthetic cleanup proposal page.");
    }
    expect(JSON.stringify(proposals).length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingCleanupProposalPage);
    expect(proposals.proposals).toHaveLength(5);
    expect(proposals.proposals.every((proposal) => proposal.evidenceSessionIds.length === 1)).toBe(true);
  });

  it("rejects imported cleanup context when preserving a long source identity exceeds the response budget", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-long-cleanup-identity-"));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const source = new WorkIntelligenceStore(":memory:");
    const imported = new WorkIntelligenceStore(":memory:");
    cleanups.push(
      () => source.close(),
      () => imported.close(),
    );

    const project = source.addProject("Synthetic Long Identity Project", projectRoot);
    source.updateProject(project.id, { status: "tracked" });
    const finalized = source.finalizeSession({
      projectRoot,
      idempotencyKey: "long-cleanup-identity-source",
      title: "Synthetic long identity source",
      summary: "Fictional source for cleanup response-budget coverage.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: ["The synthetic long-identity fixture is valid."],
        nextSteps: ["Preserve the complete source identity in cleanup context."],
      },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (finalized.outcome !== "finalized") {
      throw new Error(`Expected the synthetic source Session; received ${finalized.outcome}.`);
    }
    const created = source.createOutstandingCleanupRequest({
      projectId: project.id,
      idempotencyKey: "long-cleanup-identity-request",
    });
    if (created.outcome !== "outstanding_cleanup_request_created") {
      throw new Error(`Expected the synthetic cleanup request; received ${created.outcome}.`);
    }

    const longSessionId = `synthetic-session-${"identity-".repeat(3_000)}`;
    const bundle = structuredClone(source.exportProjectData({ type: "project", projectId: project.id }));
    for (const rows of Object.values(bundle.tables)) {
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (value === finalized.session.id) (row as Record<string, unknown>)[key] = longSessionId;
        }
      }
    }
    expect(longSessionId.length).toBeGreaterThan(RESPONSE_BUDGETS.outstandingCleanupContext);
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    imported.importProjectData({ bundle });
    imported.updateProject(project.id, { status: "tracked" });

    const importedDb = (imported as unknown as { db: DatabaseSync }).db;
    expect(
      importedDb
        .prepare(
          `SELECT ci.source_session_id, s.id AS session_id
           FROM outstanding_cleanup_request_items ci
           JOIN sessions s ON s.id = ci.source_session_id AND s.project_id = ci.project_id
           WHERE ci.request_id = ?`,
        )
        .get(created.request.id),
    ).toEqual({ source_session_id: longSessionId, session_id: longSessionId });

    const server = createWorkIntelligenceMcpServer(imported, "0.1.0-test", LATEST_SCHEMA_VERSION);
    const client = new Client({ name: "long-cleanup-identity-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const context = await serializedMcpPayload(client, "work_get_outstanding_cleanup_context", {
      requestId: created.request.id,
      itemPage: 1,
      itemPageSize: 5,
      sessionPage: 1,
      sessionPageSize: 10,
    });
    expect(context.value).toMatchObject({
      outcome: "rejected",
      reason: "context_too_large",
      requestId: created.request.id,
    });
    expect(context.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingCleanupContext);
  });

  it("preserves long imported item text while bounding MCP pages", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-legacy-item-response-size-"));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const source = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => source.close());
    const imported = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => imported.close());
    const roundTrip = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => roundTrip.close());

    const project = source.addProject("Synthetic Legacy Items", projectRoot);
    source.updateProject(project.id, { status: "tracked" });
    for (let index = 0; index < 5; index += 1) {
      const result = source.finalizeSession({
        projectRoot,
        idempotencyKey: `legacy-item-response-session-${index}`,
        title: `Synthetic legacy item source ${index}`,
        summary: `Saved fictional source Session ${index}.`,
        workSummary: {
          outcomes: [`Saved fictional source Session ${index}.`],
          scope: [],
          decisions: [],
          verification: ["The synthetic source record is valid."],
          nextSteps: ["Short source text before portable import."],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") {
        throw new Error(`Expected synthetic source Session ${index}; received ${result.outcome}.`);
      }
    }

    const fullText = `Imported legacy open-item text. ${"This verified source-linked item remains complete in storage. ".repeat(80)}`;
    expect(fullText.length).toBeGreaterThan(4_000);
    const bundle = structuredClone(source.exportProjectData({ type: "project", projectId: project.id }));
    for (const item of bundle.tables.outstanding_items) {
      item.text = fullText;
      const session = bundle.tables.sessions.find((row) => row.id === item.source_session_id);
      if (!session) throw new Error("Expected a source Session for every synthetic outstanding item.");
      session.work_summary_json = JSON.stringify({
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [fullText],
      });
    }
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    imported.importProjectData({ bundle });
    imported.updateProject(project.id, { status: "tracked" });

    const importedItems = imported.listOutstandingItems({ projectRoot });
    if (importedItems.outcome !== "outstanding_items") {
      throw new Error("Expected imported synthetic outstanding items.");
    }
    expect(importedItems.items).toHaveLength(5);
    expect(importedItems.items.every((item) => item.text === fullText)).toBe(true);

    const importedBundle = imported.exportProjectData({ type: "project", projectId: project.id });
    expect(importedBundle.tables.outstanding_items.every((item) => item.text === fullText)).toBe(true);
    roundTrip.importProjectData({ bundle: importedBundle });
    roundTrip.updateProject(project.id, { status: "tracked" });
    const roundTrippedItems = roundTrip.listOutstandingItems({ projectRoot });
    if (roundTrippedItems.outcome !== "outstanding_items") {
      throw new Error("Expected round-tripped synthetic outstanding items.");
    }
    expect(roundTrippedItems.items.every((item) => item.text === fullText)).toBe(true);

    const server = createWorkIntelligenceMcpServer(roundTrip, "0.1.0-test", LATEST_SCHEMA_VERSION);
    const client = new Client({ name: "legacy-item-response-size-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const page = await serializedMcpPayload(client, "work_list_outstanding_items", { projectRoot, pageSize: 5 });
    const payload = page.value as {
      items: Array<{ text: string; textTruncated?: boolean }>;
      pageInfo: { total: number };
    };
    expect(payload.pageInfo.total).toBe(5);
    expect(payload.items).toHaveLength(5);
    expect(
      payload.items.every(
        (item) => item.text.length === 4_000 && item.text.endsWith("…") && item.textTruncated === true,
      ),
    ).toBe(true);
    expect(page.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingItemsPage);
  });

  it("bounds oversized serialized metadata and marks shortened display fields", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-oversized-item-metadata-"));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const store = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => store.close());
    const project = store.addProject("Synthetic Metadata Project", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    const fullText = "L".repeat(4_000);

    for (let index = 0; index < 5; index += 1) {
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `oversized-metadata-session-${index}`,
        title: `Synthetic metadata source ${index}`,
        summary: `Saved fictional source Session ${index}.`,
        workSummary: {
          outcomes: [],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: [fullText],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") {
        throw new Error(`Expected synthetic metadata source ${index}; received ${result.outcome}.`);
      }
    }

    const oversizedMetadata = `"\\\n`.repeat(12_000);
    const database = (store as unknown as { db: DatabaseSync }).db;
    database.prepare("UPDATE projects SET name = ? WHERE id = ?").run(oversizedMetadata, project.id);
    database.prepare("UPDATE sessions SET title = ? WHERE project_id = ?").run(oversizedMetadata, project.id);

    const server = createWorkIntelligenceMcpServer(store, "0.1.0-test", LATEST_SCHEMA_VERSION);
    const client = new Client({ name: "oversized-item-metadata-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    const page = await serializedMcpPayload(client, "work_list_outstanding_items", { projectRoot, pageSize: 5 });
    const payload = page.value as {
      items: Array<{
        projectName: string;
        projectNameTruncated?: boolean;
        sourceSessionTitle: string;
        sourceSessionTitleTruncated?: boolean;
        text: string;
        textTruncated?: boolean;
      }>;
    };

    expect(page.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.outstandingItemsPage);
    expect(payload.items).toHaveLength(5);
    expect(
      payload.items.every(
        (item) =>
          item.text.length <= fullText.length &&
          (item.text.length === fullText.length
            ? item.textTruncated === undefined
            : item.text.endsWith("…") && item.textTruncated === true),
      ),
    ).toBe(true);
    expect(
      payload.items.every(
        (item) =>
          item.projectName.length < oversizedMetadata.length &&
          item.projectNameTruncated === true &&
          item.sourceSessionTitle.length < oversizedMetadata.length &&
          item.sourceSessionTitleTruncated === true,
      ),
    ).toBe(true);
  });

  it("keeps cited-source review pointers bounded while preserving omitted counts and reasons", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const listed = store.listKnowledgePages({ projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected synthetic Knowledge pages.");
    const page = listed.items.find((item) => item.slug === "architecture");
    if (!page) throw new Error("Expected the synthetic architecture page.");
    const sourceSessionIds = store.listSessions().map((session) => session.id);
    expect(sourceSessionIds).toHaveLength(20);

    const rewritten = store.updateKnowledgePage({
      pageId: page.id,
      sections: [
        { heading: "Kestrel source audit", content: "Kestrel source audit: " + pageContent, sourceSessionIds },
      ],
    });
    expect(rewritten.outcome).toBe("knowledge_page_updated");
    for (const [index, sessionId] of sourceSessionIds.entries()) {
      vi.setSystemTime(Date.now() + 60_000);
      const updated = store.updateSessionSummary({
        sessionId,
        idempotencyKey: `response-size-cited-source-correction-${index}`,
        summary: `${longSummary} Source correction ${index} needs a Knowledge page review.`,
      });
      expect(updated.outcome).toBe("summary_updated");
    }

    const defaultContext = await serializedMcpPayload(client, "work_get_context", { projectRoot });
    const taskContext = await serializedMcpPayload(client, "work_get_context", {
      projectRoot,
      task: "Kestrel",
    });
    console.info(
      `Cited-source review response sizes (characters): ${JSON.stringify({
        contextWithoutTask: defaultContext.length,
        contextWithTask: taskContext.length,
      })}`,
    );
    expect(defaultContext.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithoutTask);
    expect(taskContext.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    const defaultPages = (defaultContext.value as { knowledgePages: Array<Record<string, unknown>> }).knowledgePages;
    expect(defaultPages).toContainEqual(
      expect.objectContaining({
        slug: "architecture",
        needsReview: true,
        reviewSections: [
          expect.objectContaining({
            heading: "Kestrel source audit",
            sources: expect.arrayContaining([
              expect.objectContaining({
                sourceSessionId: sourceSessionIds[0],
                reasons: ["source_updated_after_save"],
              }),
            ]),
            omittedSourceCount: 12,
          }),
        ],
      }),
    );
    const relevantPages = (
      taskContext.value as {
        relevant?: { knowledgePages?: Array<{ needsReview?: boolean; sections: Array<Record<string, unknown>> }> };
      }
    ).relevant?.knowledgePages;
    expect(relevantPages?.some((item) => item.needsReview)).toBe(true);
    expect(relevantPages?.flatMap((item) => item.sections)).toContainEqual(
      expect.objectContaining({
        heading: "Kestrel source audit",
        reviewOmittedSourceCount: 12,
        reviewReasons: ["source_updated_after_save"],
      }),
    );
    // Omission pointers name a page and its flag only; review detail stays with work_get_knowledge_page_context.
    const taskOmitted = (taskContext.value as { omitted?: Array<{ section: string; entries?: unknown[] }> }).omitted;
    const serializedOmitted = JSON.stringify(taskOmitted ?? []);
    expect(serializedOmitted).not.toContain("reviewSections");
    expect(serializedOmitted).not.toContain("sourceSessionIds");
    expect(serializedOmitted.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextOmitted);
    // The matched page is counted as shown; the other pages keep only their id and review flag.
    const pageOmission = taskOmitted?.find((section) => section.section === "knowledgePages");
    expect(pageOmission).toMatchObject({ duplicates: 1 });
    expect(pageOmission?.entries).toHaveLength(2);
    expect(pageOmission?.entries).toEqual(
      expect.arrayContaining([
        { id: "pitfalls", needsReview: true },
        { id: "response-budget", needsReview: true },
      ]),
    );
  });

  it("names a projectRoot scope once instead of on every item", async () => {
    const { client, projectId, projectRoot, store } = await connectWithSyntheticHistory();
    // Storage canonicalizes the root (lowercase on Windows), so compare with the stored value.
    const storedRoot = store.listProjects().find((project) => project.id === projectId)?.rootPath;
    const emptySearch = await serializedMcpPayload(client, "work_search_knowledge", {
      projectRoot,
      q: "zzyzxquux",
    });
    const sessionPage = await serializedMcpPayload(client, "work_list_sessions", { projectRoot });
    const outstandingPage = await serializedMcpPayload(client, "work_list_outstanding_items", { projectRoot });
    const recall = await serializedMcpPayload(client, "work_recall", { projectRoot, q: retrievalQuery });
    const context = await serializedMcpPayload(client, "work_get_context", { projectRoot });
    console.info(
      `Scoped response sizes (characters): ${JSON.stringify({
        knowledgeSearchEmpty: emptySearch.length,
        sessionListScoped: sessionPage.length,
      })}`,
    );

    expect(emptySearch.value).toEqual({
      outcome: "knowledge",
      project: { id: projectId, name: "Synthetic Cedar", rootPath: storedRoot },
      match: "none",
      items: [],
      pageInfo: expect.objectContaining({ total: 0 }),
      hint: expect.stringContaining("work_recall"),
    });
    // The temp root differs in length per OS, so the empty-answer budget leaves the echoed root out.
    expect(emptySearch.length - (storedRoot?.length ?? 0)).toBeLessThanOrEqual(RESPONSE_BUDGETS.knowledgeSearchEmpty);
    expect(sessionPage.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.sessionListScoped);
    for (const [name, payload, key] of [
      ["work_list_sessions", sessionPage, "items"],
      ["work_list_outstanding_items", outstandingPage, "items"],
      ["work_recall", recall, "hits"],
    ] as const) {
      const value = payload.value as Record<string, unknown> & { project?: unknown };
      expect(value.project, name).toEqual({ id: projectId, name: "Synthetic Cedar" });
      const items = value[key] as Array<Record<string, unknown>>;
      expect(items.length, name).toBeGreaterThan(0);
      expect(
        items.some((item) => "projectId" in item || "projectName" in item),
        name,
      ).toBe(false);
    }
    const contextValue = context.value as {
      project: { id: string };
      projects: unknown[];
      recentSessions: Array<Record<string, unknown>>;
      recentKnowledge: Array<Record<string, unknown>>;
      pendingOutstandingItems: Array<Record<string, unknown>>;
    };
    expect(contextValue.project.id).toBe(projectId);
    expect(contextValue.projects).toEqual([]);
    for (const item of [
      ...contextValue.recentSessions,
      ...contextValue.recentKnowledge,
      ...contextValue.pendingOutstandingItems,
    ]) {
      expect(item).not.toHaveProperty("projectId");
      expect(item).not.toHaveProperty("projectName");
    }
  });

  it("answers a missed Knowledge page lookup with bounded retry hints", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const listed = store.listKnowledgePages({ projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected synthetic Knowledge pages.");
    const architecture = listed.items.find((page) => page.slug === "architecture")!;

    const byId = await serializedMcpPayload(client, "work_get_knowledge_page_context", {
      projectRoot,
      slug: architecture.id,
    });
    const typo = await serializedMcpPayload(client, "work_get_knowledge_page_context", {
      projectRoot,
      slug: "pitfall",
    });
    expect(byId.value).toEqual({
      outcome: "not_found",
      slug: architecture.id,
      reasonCode: "page_id_as_slug",
      reason: expect.stringContaining('slug "architecture"'),
      suggestedSlug: "architecture",
      existingSlugs: ["architecture", "pitfalls", "response-budget"],
    });
    expect(typo.value).toMatchObject({ reasonCode: "slug_near_match", suggestedSlug: "pitfalls" });
    // The cause lands in the read audit as a code; the outcome stays not_found.
    expect(
      store
        .listAgentReads({})
        .items.filter((read) => read.tool === "work_get_knowledge_page_context")
        .map(({ outcome, errorCode }) => ({ outcome, errorCode })),
    ).toEqual([
      { outcome: "not_found", errorCode: "slug_near_match" },
      { outcome: "not_found", errorCode: "page_id_as_slug" },
    ]);
    expect(byId.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.knowledgePageNotFound);
    expect(typo.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.knowledgePageNotFound);
  });

  it("bounds Knowledge page context Sessions while keeping every id a page section may cite", async () => {
    const { client, store, projectRoot } = await connectWithSyntheticHistory();
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const payload = await serializedMcpPayload(client, "work_get_knowledge_page_context", {
      projectRoot,
      slug: "architecture",
    });
    const context = payload.value as {
      mode: string;
      page: { sections: Array<{ sourceSessionIds: string[] }> };
      sessions: Array<{ id: string; workSummary: Record<string, string[]>; summary?: string }>;
      omittedSessionFields: string[];
      sessionReadWith: string;
      truncated: boolean;
      instructions?: string;
    };
    console.info(`[response-size] knowledge page context: ${payload.length} characters`);
    expect(payload.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.knowledgePageContext);
    expect(context.mode).toBe("full");
    expect(context.instructions).toBeUndefined();
    expect(context.sessionReadWith).toBe("work_get_session");
    expect(context.omittedSessionFields).toEqual(["summary", "workSummary.scope", "workSummary.verification"]);
    // All 20 fixture Sessions fit, and the current page keeps the ids its sections cite.
    expect(context.truncated).toBe(false);
    expect(context.sessions).toHaveLength(20);
    expect(context.page.sections[0]!.sourceSessionIds).toHaveLength(1);
    for (const session of context.sessions) {
      expect(session.summary).toBeUndefined();
      expect(Object.keys(session.workSummary).sort()).toEqual(["decisions", "nextSteps", "outcomes"]);
    }
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: "response-size-page-cites-context",
      sections: [
        {
          heading: "Agent context retrieval budget",
          content: "Cites every Session of the context and the current page.",
          sourceSessionIds: [
            ...new Set([
              ...context.sessions.map((session) => session.id),
              ...context.page.sections[0]!.sourceSessionIds,
            ]),
          ],
        },
      ],
    });
    expect(saved.outcome).toBe("knowledge_page_saved");
  });

  it("keeps a relaxed Knowledge search answer within its budget and audits how it was answered", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const relaxed = await serializedMcpPayload(client, "work_search_knowledge", {
      projectRoot,
      q: "retrieval budget zzyzxquux",
    });
    const strict = await serializedMcpPayload(client, "work_search_knowledge", {
      projectRoot,
      q: "retrieval budget",
      pageSize: 1,
    });
    console.info(`Relaxed Knowledge search size (characters): ${relaxed.length}`);

    const value = relaxed.value as {
      match: string;
      items: unknown[];
      relaxedMatches: Array<{ id: string; matchedTerms: string[]; projectId?: string }>;
    };
    expect(value).toMatchObject({ outcome: "knowledge", match: "relaxed", items: [] });
    expect(value.relaxedMatches).toHaveLength(3);
    for (const match of value.relaxedMatches) {
      expect(match.matchedTerms).toEqual(["retrieval", "budget"]);
      expect(match).not.toHaveProperty("projectId");
      expect(match).not.toHaveProperty("body");
    }
    expect(relaxed.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.knowledgeSearchRelaxed);
    expect(strict.value).toMatchObject({ match: "strict", pageInfo: { total: 4 } });

    const reads = store.listAgentReads({}).items.filter((read) => read.tool === "work_search_knowledge");
    expect(reads.map(({ outcome, errorCode }) => ({ outcome, errorCode }))).toEqual([
      { outcome: "knowledge_strict", errorCode: undefined },
      { outcome: "knowledge_relaxed", errorCode: undefined },
    ]);
    // The relaxed records were returned to the Agent, so the audit lists them although the scoped items omit projectId.
    expect(reads[1]!.knowledgeIds.sort()).toEqual(value.relaxedMatches.map((match) => match.id).sort());
  });

  it("bounds a long file history at the default size and keeps its totals complete", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const files = [
      "packages/example-lamp/src/beam.ts",
      "packages/example-lamp/src/lens.ts",
      "packages/example-lamp/src/wick.ts",
    ];
    for (let index = 0; index < 30; index += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `response-size-history-${index}`,
        title: `Agent context retrieval budget history ${index} ${"with a long fictional title ".repeat(4)}`,
        summary: longSummary,
        workSummary: {
          outcomes: [`Completed fictional history fixture ${index}.`],
          scope: [],
          decisions: [longDecision, longDecision, longDecision],
          verification: [],
          nextSteps: [longOpenItem, longOpenItem, longOpenItem],
        },
        changedFiles: files,
        verification: { status: index % 4 === 0 ? "failed" : index % 4 === 1 ? "not_run" : "passed" },
      });
      if (result.outcome !== "finalized") throw new Error(`Expected history Session ${index} to finalize.`);
    }

    const one = await serializedMcpPayload(client, "work_get_file_history", { projectRoot, paths: [files[0]] });
    const three = await serializedMcpPayload(client, "work_get_file_history", { projectRoot, paths: files });
    const widest = await serializedMcpPayload(client, "work_get_file_history", {
      projectRoot,
      paths: [files[0]],
      limit: 10,
    });
    console.info(
      `File history size (characters): one path ${one.length}, three paths ${three.length}, limit 10 ${widest.length}`,
    );

    expect(one.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.fileHistoryOnePath);
    expect(widest.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.fileHistoryOnePath);
    expect(three.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.fileHistoryThreePaths);
    const value = one.value as {
      files: Array<{ totals: { sessions: number; pendingItems: number }; recent: unknown[]; attention: unknown[] }>;
    };
    expect(value.files[0]!.totals).toMatchObject({ sessions: 30, pendingItems: 90 });
    expect(value.files[0]!.recent.length).toBeGreaterThan(0);
    expect(value.files[0]!.attention.length).toBeGreaterThan(0);
  });

  it("lists each changed path once in the handoff view Agents are steered to", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const paths = Array.from({ length: 30 }, (_, index) => `packages/cedar/src/module-${index}/service.ts`);
    const finalized = store.finalizeSession({
      projectRoot,
      idempotencyKey: "response-size-thirty-files",
      title: "Synthetic thirty-file refactor",
      summary: "Refactored thirty fictional modules.",
      workSummary: {
        outcomes: ["Refactored thirty fictional modules."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: paths,
      changedFilesProvenance: paths.map((path) => ({ path, sources: ["agent", "git"], references: ["abc1234"] })),
      changedFileChanges: paths.map((path, index) =>
        index === 0
          ? { path, status: "renamed", previousPath: "packages/cedar/src/legacy/service.ts" }
          : { path, status: "modified" },
      ),
      verification: { status: "passed" },
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected the thirty-file synthetic Session.");
    const full = await serializedMcpPayload(client, "work_get_session", { sessionId: finalized.session.id });
    const handoff = await serializedMcpPayload(client, "work_get_session", {
      sessionId: finalized.session.id,
      view: "handoff",
    });
    console.info(`Session read size (characters): full ${full.length}, handoff view ${handoff.length}`);

    const value = handoff.value as { session: { files?: Array<Record<string, unknown>>; changedFiles?: unknown } };
    expect(value.session).not.toHaveProperty("changedFiles");
    // Storage records a rename's old path as a changed file too, so it gets an entry of its own.
    expect(value.session.files?.map((file) => file.path)).toEqual([...paths, "packages/cedar/src/legacy/service.ts"]);
    expect(value.session.files?.[0]).toEqual({
      path: paths[0],
      status: "renamed",
      previousPath: "packages/cedar/src/legacy/service.ts",
      sources: ["agent", "git"],
      references: ["abc1234"],
    });
    const text = JSON.stringify(handoff.value);
    for (const path of paths) expect(text.split(`"${path}"`)).toHaveLength(2);
    expect(handoff.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.sessionHandoffThirtyFiles);
    expect(handoff.length).toBeLessThan(full.length * 0.6);
  });

  it("keeps pending requests and Knowledge review flags within the focused context budget", async () => {
    const { client, projectRoot, store } = await connectWithSyntheticHistory();
    const knowledgeResult = store.searchKnowledge({ projectRoot, status: "active", limit: 20 });
    if (knowledgeResult.outcome !== "knowledge") throw new Error("Expected active synthetic Knowledge.");
    const contradictedKnowledge = knowledgeResult.items[0];
    if (!contradictedKnowledge) throw new Error("Expected a synthetic Knowledge to contradict.");

    const contradiction = store.finalizeSession({
      projectRoot,
      idempotencyKey: "response-size-contradiction",
      title: "Agent context retrieval budget contradiction review",
      summary: "The prior retrieval-budget Knowledge needs review after a confirmed contradiction.",
      workSummary: {
        outcomes: ["Flagged contradicted Knowledge for review."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      contradictedKnowledgeIds: [contradictedKnowledge.id],
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (contradiction.outcome !== "finalized") throw new Error("Expected the contradiction Session to finalize.");

    const staleKnowledge = store.recordKnowledge({
      projectRoot,
      idempotencyKey: "response-size-stale-knowledge",
      kind: "gotcha",
      title: "Agent context retrieval budget stale path",
      body: "Review this retrieval budget rule after the source file changes.",
      tags: ["agent", "context", "retrieval", "budget"],
      appliesTo: ["packages/context-budget-fixture.ts"],
    });
    if (staleKnowledge.outcome !== "knowledge_recorded") throw new Error("Expected stale-marker Knowledge to record.");

    vi.setSystemTime(Date.now() + 60_000);
    const pathChange = store.finalizeSession({
      projectRoot,
      idempotencyKey: "response-size-stale-path-change",
      title: "Agent context retrieval budget path change",
      summary: "Changed the synthetic path covered by the retrieval-budget Knowledge.",
      workSummary: {
        outcomes: ["Changed the synthetic path covered by the Knowledge rule."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: ["packages/context-budget-fixture.ts"],
      verification: { status: "passed" },
    });
    if (pathChange.outcome !== "finalized") throw new Error("Expected the path-change Session to finalize.");

    const candidateRequest = store.requestKnowledgeCandidates(projectRoot);
    if (candidateRequest.outcome !== "knowledge_candidate_request") {
      throw new Error("Expected a pending Knowledge-candidate request.");
    }

    const payload = await serializedMcpPayload(client, "work_get_context", {
      projectRoot,
      task: query,
      paths: ["packages/context-budget-fixture.ts"],
    });
    const context = payload.value as {
      pendingRequests: { knowledgeCandidates: unknown[] };
      relevant?: { knowledge?: Array<{ id: string; needsReview?: boolean; possiblyStale?: unknown }> };
      omitted?: Array<{
        readWith: string;
        entries?: Array<{ id: string; needsReview?: boolean; possiblyStale?: unknown }>;
      }>;
    };
    expect(payload.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    expect(context.pendingRequests.knowledgeCandidates).toHaveLength(1);
    const knowledgeEntries = [
      ...(context.relevant?.knowledge ?? []),
      ...(context.omitted ?? []).flatMap((section) => section.entries ?? []),
    ];
    expect(knowledgeEntries).toContainEqual(
      expect.objectContaining({ id: contradictedKnowledge.id, needsReview: true }),
    );
    expect(knowledgeEntries).toContainEqual(
      expect.objectContaining({ id: staleKnowledge.knowledge.id, possiblyStale: true }),
    );
    expect(context.omitted?.some((section) => section.readWith === "work_search_knowledge")).toBe(true);
  });
});

describe("Agent report response budgets", () => {
  it("includes runtime status in the complete context response budget", async () => {
    const status = {
      restartRequired: false,
      monitoringAvailable: true,
      updateAvailable: true,
      message: "Synthetic compatible runtime update. ".repeat(100),
    };
    const { client, store, projectId } = await connectWithSyntheticHistory(() => status);
    const request = store.createReportSynthesisRequest({ period: "week", date: "2026-09-01", projectId });
    if (request.outcome !== "report_synthesis_request") throw new Error("Missing request");
    const response = await client.callTool({
      name: "work_write_idempotent",
      arguments: {
        operation: "work_get_report_context",
        arguments: { requestId: request.request.id, maxCharacters: 12_000 },
      },
    });
    expect(response.isError).not.toBe(true);
    const raw = (response.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(raw.length).toBeLessThanOrEqual(12_000);
    const result = JSON.parse(raw);
    expect(result.server).toEqual(status);
    expect(result.projection.maxCharacters).toBe(12_000);
    expect(result.report.totals.sessions).toBe(20);
    expect(result.coverage.requestedSessions).toBe(20);
  });

  it("bounds report and fixed-source context, preserves totals, exposes omissions, and retains explicit full reads", async () => {
    const { client, store, projectId, projectRoot } = await connectWithSyntheticHistory();
    const source = store.finalizeSession({
      projectRoot,
      idempotencyKey: "long-report-source",
      title: "Long synthetic source",
      summary: "Long fixture evidence. ".repeat(200),
      completedAt: "2026-09-01T12:00:00Z",
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (source.outcome !== "finalized") throw new Error("Missing long source");
    store.attachEvidence({
      sessionId: source.session.id,
      kind: "test",
      reference: "synthetic-reference",
      summary: "Long fixture evidence. ".repeat(200),
    });
    const query = { period: "week", date: "2026-09-01", projectId };
    const full = await serializedMcpPayload(client, "work_get_report", { ...query, view: "full" });
    for (const maxCharacters of [12_000, 24_000, 60_000]) {
      const compact = await serializedMcpPayload(client, "work_get_report", { ...query, maxCharacters });
      expect(compact.length).toBeLessThanOrEqual(maxCharacters);
      const result = compact.value as {
        totals: unknown;
        sessions: unknown[];
        completedWork?: unknown;
        projection: { previewOnly: boolean };
      };
      expect(result.totals).toEqual((full.value as { totals: unknown }).totals);
      expect(result.completedWork).toBeUndefined();
      expect(result.projection.previewOnly).toBe(true);
    }
    expect(full.length).toBeGreaterThan(24_000);
    const requested = store.createReportSynthesisRequest(query as never);
    if (requested.outcome !== "report_synthesis_request") throw new Error("Missing request");
    const requestId = requested.request.id;
    async function context(view: "agent" | "full", maxCharacters = 12_000) {
      const response = await client.callTool({
        name: "work_write_idempotent",
        arguments: {
          operation: "work_get_report_context",
          arguments: { requestId, view, maxCharacters },
        },
      });
      expect(response.isError).not.toBe(true);
      const raw = (response.content as Array<{ type: string; text: string }>)[0]!.text;
      return { raw, value: JSON.parse(raw) };
    }
    const compact = await context("agent");
    expect(compact.raw.length).toBeLessThanOrEqual(12_000);
    expect(compact.value.report.sessions).toBeUndefined();
    expect(compact.value.report.completedWork).toBeUndefined();
    expect(compact.value.handoffSummaries).toBeUndefined();
    expect(compact.value.coverage.requestedSessions).toBe(21);
    expect(compact.value.projection.budgetOmitted.evidence).toBeGreaterThan(0);
    const original = await context("full");
    expect(original.value.report.sessions).toHaveLength(21);
    expect(original.value.handoffSummaries.length).toBeGreaterThan(0);
    expect(store.getSessionDetail(source.session.id)?.session.summary).toBe("Long fixture evidence. ".repeat(200));
    const defaultView = await serializedMcpPayload(client, "work_get_report", query);
    expect(defaultView.length).toBeLessThanOrEqual(24_000);
    expect((defaultView.value as { projection: { view: string } }).projection.view).toBe("agent");
    store.cancelReportSynthesisRequest(requestId);
    const cancelled = await context("agent");
    expect(cancelled.value.outcome).toBe("report_synthesis_request_not_ready");
    expect(cancelled.value.sourceSessionCount).toBe(21);
    expect(cancelled.value.request.sourceSessionIds).toBeUndefined();
    expect(cancelled.raw.length).toBeLessThanOrEqual(12_000);
  });
  it("sends the report block once, then only each Session page with its evidence", async () => {
    const { client, store, projectId } = await connectWithSyntheticHistory();
    const request = store.createReportSynthesisRequest({ period: "week", date: "2026-09-01", projectId });
    if (request.outcome !== "report_synthesis_request") throw new Error("Missing request");
    const requestId = request.request.id;
    async function page(sessionPage: number) {
      const response = await client.callTool({
        name: "work_write_idempotent",
        arguments: {
          operation: "work_get_report_context",
          arguments: {
            requestId,
            sessionPage,
            maxSessions: 5,
          },
        },
      });
      expect(response.isError).not.toBe(true);
      const raw = (response.content as Array<{ type: string; text: string }>)[0]!.text;
      return { raw, value: JSON.parse(raw) };
    }
    const first = await page(1);
    expect(first.raw.length).toBeLessThanOrEqual(24_000);
    expect(first.value.reportBlockOnSessionPage).toBeUndefined();
    expect(first.value.report.totals.sessions).toBe(20);
    expect(first.value.report.projects[0]).toMatchObject({ sessionCount: 20, sourceSessionIdsOmittedCount: 12 });
    expect(first.value.report.projects[0].sourceSessionIds).toHaveLength(8);
    const block = JSON.stringify(first.value.report).length - JSON.stringify(first.value.report.evidence).length;
    console.info(`[response-size] report block: ${block} characters, sent once instead of on 4 pages`);
    expect(block).toBeGreaterThan(1_500);
    const seen = new Set<string>(first.value.sessions.map((session: { id: string }) => session.id));
    for (const sessionPage of [2, 3, 4]) {
      const later = await page(sessionPage);
      expect(later.raw.length).toBeLessThanOrEqual(24_000);
      expect(later.value.reportBlockOnSessionPage).toBe(1);
      expect(Object.keys(later.value.report).sort()).toEqual(["evidence", "evidencePageInfo"]);
      // Apart from the evidence of its own Sessions, a later page carries only page info of the report.
      expect(
        JSON.stringify(later.value.report).length - JSON.stringify(later.value.report.evidence).length,
      ).toBeLessThan(250);
      for (const session of later.value.sessions) seen.add(session.id);
    }
    expect(seen.size).toBe(20);
    // A direct read of page 1 (a resumed Agent) returns the same block again.
    expect((await page(1)).value.report).toEqual(first.value.report);
  });
});

describe("Pending report source pointers", () => {
  it("keeps the context budget when a request imported a large source-id list", async () => {
    const { client, store, projectId, projectRoot } = await connectWithSyntheticHistory();
    const request = store.createReportSynthesisRequest({ period: "week", date: "2026-09-01", projectId });
    if (request.outcome !== "report_synthesis_request") throw new Error("Missing request");
    const ids = Array.from({ length: 5_000 }, (_, i) => `fictional-import-source-${i.toString().padStart(5, "0")}`);
    // Imported snapshots can contain unavailable IDs. Only pointers are exposed here; source policy is checked in context/full reads.
    (store as unknown as { db: DatabaseSync }).db
      .prepare("UPDATE report_synthesis_requests SET source_session_ids_json=? WHERE id=?")
      .run(JSON.stringify(ids), request.request.id);
    const payload = await serializedMcpPayload(client, "work_get_context", {
      projectRoot,
      task: "agent context retrieval budget",
    });
    expect(payload.length).toBeLessThanOrEqual(10_000);
    const pending = (
      payload.value as {
        pendingRequests: {
          reportSynthesis: Array<{ sourceSessionIds: string[]; sourceSessionIdsOmittedCount: number }>;
        };
      }
    ).pendingRequests.reportSynthesis[0]!;
    expect(pending.sourceSessionIds).toEqual(ids.slice(0, 5));
    expect(pending.sourceSessionIdsOmittedCount).toBe(4_995);
    expect(store.getReportSynthesisRequest(request.request.id)).toMatchObject({ request: { sourceSessionIds: ids } });
  });
});
