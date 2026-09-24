import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "./server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-test-"));
  const store = new WorkIntelligenceStore(":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9");
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

async function callJson<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as T;
}

function finalizePayload(root: string, key: string, title: string) {
  return {
    projectRoot: root,
    idempotencyKey: key,
    title,
    summary: `${title} summary.`,
    workSummary: { outcomes: [`${title} done.`], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["src/a.ts"],
    verification: { status: "passed" },
  };
}

describe("Work Intelligence MCP server", () => {
  it("advertises version, short instructions, annotations, and prompts", async () => {
    const { client } = await connect();

    expect(client.getServerVersion()).toMatchObject({ name: "work-intelligence", version: "9.9.9" });
    // Clients truncate long instructions; routing text must stay well under a few KB.
    expect(client.getInstructions()?.length ?? 0).toBeLessThan(2_500);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "work_get_project_status",
      "work_get_session",
      "work_list_sessions",
      "work_request_report_synthesis",
      "work_request_metadata_backfill",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
    expect(byName.get("work_search")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get("work_update_session_summary")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    // Contracts are attached only to the tools that write the governed data.
    const withReportContract = tools.filter((tool) => tool.description?.includes("Report synthesis contract v3"));
    expect(withReportContract.map((tool) => tool.name).sort()).toEqual([
      "work_get_report_context",
      "work_save_report_summary",
    ]);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["finalize-work", "synthesize-report"]);
  });

  it("reports project status and lists, reads, and scopes Sessions", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("MCP project", root);

    expect(await callJson(client, "work_get_project_status", { projectRoot: root })).toMatchObject({
      outcome: "project_status",
      projectStatus: "unregistered",
      tracked: false,
    });
    store.updateProject(project.id, { status: "tracked" });
    expect(await callJson(client, "work_get_project_status", { projectRoot: root })).toMatchObject({
      tracked: true,
      projectStatus: "tracked",
      project: { id: project.id },
    });

    const finalized = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-list-001", "First"),
    );
    await callJson(client, "work_finalize_session", finalizePayload(root, "mcp-list-002", "Second"));

    const list = await callJson<{ items: Array<{ title: string }>; pageInfo: { total: number } }>(
      client,
      "work_list_sessions",
      { projectRoot: root, pageSize: 1 },
    );
    expect(list.pageInfo.total).toBe(2);
    expect(list.items).toHaveLength(1);
    expect(await callJson(client, "work_list_sessions", { q: "First" })).toMatchObject({
      items: [{ title: "First" }],
    });

    const detail = await callJson(client, "work_get_session", { sessionId: finalized.session.id });
    expect(detail).toMatchObject({
      outcome: "session_detail",
      session: { id: finalized.session.id, workSummary: { outcomes: ["First done."] } },
    });
    expect(await callJson(client, "work_get_session", { sessionId: "missing" })).toMatchObject({
      outcome: "not_found",
    });

    store.updateProject(project.id, { status: "paused" });
    expect(await callJson(client, "work_get_session", { sessionId: finalized.session.id })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
    expect(await callJson(client, "work_list_sessions", { projectRoot: root })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });

  it("lets an Agent create report and metadata requests that show up in context", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Request project", root);
    store.updateProject(project.id, { status: "tracked" });
    await callJson(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-request-001", "Needs metadata"),
      changedFiles: [],
      verification: { status: "not_run" },
    });

    const report = await callJson<{ outcome: string; request: { id: string; projectId?: string } }>(
      client,
      "work_request_report_synthesis",
      { projectRoot: root, period: "week" },
    );
    expect(report).toMatchObject({ outcome: "report_synthesis_request", request: { projectId: project.id } });

    const backfill = await callJson<{ outcome: string }>(client, "work_request_metadata_backfill", {
      projectRoot: root,
    });
    expect(backfill.outcome).toBe("metadata_backfill_request");

    const context = await callJson<{
      pendingRequests: { reportSynthesis: Array<{ id: string }>; metadataBackfill: unknown[] };
    }>(client, "work_get_context", { projectRoot: root });
    expect(context.pendingRequests.reportSynthesis.map((request) => request.id)).toEqual([report.request.id]);
    expect(context.pendingRequests.metadataBackfill).toHaveLength(1);

    const otherRoot = join(root, "other");
    expect(
      await callJson(client, "work_request_report_synthesis", { projectRoot: otherRoot, period: "week" }),
    ).toMatchObject({ outcome: "skipped", projectStatus: "unregistered" });
  });

  it("recalls Sessions and Knowledge and focuses context on a task and paths", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Recall project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-recall-001", "Greenhouse humidity sensor"),
      changedFiles: ["src/sensors/humidity.ts"],
    });
    await callJson(client, "work_record_knowledge", {
      projectRoot: root,
      idempotencyKey: "mcp-recall-knowledge",
      kind: "gotcha",
      title: "Humidity sensor drifts after restart",
      body: "Recalibrate before reading.",
    });

    const recall = await callJson<{ outcome: string; hits: Array<{ type: string; id: string }> }>(
      client,
      "work_recall",
      { q: "humidity sensor", projectRoot: root },
    );
    expect(recall.outcome).toBe("recall");
    expect(recall.hits.map((hit) => hit.type).sort()).toEqual(["knowledge", "session"]);

    const byPath = await callJson<{ hits: Array<{ id: string; matchedPaths?: string[] }> }>(client, "work_recall", {
      paths: [join(root, "src/sensors/humidity.ts")],
    });
    expect(byPath.hits[0]).toMatchObject({ id: finalized.session.id, matchedPaths: ["src/sensors/humidity.ts"] });

    const invalid = await client.callTool({ name: "work_recall", arguments: { projectRoot: root } });
    expect(invalid.isError).toBe(true);

    const context = await callJson<{ relevant?: { knowledge: unknown[]; sessions: Array<{ id: string }> } }>(
      client,
      "work_get_context",
      { projectRoot: root, task: "humidity drift", paths: ["src/sensors/humidity.ts"] },
    );
    expect(context.relevant?.knowledge).toHaveLength(1);
    expect(context.relevant?.sessions.map((session) => session.id)).toEqual([finalized.session.id]);
  });

  it("voids and restores a Session and evidence through MCP", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Void project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-void-001", "Test record"),
    );
    const sessionId = finalized.session.id;

    const missingReason = await client.callTool({ name: "work_void_session", arguments: { sessionId } });
    expect(missingReason.isError).toBe(true);

    expect(
      await callJson(client, "work_void_session", { sessionId, reason: "Recorded while testing the setup." }),
    ).toMatchObject({
      outcome: "session_void_updated",
      session: { voided: { reason: "Recorded while testing the setup." } },
    });
    expect(await callJson(client, "work_list_sessions", { projectRoot: root })).toMatchObject({ items: [] });
    expect(await callJson(client, "work_list_sessions", { projectRoot: root, voided: "only" })).toMatchObject({
      items: [{ id: sessionId }],
    });
    expect(await callJson(client, "work_void_session", { sessionId, voided: false })).toMatchObject({
      outcome: "session_void_updated",
      duplicate: false,
    });

    const evidence = await callJson<{ evidence: { id: string } }>(client, "work_attach_evidence", {
      sessionId,
      kind: "command",
      reference: "pnpm test",
    });
    expect(
      await callJson(client, "work_void_evidence", { evidenceId: evidence.evidence.id, reason: "Wrong command." }),
    ).toMatchObject({ outcome: "evidence_void_updated", evidence: { voided: { reason: "Wrong command." } } });
  });

  it("links Sessions at finalize and through work_link_sessions", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Link project", root);
    store.updateProject(project.id, { status: "tracked" });
    const plan = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-link-plan", "Plan"),
    );
    const build = await callJson<{ session: { id: string }; linkWarnings?: string[] }>(
      client,
      "work_finalize_session",
      {
        ...finalizePayload(root, "mcp-link-build", "Build"),
        parentSessionId: plan.session.id,
      },
    );
    expect(build.linkWarnings).toBeUndefined();
    expect(await callJson(client, "work_get_session", { sessionId: plan.session.id })).toMatchObject({
      links: [{ sessionId: build.session.id, relation: "continued_by" }],
    });

    expect(
      await callJson(client, "work_link_sessions", {
        sessionId: build.session.id,
        relatedSessionId: plan.session.id,
        linked: false,
      }),
    ).toMatchObject({ outcome: "session_link_updated", links: [] });
  });

  it("lets an Agent propose Knowledge candidates but not accept them", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Candidate project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-candidate-001", "Source"),
    );

    const request = await callJson<{ outcome: string; request: { id: string } }>(
      client,
      "work_request_knowledge_candidates",
      { projectRoot: root },
    );
    expect(request.outcome).toBe("knowledge_candidate_request");
    expect(await callJson(client, "work_get_knowledge_candidate_context", { projectRoot: root })).toMatchObject({
      outcome: "knowledge_candidate_context",
      sessions: [{ id: finalized.session.id }],
    });
    expect(
      await callJson(client, "work_submit_knowledge_candidates", {
        requestId: request.request.id,
        candidates: [
          {
            sourceSessionId: finalized.session.id,
            kind: "pattern",
            title: "Proposed pattern",
            body: "Body.",
            rationale: "Stated in the Session outcomes.",
          },
        ],
      }),
    ).toMatchObject({ outcome: "knowledge_candidates_submitted", candidates: [{ status: "proposed" }] });

    const { tools } = await client.listTools();
    expect(tools.some((tool) => /accept|decide/.test(tool.name))).toBe(false);
  });
});
