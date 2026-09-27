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
  contextWithTask: 12_000,
  recallDefault: 7_000,
  recallFive: 3_500,
  searchDefault: 8_000,
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

    const taskContext = store.getContext(projectRoot, { task: query });
    expect(taskContext.outcome).toBe("context");
    if (taskContext.outcome !== "context") throw new Error("Expected scoped task context.");
    expect(taskContext.knowledgePages).toHaveLength(0);
    expect(taskContext.relevant?.knowledgePages).toHaveLength(1);
    expect(taskContext.recentDecisions).toHaveLength(0);
    expect(taskContext.relevant?.decisions.length).toBeGreaterThan(0);
    expect(taskContext.relevant?.sessions.some((hit) => hit.title.endsWith("00"))).toBe(true);
    expect(taskContext.relevant?.sessions[0]?.excerpt).toContain("Check one more verified example");
    expect(taskContext.relevant?.knowledge.some((hit) => hit.title.includes("gotcha"))).toBe(true);
    expect(
      taskContext.relevant?.knowledgePages?.every((page) =>
        page.sections.every((section) => section.sourceSessionIds.length > 0),
      ),
    ).toBe(true);
    expect(taskContext.omitted?.some((section) => section.section === "recentSessions")).toBe(true);
    expect(taskContext.omitted?.some((section) => section.section === "knowledgePages")).toBe(true);

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
    expect(contextWithTask.length).toBeLessThan(contextWithoutTask.length);
    expect(recallDefault.length).toBeGreaterThan(0);
    expect(searchDefault.length).toBeGreaterThan(recallDefault.length);
    expect(recallFivePayload.hits).toHaveLength(5);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("03"))).toBe(true);
    expect(recallFivePayload.hits.some((hit) => hit.title.includes("gotcha"))).toBe(true);
    expect(recallFivePayload.hits.some((hit) => hit.related?.length === 3)).toBe(true);
    expect(relatedLinks.every((link) => link.id && link.relation && !link.title)).toBe(true);
    expect(recallFive.value).not.toHaveProperty("project");
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
        entries: Array<{ id: string; needsReview?: boolean; possiblyStale?: unknown }>;
      }>;
    };
    expect(payload.length).toBeLessThanOrEqual(RESPONSE_BUDGETS.contextWithTask);
    expect(context.pendingRequests.knowledgeCandidates).toHaveLength(1);
    const knowledgeEntries = [
      ...(context.relevant?.knowledge ?? []),
      ...(context.omitted ?? []).flatMap((section) => section.entries),
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
