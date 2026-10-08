import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import {
  getMcpRestartStatus,
  getMcpRuntimeDirectory,
  readMcpBuildIdentity,
} from "../../packages/shared/src/mcp-runtime.js";
import { createMcpRuntimeFixture, finalizeMcpRuntimeFixture } from "../helpers/mcp-runtime-fixture.js";

const cleanups: Array<() => Promise<void> | void> = [];
const TOOL_CONTRACT_RESOURCE_URI = "work-intelligence://agent/tool-contracts";
const DISPATCHER_EXPECTATIONS = {
  work_read: {
    title: "Read Work Intelligence",
    annotations: { title: "Read Work Intelligence", readOnlyHint: true, openWorldHint: false },
    operationCount: 20,
  },
  work_write_idempotent: {
    title: "Write Work Intelligence records",
    annotations: {
      title: "Write Work Intelligence records",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    operationCount: 16,
  },
  work_write_additive: {
    title: "Add Work Intelligence records or proposals",
    annotations: {
      title: "Add Work Intelligence records or proposals",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    operationCount: 4,
  },
  work_write_overwrite: {
    title: "Update or void Work Intelligence records",
    annotations: {
      title: "Update or void Work Intelligence records",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    operationCount: 9,
  },
} as const;

interface ToolContractCatalog {
  document: string;
  dispatchers: Map<string, string>;
  sections: Map<string, string>;
}

const toolContractCatalogs = new WeakMap<Client, Promise<ToolContractCatalog>>();

async function connect(
  getRestartStatus?: () => { restartRequired: boolean; monitoringAvailable: boolean; message?: string },
  fileBacked = false,
) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-test-"));
  const store = new WorkIntelligenceStore(fileBacked ? join(root, "work-intelligence.sqlite") : ":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION, undefined, getRestartStatus);
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

async function getToolContractCatalog(client: Client): Promise<ToolContractCatalog> {
  let pendingCatalog = toolContractCatalogs.get(client);
  if (!pendingCatalog) {
    pendingCatalog = (async () => {
      const readText = async (uri: string) => {
        const content = (await client.readResource({ uri })).contents[0];
        if (!content || !("text" in content)) throw new Error("The tool-contract resource must use text content.");
        return content.text;
      };
      const index = await readText(TOOL_CONTRACT_RESOURCE_URI);
      const operations = [...index.matchAll(/^- (work_\w+) → (work_\w+): /gm)].map((match) => match[1] ?? "");
      const sections = await Promise.all(
        operations.map((operation) => readText(`${TOOL_CONTRACT_RESOURCE_URI}/${operation}`)),
      );
      const dispatchers = new Map<string, string>();
      const operationSections = new Map<string, string>();

      for (const section of sections) {
        const operation = section.match(/^## (work_[^\n]+)/)?.[1];
        const dispatcher = section.match(/^Dispatcher: (work_[^\n]+)/m)?.[1];
        if (!operation || !dispatcher) throw new Error("A tool contract is missing its operation or dispatcher name.");
        dispatchers.set(operation, dispatcher);
        operationSections.set(operation, section);
      }
      return { document: sections.join("\n\n"), dispatchers, sections: operationSections };
    })();
    toolContractCatalogs.set(client, pendingCatalog);
  }
  return pendingCatalog;
}

async function callMcpOperation(client: Client, operation: string, args: Record<string, unknown>) {
  const dispatcher = (await getToolContractCatalog(client)).dispatchers.get(operation);
  if (!dispatcher) throw new Error(`No dispatcher is published for ${operation}.`);
  return client.callTool({ name: dispatcher, arguments: { operation, arguments: args } });
}

async function callJson<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await callMcpOperation(client, name, args);
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as T;
}

async function callReadOperation<T = Record<string, unknown>>(
  client: Client,
  operation: "work_get_project_status" | "work_get_context",
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name: "work_read", arguments: { operation, arguments: args } });
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content?.text ?? "null") as T;
}

async function operationAnnotations(client: Client, operation: string): Promise<Record<string, unknown>> {
  const section = (await getToolContractCatalog(client)).sections.get(operation);
  const annotations = section?.match(/^Annotations: (.+)$/m)?.[1];
  if (!annotations) throw new Error(`The ${operation} contract has no annotations.`);
  return JSON.parse(annotations) as Record<string, unknown>;
}

function finalizePayload(root: string, key: string, title: string) {
  return {
    projectRoot: root,
    idempotencyKey: key,
    title,
    summary: `${title} summary.`,
    workSummary: { outcomes: [`${title} done.`], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["src/a.ts"],
    verification: { status: "passed" as const },
  };
}

function reportSummaryPayload(requestId: string, sourceSessionIds: string[]) {
  return {
    requestId,
    title: "Synthetic weekly report",
    executiveSummary: "Verified synthetic report outcomes.",
    highlights: [{ title: "Synthetic outcome", detail: "Completed synthetic work.", sourceSessionIds }],
    risks: [],
    decisions: [],
    nextSteps: [],
    sourceSessionIds,
    generatedByAgent: "test-client",
    promptVersion: "report-synthesis-v3",
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("Work Intelligence MCP server", () => {
  it("completes the handshake and exposes classified database startup failures to the Agent", async () => {
    const startupFailure = {
      code: "DATABASE_SCHEMA_VERSION_TOO_NEW",
      message: "資料庫 schema 版本比此程式支援的版本新。請更新 Work Intelligence 後再開啟資料庫。",
    };
    const server = createWorkIntelligenceMcpServer(null, "9.9.9", LATEST_SCHEMA_VERSION, startupFailure);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    expect(client.getInstructions()).toContain(startupFailure.code);
    expect(client.getInstructions()).toContain(startupFailure.message);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(DISPATCHER_EXPECTATIONS).sort());

    const statusResult = await callMcpOperation(client, "work_get_project_status", { projectRoot: "/tmp" });
    const finalizeResult = await callMcpOperation(
      client,
      "work_finalize_session",
      finalizePayload("/tmp/startup-failure", "startup-failure-001", "Startup unavailable"),
    );
    const statusContent = statusResult.content as Array<{ type: string; text: string }>;
    const finalizeContent = finalizeResult.content as Array<{ type: string; text: string }>;
    expect(statusResult.isError).toBe(true);
    expect(finalizeResult.isError).toBe(true);
    expect(statusContent).toEqual(finalizeContent);
    expect(JSON.parse(statusContent[0]?.text ?? "null")).toEqual({
      code: startupFailure.code,
      error: startupFailure.message,
    });
    const skill = await client.readResource({ uri: "work-intelligence://agent/work-intelligence/SKILL.md" });
    expect(skill.contents[0]).toMatchObject({ mimeType: "text/markdown" });
  });

  it("continues finalizing through an old connection after a compatible implementation rebuild", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-runtime-install-"));
    createMcpRuntimeFixture(runtimeRoot);
    const startupBuild = readMcpBuildIdentity(runtimeRoot);
    if (!startupBuild) throw new Error("The synthetic MCP runtime has no build identity.");
    const { client, store, root } = await connect(() => getMcpRestartStatus(runtimeRoot, startupBuild));
    cleanups.push(() => rmSync(getMcpRuntimeDirectory(runtimeRoot), { recursive: true, force: true }));
    cleanups.push(() => rmSync(runtimeRoot, { recursive: true, force: true }));

    const currentStatus = await callReadOperation<{ server: { restartRequired: boolean } }>(
      client,
      "work_get_project_status",
      { projectRoot: root },
    );
    expect(currentStatus.server.restartRequired).toBe(false);

    writeFileSync(
      join(runtimeRoot, "packages/storage/dist/index.js"),
      'export const runtime = "storage-after-start";\n',
    );
    finalizeMcpRuntimeFixture(runtimeRoot);
    const projectStatus = await callReadOperation<{ server: { restartRequired: boolean; message: string } }>(
      client,
      "work_get_project_status",
      { projectRoot: root },
    );
    const context = await callReadOperation<{ server: { restartRequired: boolean; message: string } }>(
      client,
      "work_get_context",
      { projectRoot: root },
    );

    expect(projectStatus.server).toMatchObject({
      restartRequired: false,
      updateAvailable: true,
      message: expect.stringContaining("有新版可用"),
    });
    expect(context.server).toEqual(projectStatus.server);
    const project = store.addProject("Compatible rebuild", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ outcome: string; server: { updateAvailable: boolean } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "compatible-rebuild", "Compatible update"),
    );
    expect(finalized).toMatchObject({
      outcome: "finalized",
      server: { updateAvailable: true, restartRequired: false },
    });
  });

  it("records the connecting client name and the optional model on finalize without Agent input", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-agent-source-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => store.close());
    const project = store.addProject("Agent source", root);
    store.updateProject(project.id, { status: "tracked" });
    const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
    const client = new Client({ name: "fiction-agent-cli", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());

    type Finalized = { session: { agentClient?: string; agentModel?: string } };
    const withModel = await callJson<Finalized>(client, "work_finalize_session", {
      ...finalizePayload(root, "agent-source-1", "With model"),
      agentModel: "fiction-model-1",
    });
    expect(withModel.session).toMatchObject({ agentClient: "fiction-agent-cli", agentModel: "fiction-model-1" });
    const withoutModel = await callJson<Finalized>(
      client,
      "work_finalize_session",
      finalizePayload(root, "agent-source-2", "Without model"),
    );
    expect(withoutModel.session.agentClient).toBe("fiction-agent-cli");
    expect(withoutModel.session.agentModel).toBeUndefined();
  });

  it("rejects stale writes after another connection migrates the database even when local dist is unchanged", async () => {
    const { client, store, root } = await connect(() => ({ restartRequired: false, monitoringAvailable: true }), true);
    const project = store.addProject("Externally migrated", root);
    store.updateProject(project.id, { status: "tracked" });
    // The other connection migrates and then closes, as a newer MCP process would. Keeping it open while this
    // connection writes lets Windows file locking on the WAL index stall BEGIN IMMEDIATE for the busy timeout.
    const migrator = new DatabaseSync(store.databasePath);
    try {
      migrator.exec("BEGIN IMMEDIATE");
      migrator.exec("ALTER TABLE sessions ADD COLUMN future_format TEXT NOT NULL DEFAULT ''");
      migrator
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(LATEST_SCHEMA_VERSION + 1, "synthetic_future_migration", new Date().toISOString());
      migrator.exec("COMMIT");
    } finally {
      migrator.close();
    }
    const result = await callMcpOperation(
      client,
      "work_finalize_session",
      finalizePayload(root, "stale-writer", "Stale"),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}")).toMatchObject({
      code: "MCP_RESTART_REQUIRED",
      server: { restartRequired: true },
    });
    const reader = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      expect(reader.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(0);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM work_events").get()?.count).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("rejects every write dispatcher when the running MCP contract requires reconnection", async () => {
    const { client, store, root } = await connect(() => ({ restartRequired: true, monitoringAvailable: true }));
    const project = store.addProject("Contract update", root);
    store.updateProject(project.id, { status: "tracked" });
    const result = await callMcpOperation(
      client,
      "work_finalize_session",
      finalizePayload(root, "stale-contract", "Stale"),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}")).toMatchObject({
      code: "MCP_RESTART_REQUIRED",
    });
    expect(store.listSessions({ projectId: project.id })).toEqual([]);
  });

  it("returns a safe retryable error when another SQLite connection holds a write lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-busy-test-"));
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const project = store.addProject("Busy MCP project", root);
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

    const mcpDatabase = (store as unknown as { db: DatabaseSync }).db;
    mcpDatabase.exec("PRAGMA busy_timeout = 0");
    const lockConnection = new DatabaseSync(databasePath);
    lockConnection.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      const result = await callMcpOperation(
        client,
        "work_finalize_session",
        finalizePayload(root, "mcp-busy-lock", "Busy lock"),
      );
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "null";
      expect(result.isError).toBe(true);
      expect(JSON.parse(text)).toEqual({ code: "DATABASE_BUSY", error: "資料庫暫時忙碌，請稍後再試" });
      expect(text).not.toMatch(/sqlite|database is locked/i);
    } finally {
      lockConnection.exec("ROLLBACK");
      lockConnection.close();
    }

    expect(
      await callJson(client, "work_finalize_session", finalizePayload(root, "mcp-busy-lock", "Busy lock")),
    ).toMatchObject({
      outcome: "finalized",
    });
  });

  it("advertises version, short instructions, annotations, and prompts", async () => {
    const { client } = await connect();

    expect(client.getServerVersion()).toMatchObject({ name: "work-intelligence", version: "9.9.9" });
    expect(client.getInstructions()).toContain(`Application version: 9.9.9; schema version: ${LATEST_SCHEMA_VERSION}.`);
    // Clients truncate long instructions; routing text must stay well under a few KB.
    expect(client.getInstructions()?.length ?? 0).toBeLessThan(2_500);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(DISPATCHER_EXPECTATIONS).sort());
    for (const tool of tools) {
      const expected = DISPATCHER_EXPECTATIONS[tool.name as keyof typeof DISPATCHER_EXPECTATIONS];
      expect(tool.title, tool.name).toBe(expected.title);
      expect(tool.annotations, tool.name).toEqual(expected.annotations);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        properties: {
          operation: { type: "string", enum: expect.any(Array) },
          arguments: { type: "object" },
        },
        required: ["operation"],
      });
      const operationIds = (tool.inputSchema as { properties?: { operation?: { enum?: unknown[] } } }).properties
        ?.operation?.enum;
      expect(operationIds).toHaveLength(expected.operationCount);
      expect(new Set(operationIds).size).toBe(expected.operationCount);
    }
    // Contracts are attached only to the tools that write the governed data.
    const catalog = await getToolContractCatalog(client);
    const withReportContract = [...catalog.sections.entries()]
      .filter(([, section]) => section.includes("Report synthesis contract v3"))
      .map(([operation]) => operation);
    expect(withReportContract.sort()).toEqual(["work_get_report_context", "work_save_report_summary"]);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["finalize-work", "synthesize-report"]);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      TOOL_CONTRACT_RESOURCE_URI,
      "work-intelligence://agent/work-intelligence/SKILL.md",
      "work-intelligence://agent/work-record-and-report-format.md",
    ]);
    expect(client.getInstructions()).toContain("work-intelligence://agent/work-intelligence/SKILL.md");
  });

  it("saves and idempotently resubmits a report through the guarded MCP dispatcher", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Synthetic report project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession(finalizePayload(root, "report-source", "Synthetic report work"));
    if (finalized.outcome !== "finalized") throw new Error("Expected synthetic report source.");
    const created = await callJson<{ request: { id: string } }>(client, "work_request_report_synthesis", {
      period: "week",
      projectId: project.id,
      idempotencyKey: "guarded-report-request",
    });
    await callJson(client, "work_get_report_context", { requestId: created.request.id });
    const payload = reportSummaryPayload(created.request.id, [finalized.session.id]);

    const saved = await callJson<{ outcome: string; duplicate: boolean; summary: { id: string } }>(
      client,
      "work_save_report_summary",
      payload,
    );
    expect(saved).toMatchObject({ outcome: "report_summary_saved", duplicate: false });
    expect(store.getReportSynthesisRequest(created.request.id)).toMatchObject({
      request: { status: "completed" },
      summary: { id: saved.summary.id, sourceSessionIds: [finalized.session.id] },
    });
    expect(await callJson(client, "work_save_report_summary", payload)).toMatchObject({
      outcome: "report_summary_saved",
      duplicate: true,
      summary: { id: saved.summary.id },
    });
  });

  it("retries a cancelled report through the guarded MCP dispatcher", async () => {
    const { client, store } = await connect();
    const created = store.createReportSynthesisRequest({ period: "week", idempotencyKey: "guarded-report-retry" });
    if (created.outcome !== "report_synthesis_request") throw new Error("Expected synthetic report request.");
    store.cancelReportSynthesisRequest(created.request.id);

    const retried = await callJson<{ request: { id: string } }>(client, "work_retry_report_synthesis", {
      requestId: created.request.id,
    });
    expect(retried).toMatchObject({
      outcome: "report_synthesis_request_retried",
      previousRequestId: created.request.id,
      request: { status: "pending" },
    });
    expect(retried.request.id).not.toBe(created.request.id);
    expect(store.getReportSynthesisRequest(created.request.id)).toMatchObject({
      request: { status: "cancelled", failureReason: `Superseded by retry request ${retried.request.id}.` },
    });
  });

  it("rolls back a failed MCP report replacement and preserves the previous current summary", async () => {
    const { client, store, root } = await connect(undefined, true);
    const first = store.createReportSynthesisRequest({ period: "week", idempotencyKey: "report-before-failure" });
    if (first.outcome !== "report_synthesis_request") throw new Error("Expected synthetic report request.");
    const previous = store.saveReportSummary(reportSummaryPayload(first.request.id, []));
    if (previous.outcome !== "report_summary_saved") throw new Error("Expected synthetic report summary.");
    const replacement = store.createReportSynthesisRequest({ period: "week", idempotencyKey: "report-with-failure" });
    if (replacement.outcome !== "report_synthesis_request") throw new Error("Expected synthetic report request.");
    store.getReportSynthesisContext({ requestId: replacement.request.id });
    const connection = new DatabaseSync(join(root, "work-intelligence.sqlite"));
    cleanups.push(() => connection.close());
    connection.exec(`CREATE TRIGGER synthetic_report_failure BEFORE INSERT ON report_summaries
      BEGIN SELECT RAISE(ABORT, 'synthetic report insert failure'); END`);

    const failed = await callMcpOperation(
      client,
      "work_save_report_summary",
      reportSummaryPayload(replacement.request.id, []),
    );
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "synthetic report insert failure" }]);
    expect(store.getReportSynthesisRequest(replacement.request.id)).toMatchObject({
      request: { status: "processing" },
    });
    expect(store.listReportSummaries()).toMatchObject({ summaries: [{ id: previous.summary.id, isCurrent: true }] });
    connection.exec("DROP TRIGGER synthetic_report_failure");
    expect(
      await callJson(client, "work_save_report_summary", reportSummaryPayload(replacement.request.id, [])),
    ).toMatchObject({
      outcome: "report_summary_saved",
      duplicate: false,
    });
    expect(store.listReportSummaries()).toMatchObject({ summaries: [{ requestId: replacement.request.id }] });
  });

  it("serves the complete skill and supporting format contract as standard MCP resources", async () => {
    const { client } = await connect();

    const skill = await client.readResource({ uri: "work-intelligence://agent/work-intelligence/SKILL.md" });
    const format = await client.readResource({ uri: "work-intelligence://agent/work-record-and-report-format.md" });
    const catalog = await client.readResource({ uri: TOOL_CONTRACT_RESOURCE_URI });
    const skillContent = skill.contents[0];
    const formatContent = format.contents[0];
    const catalogContent = catalog.contents[0];
    if (
      !skillContent ||
      !("text" in skillContent) ||
      !formatContent ||
      !("text" in formatContent) ||
      !catalogContent ||
      !("text" in catalogContent)
    ) {
      throw new Error("Agent resources must use text content.");
    }
    const skillText = skillContent.text;
    const formatText = formatContent.text;
    const catalogText = catalogContent.text;

    expect(skillText).toContain("## Privacy and project policy");
    expect(skillText).toContain("work-intelligence://agent/work-record-and-report-format.md");
    expect(skillText).not.toContain("../../../docs/work-record-and-report-format.md");
    expect(skillText).toBe(
      readFileSync(new URL("../../.agents/skills/work-intelligence/SKILL.md", import.meta.url), "utf8"),
    );
    expect(formatText).toContain("# Work record and report format");
    expect(formatText).toContain("nextSteps");
    expect(formatText).toBe(
      readFileSync(new URL("../../docs/work-record-and-report-format.md", import.meta.url), "utf8"),
    );
    expect(catalogText).toContain("# Work Intelligence MCP operation index");
    expect(catalogText).toContain("- work_recall → work_read: Recall related work");
    expect(catalogText).not.toContain("Input schema");
    const recall = await client.readResource({ uri: `${TOOL_CONTRACT_RESOURCE_URI}/work_recall` });
    const recallText = (recall.contents[0] as { text?: string }).text ?? "";
    expect(recallText).toContain("## work_recall");
    expect(recallText).toContain("Dispatcher: work_read");
    expect(recallText).toContain("At least one of q or a non-empty paths array is required");
    await expect(client.readResource({ uri: `${TOOL_CONTRACT_RESOURCE_URI}/work_missing` })).rejects.toThrow();
    await expect(client.readResource({ uri: "work-intelligence://agent/missing.md" })).rejects.toThrow();
  });

  it("reads compiled agent resources when launched from an unrelated project directory", () => {
    const compiledServer = new URL("../../apps/mcp/dist/server.js", import.meta.url);
    if (!existsSync(fileURLToPath(compiledServer))) {
      throw new Error("Build the MCP server before running the compiled resource path test.");
    }
    const externalProject = mkdtempSync(join(tmpdir(), "unrelated-workspace-"));
    const requireFromMcp = createRequire(new URL("../../apps/mcp/package.json", import.meta.url));
    const clientModule = pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js")).href;
    const transportModule = pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/inMemory.js")).href;
    const script = [
      `import { createWorkIntelligenceMcpServer } from ${JSON.stringify(compiledServer.href)};`,
      `import { Client } from ${JSON.stringify(clientModule)};`,
      `import { InMemoryTransport } from ${JSON.stringify(transportModule)};`,
      "const server = createWorkIntelligenceMcpServer(null, 'test', 1, { code: 'TEST_UNAVAILABLE', message: 'test' });",
      "const client = new Client({ name: 'external-cwd-test', version: '1.0.0' });",
      "const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();",
      "await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);",
      "const { resources } = await client.listResources();",
      "const skill = await client.readResource({ uri: 'work-intelligence://agent/work-intelligence/SKILL.md' });",
      "const format = await client.readResource({ uri: 'work-intelligence://agent/work-record-and-report-format.md' });",
      "console.log(JSON.stringify({ resources: resources.map(({ uri }) => uri), skill: skill.contents[0], format: format.contents[0] }));",
      "await client.close();",
      "await server.close();",
    ].join("\n");

    try {
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: externalProject,
        encoding: "utf8",
        timeout: 15_000,
      });
      const result = JSON.parse(output) as {
        resources: string[];
        skill: { text?: string };
        format: { text?: string };
      };
      expect(result.resources).toContain("work-intelligence://agent/work-intelligence/SKILL.md");
      expect(result.skill.text).toBe(
        readFileSync(new URL("../../.agents/skills/work-intelligence/SKILL.md", import.meta.url), "utf8"),
      );
      expect(result.format.text).toBe(
        readFileSync(new URL("../../docs/work-record-and-report-format.md", import.meta.url), "utf8"),
      );
    } finally {
      rmSync(externalProject, { recursive: true, force: true });
    }
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
      clock: {
        serverTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        timeZone: expect.any(String),
        utcOffset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
      },
    });

    // An estimated local time written with Z lands in the future: the Agent gets the server time and what to do.
    const future = new Date(Date.now() + 8 * 3_600_000).toISOString();
    const rejected = await callMcpOperation(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-future-001", "Future"),
      completedAt: future,
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("after the server time");
    expect(store.listSessions({ voided: "include" }).some((session) => session.title === "Future")).toBe(false);

    const firstPayload = {
      ...finalizePayload(root, "mcp-list-001", "First"),
      summary: "A".repeat(450),
      workSummary: {
        outcomes: ["First done."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["unfinished ".repeat(30)],
      },
    };
    const finalized = await callJson<{ session: { id: string } }>(client, "work_finalize_session", firstPayload);
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

    const compact = await callJson<{
      items: Array<{
        title: string;
        summary: string;
        changedFilesCount: number;
        verificationStatus: string;
        openItems: string[];
        changedFiles?: unknown;
        workSummary?: unknown;
        events?: unknown;
      }>;
    }>(client, "work_list_sessions", { q: "First" });
    expect(compact.items[0]).toMatchObject({
      title: "First",
      changedFilesCount: 1,
      verificationStatus: "passed",
    });
    expect(compact.items[0]?.summary).toHaveLength(400);
    expect(compact.items[0]?.summary.endsWith("…")).toBe(true);
    expect(compact.items[0]?.openItems[0]).toHaveLength(200);
    expect(compact.items[0]).not.toHaveProperty("changedFiles");
    expect(compact.items[0]).not.toHaveProperty("workSummary");
    expect(compact.items[0]).not.toHaveProperty("events");

    const detail = await callJson(client, "work_get_session", { sessionId: finalized.session.id });
    expect(detail).toMatchObject({
      outcome: "session_detail",
      session: {
        id: finalized.session.id,
        changedFiles: ["src/a.ts"],
        workSummary: { outcomes: ["First done."] },
      },
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

  it("uses pending outstanding item state for paged Session digest open items", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Digest status project", root);
    store.updateProject(project.id, { status: "tracked" });
    const completedText = "This old nextSteps entry is already complete.";
    const notNeededText = "This old nextSteps entry is no longer needed.";
    const pendingText = "This remains open after review.";
    const voidedPendingText = "A voided source must not expose this item.";
    const source = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-digest-state-source", "Digest status source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created a source with mixed item states."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [completedText, notNeededText, pendingText],
      },
    });
    const voidedSource = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-digest-state-voided", "Voided digest source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created a source to void."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [voidedPendingText],
      },
    });
    const itemList = store.listOutstandingItems({ projectRoot: root, status: "pending", pageSize: 0 });
    if (itemList.outcome !== "outstanding_items") throw new Error("Expected pending source items.");
    const itemByText = new Map(itemList.items.map((item) => [item.text, item]));
    const completed = itemByText.get(completedText);
    const notNeeded = itemByText.get(notNeededText);
    const voidedPending = itemByText.get(voidedPendingText);
    if (!completed || !notNeeded || !voidedPending) throw new Error("Expected all synthetic source items.");
    store.updateOutstandingItemStatus(completed.id, "completed");
    store.updateOutstandingItemStatus(notNeeded.id, "not_needed");
    store.setSessionVoid({ sessionId: voidedSource.session.id, voided: true, reason: "Synthetic source correction." });

    const pendingBatch = vi.spyOn(store, "pendingOutstandingItemsForSessions");
    const listed = await callJson<{
      items: Array<{ id: string; title: string; openItems: string[] }>;
    }>(client, "work_list_sessions", { projectRoot: root, voided: "include", pageSize: 100 });
    expect(pendingBatch).toHaveBeenCalledTimes(1);
    expect(pendingBatch).toHaveBeenCalledWith(listed.items.map((session) => session.id));
    expect(listed.items.find((session) => session.id === source.session.id)?.openItems).toEqual([pendingText]);
    expect(listed.items.find((session) => session.id === voidedSource.session.id)?.openItems).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(completedText);
    expect(JSON.stringify(listed)).not.toContain(notNeededText);
    expect(JSON.stringify(listed)).not.toContain(voidedPendingText);
  });

  // File-backed SQLite store: under coverage on Windows this can exceed the default 5 s.
  it("caps outstanding item text at 4,000 UTF-16 code units without splitting a surrogate pair", async () => {
    const { client, store, root } = await connect(undefined, true);
    const project = store.addProject("Long outstanding text project", root);
    store.updateProject(project.id, { status: "tracked" });
    const source = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-long-outstanding-source", "Long outstanding source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created a source for response-boundary coverage."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["temporary source item"],
      },
    });
    const longText = `${"x".repeat(3_998)}😀tail`;
    const database = new DatabaseSync(store.databasePath);
    try {
      database
        .prepare("UPDATE outstanding_items SET text = ? WHERE source_session_id = ?")
        .run(longText, source.session.id);
    } finally {
      database.close();
    }

    const listed = await callJson<{
      items: Array<{ text: string; textTruncated?: boolean }>;
    }>(client, "work_list_outstanding_items", { projectRoot: root });
    expect(listed.items[0]?.text).toBe(`${"x".repeat(3_998)}…`);
    expect(listed.items[0]?.text.length).toBeLessThanOrEqual(4_000);
    expect(listed.items[0]?.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(listed.items[0]?.textTruncated).toBe(true);
  }, 15_000);

  it("routes cleanup reads and idempotent proposal submissions without changing item status", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("MCP cleanup proposal project", root);
    store.updateProject(project.id, { status: "tracked" });
    const source = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-cleanup-source", "Cleanup source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created the synthetic cleanup obligation."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["Verify the cleanup proposal remains only a proposal."],
      },
      completedAt: "2026-09-01T12:00:00.000Z",
    });
    const evidence = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-cleanup-evidence", "Cleanup evidence"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Verified the synthetic obligation."],
        scope: [],
        decisions: [],
        verification: ["The synthetic outcome was verified."],
        nextSteps: [],
      },
      completedAt: "2026-09-02T12:00:00.000Z",
    });
    const sourceItems = store.listOutstandingItems({ projectId: project.id, status: "pending", pageSize: 10 });
    if (sourceItems.outcome !== "outstanding_items" || sourceItems.items.length !== 1) {
      throw new Error("Expected one synthetic pending item.");
    }
    const itemId = sourceItems.items[0]!.id;
    const created = store.createOutstandingCleanupRequest({
      projectId: project.id,
      idempotencyKey: "mcp-cleanup-request",
    });
    if (created.outcome !== "outstanding_cleanup_request_created") throw new Error("Expected a cleanup request.");

    expect(await operationAnnotations(client, "work_list_outstanding_cleanup_requests")).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(await operationAnnotations(client, "work_get_outstanding_cleanup_context")).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(await operationAnnotations(client, "work_submit_outstanding_cleanup_proposals")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const listed = await callJson<{ outcome: string; requests: Array<{ id: string }> }>(
      client,
      "work_list_outstanding_cleanup_requests",
      { projectId: project.id, pageSize: 5 },
    );
    expect(listed).toMatchObject({ outcome: "outstanding_cleanup_requests", requests: [{ id: created.request.id }] });
    const context = await callJson<{
      outcome: string;
      items: Array<{ id: string; sourceSessionId: string; stale: boolean }>;
      sessions: Array<{ id: string }>;
    }>(client, "work_get_outstanding_cleanup_context", { requestId: created.request.id });
    expect(context).toMatchObject({
      outcome: "outstanding_cleanup_context",
      items: [expect.objectContaining({ id: itemId, sourceSessionId: source.session.id, stale: false })],
    });
    expect(context.sessions.map(({ id }) => id)).toContain(evidence.session.id);

    const unknownField = await callMcpOperation(client, "work_list_outstanding_cleanup_requests", {
      projectId: project.id,
      pageSize: 5,
      unexpectedFilter: true,
    });
    expect(unknownField.isError).toBe(true);
    expect(JSON.stringify(unknownField.content)).toContain("Unknown argument(s)");

    const beforeEvents = store.exportProjectData({ type: "project", projectId: project.id }).tables
      .outstanding_item_events;
    const proposalInput = {
      requestId: created.request.id,
      idempotencyKey: "mcp-cleanup-submit",
      examinedItemIds: [itemId],
      proposals: [
        {
          itemId,
          status: "completed",
          reason: "The later Session verifies the obligation was completed.",
          evidenceSessionIds: [evidence.session.id],
        },
      ],
    };
    const submitted = await callJson<{
      outcome: string;
      duplicate: boolean;
      proposalIds: string[];
      request: { status: string };
    }>(client, "work_submit_outstanding_cleanup_proposals", proposalInput);
    expect(submitted).toMatchObject({ outcome: "outstanding_cleanup_proposals_submitted", duplicate: false });
    const replay = await callJson<typeof submitted>(client, "work_submit_outstanding_cleanup_proposals", proposalInput);
    expect(replay).toMatchObject({ duplicate: true, proposalIds: submitted.proposalIds });
    const conflict = await callJson<{ outcome: string; reason: string }>(
      client,
      "work_submit_outstanding_cleanup_proposals",
      {
        ...proposalInput,
        proposals: [{ ...proposalInput.proposals[0]!, status: "not_needed" }],
      },
    );
    expect(conflict).toMatchObject({ outcome: "rejected", reason: "idempotency_conflict" });

    const afterItems = store.listOutstandingItems({ projectId: project.id, pageSize: 10 });
    expect(afterItems).toMatchObject({ items: [expect.objectContaining({ id: itemId, status: "pending" })] });
    expect(store.exportProjectData({ type: "project", projectId: project.id }).tables.outstanding_item_events).toEqual(
      beforeEvents,
    );
    expect(store.listOutstandingCleanupProposals({ requestId: created.request.id, pageSize: 10 })).toMatchObject({
      outcome: "outstanding_cleanup_proposals",
      proposals: [expect.objectContaining({ id: submitted.proposalIds[0], reviewStatus: "pending" })],
    });
  });

  it("lists tracked pending items read-only and finalizes only same-project pending item ids", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Outstanding item project", root);
    store.updateProject(project.id, { status: "tracked" });
    const otherRoot = join(root, "private-project");
    const otherProject = store.addProject("Private project name", otherRoot);
    store.updateProject(otherProject.id, { status: "tracked" });
    const ownText = "Finish the verified same-project follow-up.";
    const privateText = "Private project follow-up text must never appear in another scope.";

    const ownSource = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-outstanding-source-own", "Outstanding item source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Saved the synthetic source Session."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [ownText],
      },
    });
    const otherSource = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(otherRoot, "mcp-outstanding-source-other", "Private source title"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Saved the private synthetic source Session."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [privateText],
      },
    });

    const beforeItems = store.listOutstandingItems({ projectRoot: root });
    const beforeProjectRoots = store.listProjects().map(({ id, rootPath }) => ({ id, rootPath }));
    const listed = await callJson<{
      outcome: string;
      items: Array<{
        id: string;
        projectId: string;
        projectName: string;
        sourceSessionId: string;
        sourceSessionTitle: string;
        sourceSessionCompletedAt: string;
        text: string;
        status: string;
      }>;
      pageInfo: { total: number };
    }>(client, "work_list_outstanding_items", { projectRoot: root });
    expect(await operationAnnotations(client, "work_list_outstanding_items")).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(listed).toMatchObject({ outcome: "outstanding_items", pageInfo: { total: 1 } });
    expect(listed.items).toEqual([
      expect.objectContaining({
        projectId: project.id,
        projectName: "Outstanding item project",
        sourceSessionId: ownSource.session.id,
        sourceSessionTitle: "Outstanding item source",
        text: ownText,
        status: "pending",
      }),
    ]);
    expect(listed.items[0]?.sourceSessionCompletedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(listed)).not.toContain(privateText);
    expect(JSON.stringify(listed)).not.toContain("Private source title");
    expect(store.listOutstandingItems({ projectRoot: root })).toEqual(beforeItems);
    expect(store.listProjects().map(({ id, rootPath }) => ({ id, rootPath }))).toEqual(beforeProjectRoots);

    const untracked = await callJson<{ outcome: string; projectStatus: string }>(
      client,
      "work_list_outstanding_items",
      { projectRoot: join(root, "untracked") },
    );
    expect(untracked).toMatchObject({ outcome: "skipped", projectStatus: "unregistered" });
    expect(JSON.stringify(untracked)).not.toContain(ownText);
    expect(JSON.stringify(untracked)).not.toContain(privateText);

    const otherItem = store.listOutstandingItems({ projectRoot: otherRoot });
    if (otherItem.outcome !== "outstanding_items") throw new Error("Expected the private synthetic item.");
    const privateItemId = otherItem.items[0]?.id;
    const ownItemId = listed.items[0]?.id;
    if (!privateItemId || !ownItemId) throw new Error("Expected both synthetic item ids.");
    expect(otherItem.items[0]?.sourceSessionId).toBe(otherSource.session.id);

    const crossProject = await callJson<{
      outstandingItemWarnings: { unresolvedIds: string[]; message: string };
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-outstanding-cross-project", "Reject cross-project id"),
      resolvedOutstandingItemIds: [privateItemId],
    });
    expect(crossProject.outstandingItemWarnings).toMatchObject({ unresolvedIds: [privateItemId] });
    expect(crossProject.outstandingItemWarnings.message).toContain("未標記完成");
    expect(JSON.stringify(crossProject)).not.toContain(privateText);
    expect(JSON.stringify(crossProject)).not.toContain("Private source title");
    expect(JSON.stringify(crossProject)).not.toContain("Private project name");
    expect(JSON.stringify(crossProject)).not.toContain(otherProject.id);
    expect(JSON.stringify(crossProject)).not.toContain(otherSource.session.id);

    const missingId = "fictional-outstanding-item-does-not-exist";
    const nonexistent = await callJson<{
      outstandingItemWarnings: { unresolvedIds: string[]; message: string };
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-outstanding-nonexistent", "Reject nonexistent id"),
      resolvedOutstandingItemIds: [missingId],
    });
    expect(nonexistent.outstandingItemWarnings.unresolvedIds).toEqual([missingId]);
    expect(JSON.stringify(nonexistent)).not.toContain(privateText);
    expect(JSON.stringify(nonexistent)).not.toContain("Private source title");

    const resolved = await callJson<{
      outcome: string;
      resolvedOutstandingItemIds: string[];
      outstandingItemWarnings?: unknown;
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-outstanding-resolve-valid", "Resolve verified id"),
      resolvedOutstandingItemIds: [ownItemId],
    });
    expect(resolved).toMatchObject({ outcome: "finalized", resolvedOutstandingItemIds: [ownItemId] });
    expect(resolved).not.toHaveProperty("outstandingItemWarnings");
    expect(
      await callJson(client, "work_list_outstanding_items", { projectRoot: root, status: "pending" }),
    ).toMatchObject({ outcome: "outstanding_items", items: [], pageInfo: { total: 0 } });
    expect(
      await callJson<{ items: Array<{ id: string; text: string; status: string }> }>(
        client,
        "work_list_outstanding_items",
        { projectRoot: root, status: "completed" },
      ),
    ).toMatchObject({ items: [expect.objectContaining({ id: ownItemId, text: ownText, status: "completed" })] });

    const nonPending = await callJson<{
      outstandingItemWarnings: { unresolvedIds: string[]; message: string };
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-outstanding-non-pending", "Reject non-pending id"),
      resolvedOutstandingItemIds: [ownItemId],
    });
    expect(nonPending.outstandingItemWarnings.unresolvedIds).toEqual([ownItemId]);
    expect(JSON.stringify(nonPending)).not.toContain(ownText);
    expect(JSON.stringify(nonPending)).not.toContain("Private project follow-up");
  });

  // File-backed SQLite setup and this multi-write flow exceed 5 seconds under Windows coverage.
  it("surfaces related pending items and audits only explicit finalize supersessions", async () => {
    const { client, store, root } = await connect(undefined, true);
    const project = store.addProject("Encrypted cache work", root);
    store.updateProject(project.id, { status: "tracked" });
    const pausedRoot = `${root}-paused`;
    const pausedProject = store.addProject("Paused encrypted cache work", pausedRoot);
    store.updateProject(pausedProject.id, { status: "tracked" });

    const replacedText = "Replace the stale encrypted cache lookup with indexed pagination.";
    const remainingText = "Verify encrypted cache pagination after replacing the stale lookup.";
    const completedText = "Confirm encrypted cache backup compatibility already verified.";
    const notNeededText = "Check the encrypted cache legacy lock order no longer needed.";
    const voidedText = "Review the encrypted cache note from a voided source.";
    const pausedText = "Verify encrypted cache pagination in the paused workspace.";
    const guardText = "Rotate the synthetic integration key after each release.";

    const source = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-supersede-source", "Encrypted cache proposal"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created fictional encrypted cache follow-up items."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [replacedText, remainingText, completedText, notNeededText, guardText],
      },
    });
    const voidedSource = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-supersede-voided-source", "Voided encrypted cache source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created a source that will be voided."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [voidedText],
      },
    });
    await callJson(client, "work_finalize_session", {
      ...finalizePayload(pausedRoot, "mcp-supersede-paused-source", "Paused encrypted cache source"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Created a source in the workspace that will be paused."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [pausedText],
      },
    });

    const sourceItems = store.listOutstandingItems({ projectRoot: root, pageSize: 100 });
    const pausedItems = store.listOutstandingItems({ projectRoot: pausedRoot, pageSize: 100 });
    if (sourceItems.outcome !== "outstanding_items" || pausedItems.outcome !== "outstanding_items") {
      throw new Error("Expected synthetic pending items before changing their scope or status.");
    }
    const itemByText = new Map(sourceItems.items.map((item) => [item.text, item]));
    const replaced = itemByText.get(replacedText);
    const remaining = itemByText.get(remainingText);
    const completed = itemByText.get(completedText);
    const notNeeded = itemByText.get(notNeededText);
    const guard = itemByText.get(guardText);
    const pausedItem = pausedItems.items.find((item) => item.text === pausedText);
    if (!replaced || !remaining || !completed || !notNeeded || !guard || !pausedItem) {
      throw new Error("Expected each synthetic outstanding item to be present.");
    }
    expect(replaced.sourceSessionId).toBe(source.session.id);
    expect(remaining.sourceSessionId).toBe(source.session.id);
    expect(pausedItem.projectId).toBe(pausedProject.id);
    store.updateOutstandingItemStatus(completed.id, "completed");
    store.updateOutstandingItemStatus(notNeeded.id, "not_needed");
    store.setSessionVoid({
      sessionId: voidedSource.session.id,
      voided: true,
      reason: "Synthetic source correction.",
    });
    store.updateProject(pausedProject.id, { status: "paused" });

    const before = await callReadOperation<{
      relevant?: { outstandingItems?: { items: Array<{ id: string; text: string }>; total: number } };
    }>(client, "work_get_context", { task: "encrypted cache pagination stale lookup" });
    const relevantItems = before.relevant?.outstandingItems?.items ?? [];
    expect(before.relevant?.outstandingItems?.total).toBeGreaterThanOrEqual(2);
    expect(relevantItems.map((item) => item.id)).toEqual(expect.arrayContaining([replaced.id, remaining.id]));
    for (const excludedText of [completedText, notNeededText, voidedText, pausedText]) {
      expect(relevantItems.map((item) => item.text)).not.toContain(excludedText);
    }

    const replacementText = "Record the verified encrypted cache pagination result.";
    const replacementPayload = {
      ...finalizePayload(root, "mcp-supersede-replacement", "Encrypted cache pagination replacement"),
      summary: "Replaced the stale encrypted cache lookup after verifying pagination.",
      changedFiles: [],
      workSummary: {
        outcomes: ["Recorded the verified replacement."],
        scope: [],
        decisions: [],
        verification: ["The synthetic replacement was verified."],
        nextSteps: [replacementText],
      },
      supersededOutstandingItemIds: [replaced.id],
    };
    const finalized = await callJson<{
      duplicate?: boolean;
      session: { id: string };
      supersededOutstandingItemIds: string[];
      relatedOutstandingItems: { items: Array<{ id: string; text: string }>; total: number };
    }>(client, "work_finalize_session", replacementPayload);
    expect(finalized.supersededOutstandingItemIds).toEqual([replaced.id]);
    expect(finalized.relatedOutstandingItems.total).toBeGreaterThan(0);
    expect(finalized.relatedOutstandingItems.items.map((item) => item.id)).toContain(remaining.id);
    expect(finalized.relatedOutstandingItems.items.map((item) => item.id)).not.toContain(replaced.id);
    expect(finalized.relatedOutstandingItems.items.map((item) => item.text)).not.toContain(replacementText);

    const noReplacement = await callJson<{
      session: { id: string };
      supersededOutstandingItemIds: string[];
      outstandingItemWarnings?: { unsupersededIds?: string[] };
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-supersede-empty-nextsteps", "No replacement evidence"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Recorded a synthetic result without replacement nextSteps."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      supersededOutstandingItemIds: [guard.id],
    });
    expect(noReplacement.supersededOutstandingItemIds).toEqual([]);
    expect(noReplacement.outstandingItemWarnings?.unsupersededIds).toContain(guard.id);
    expect(store.listOutstandingItems({ projectRoot: root, pageSize: 100 })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: guard.id, status: "pending" })]),
    });

    const database = new DatabaseSync(store.databasePath);
    try {
      const targetEvents = database
        .prepare(
          `SELECT from_status AS fromStatus, to_status AS toStatus, source, actor_session_id AS actorSessionId
           FROM outstanding_item_events WHERE item_id = ? AND actor_session_id = ?`,
        )
        .all(replaced.id, finalized.session.id);
      expect(targetEvents).toEqual([
        {
          fromStatus: "pending",
          toStatus: "not_needed",
          source: "agent",
          actorSessionId: finalized.session.id,
        },
      ]);
      const guardEvents = database
        .prepare("SELECT COUNT(*) AS count FROM outstanding_item_events WHERE item_id = ? AND actor_session_id = ?")
        .get(guard.id, noReplacement.session.id) as { count: number };
      expect(guardEvents.count).toBe(0);

      const duplicate = await callJson<{
        duplicate: boolean;
        supersededOutstandingItemIds: string[];
      }>(client, "work_finalize_session", replacementPayload);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.supersededOutstandingItemIds).toEqual([replaced.id]);
      const eventsAfterDuplicate = database
        .prepare("SELECT COUNT(*) AS count FROM outstanding_item_events WHERE item_id = ? AND actor_session_id = ?")
        .get(replaced.id, finalized.session.id) as { count: number };
      expect(eventsAfterDuplicate.count).toBe(1);
    } finally {
      database.close();
    }
  }, 15_000);

  it("accepts at most 200 superseded outstanding item ids in the MCP schema", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Superseded item schema boundary", root);
    store.updateProject(project.id, { status: "tracked" });
    const maximumIds = Array.from({ length: 200 }, (_, index) => `missing-superseded-item-${index}`);
    const accepted = await callJson<{
      outcome: string;
      supersededOutstandingItemIds: string[];
      outstandingItemWarnings?: { unsupersededIds?: string[] };
    }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-supersede-schema-max", "Maximum superseded id list"),
      changedFiles: [],
      workSummary: {
        outcomes: ["Checked the synthetic MCP input boundary."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      supersededOutstandingItemIds: maximumIds,
    });
    expect(accepted).toMatchObject({
      outcome: "finalized",
      supersededOutstandingItemIds: [],
      outstandingItemWarnings: { unsupersededIds: maximumIds },
    });

    const rejected = await callMcpOperation(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-supersede-schema-over-max", "Too many superseded ids"),
      supersededOutstandingItemIds: [...maximumIds, "missing-superseded-item-200"],
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "{}")).toMatchObject({
      error: "Invalid finalize payload.",
    });
    expect(store.listSessions({ projectId: project.id })).toHaveLength(1);
  });

  it("lets an Agent create report and metadata requests that show up in context", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Request project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-request-001", "Needs metadata"),
      changedFiles: [],
      verification: { status: "not_run" },
      workSummary: {
        outcomes: ["Needs metadata done."],
        scope: [],
        decisions: [{ text: "MCP exposes only the pending count.", origin: "agent_autonomous" }],
        verification: [],
        nextSteps: [],
      },
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
      pendingRequests: {
        reportSynthesis: Array<{ id: string }>;
        metadataBackfill: unknown[];
        agentDecisions: number;
      };
    }>(client, "work_get_context", { projectRoot: root });
    expect(context.pendingRequests.reportSynthesis.map((request) => request.id)).toEqual([report.request.id]);
    expect(context.pendingRequests.metadataBackfill).toHaveLength(1);
    expect(context.pendingRequests.agentDecisions).toBe(1);
    expect(JSON.stringify(context.pendingRequests)).not.toContain("MCP exposes only the pending count.");
    expect(await callJson(client, "work_get_session", { sessionId: finalized.session.id })).toMatchObject({
      decisions: [
        {
          text: "MCP exposes only the pending count.",
          origin: "agent_autonomous",
          reviewStatus: "pending",
        },
      ],
    });

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

    const recall = await callJson<{
      outcome: string;
      confidence: string;
      hits: Array<{ type: string; id: string }>;
    }>(client, "work_recall", { q: "humidity sensor", projectRoot: root });
    expect(recall.outcome).toBe("recall");
    expect(recall.confidence).toBe("high");
    expect(recall.hits.map((hit) => hit.type).sort()).toEqual(["knowledge", "session"]);

    const byPath = await callJson<{
      confidence: string;
      hits: Array<{ id: string; matchedPaths?: string[] }>;
    }>(client, "work_recall", { paths: [join(root, "src/sensors/humidity.ts")] });
    expect(byPath.confidence).toBe("high");
    expect(byPath.hits[0]).toMatchObject({ id: finalized.session.id, matchedPaths: ["src/sensors/humidity.ts"] });

    const weak = await callJson<{ confidence: string; hits: unknown[] }>(client, "work_recall", {
      q: "interstellar humidity",
      projectRoot: root,
    });
    expect(weak.confidence).toBe("low");
    expect(weak.hits.length).toBeGreaterThan(0);

    const noRecallHits = await callJson<{ confidence: string; hits: unknown[] }>(client, "work_recall", {
      q: "interstellar quantum memory accelerator",
      projectRoot: root,
    });
    expect(noRecallHits).toMatchObject({ confidence: "none", hits: [] });

    const invalid = await callMcpOperation(client, "work_recall", { projectRoot: root });
    expect(invalid.isError).toBe(true);

    const pastRange = await callJson<{ confidence: string; hits: unknown[] }>(client, "work_recall", {
      q: "humidity sensor",
      projectRoot: root,
      from: "2000-01-01",
      to: "2000-01-31",
    });
    expect(pastRange.hits).toEqual([]);
    expect(pastRange.confidence).toBe("none");

    const search = await callJson<{
      outcome: string;
      confidence: string;
      hits: Array<{ id: string }>;
    }>(client, "work_search", { q: "humidity sensor", projectRoot: root });
    expect(search).toMatchObject({ outcome: "search", confidence: "high" });
    expect(search.hits[0]?.id).toBe(finalized.session.id);
    const noSearchHits = await callJson<{ confidence: string; hits: unknown[] }>(client, "work_search", {
      q: "interstellar quantum memory accelerator",
      projectRoot: root,
    });
    expect(noSearchHits).toMatchObject({ confidence: "none", hits: [] });

    const reversed = await callMcpOperation(client, "work_search", {
      q: "humidity",
      from: "2000-02-01",
      to: "2000-01-01",
    });
    expect(reversed.isError).toBe(true);

    const context = await callJson<{
      relevant?: { confidence: string; knowledge: unknown[]; sessions: Array<{ id: string }> };
    }>(client, "work_get_context", { projectRoot: root, task: "humidity drift", paths: ["src/sensors/humidity.ts"] });
    expect(context.relevant?.confidence).toBe("high");
    expect(context.relevant?.knowledge).toHaveLength(1);
    expect(context.relevant?.sessions.map((session) => session.id)).toEqual([finalized.session.id]);

    const contextMiss = await callJson<{
      relevant?: { confidence: string; knowledge: unknown[]; sessions: unknown[] };
    }>(client, "work_get_context", { projectRoot: root, task: "interstellar quantum memory accelerator" });
    expect(contextMiss.relevant).toMatchObject({ confidence: "none", knowledge: [], sessions: [] });
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

    const missingReason = await callMcpOperation(client, "work_void_session", { sessionId });
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

  it("corrects a Session title through MCP but never offers permanent deletion", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Title project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-title-001", "Misleading title"),
    );
    const sessionId = finalized.session.id;

    expect(await operationAnnotations(client, "work_update_session_title")).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(await callJson(client, "work_update_session_title", { sessionId, title: "Accurate title" })).toMatchObject({
      outcome: "title_updated",
      duplicate: false,
      previousTitle: "Misleading title",
      session: { id: sessionId, title: "Accurate title" },
    });
    expect(await callJson(client, "work_update_session_title", { sessionId, title: "Accurate title" })).toMatchObject({
      outcome: "title_updated",
      duplicate: true,
    });

    const { dispatchers } = await getToolContractCatalog(client);
    expect([...dispatchers.keys()].filter((operation) => /delete/i.test(operation))).toEqual([]);
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

    const catalog = await getToolContractCatalog(client);
    expect([...catalog.sections.keys()].some((operation) => /accept|decide/.test(operation))).toBe(false);
  });

  it("lets an Agent rewrite a standing Knowledge page with cited Sessions, without a delete tool", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Page project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(
      client,
      "work_finalize_session",
      finalizePayload(root, "mcp-page-001", "Source"),
    );

    expect(
      await callJson(client, "work_request_knowledge_page_update", { projectRoot: root, slug: "pitfalls" }),
    ).toMatchObject({
      outcome: "knowledge_page_update_requested",
      page: { slug: "pitfalls", status: "empty" },
    });
    expect(await callJson(client, "work_get_context", { projectRoot: root })).toMatchObject({
      pendingRequests: { knowledgePages: [{ slug: "pitfalls", updateRequested: true }] },
    });
    expect(
      await callJson(client, "work_get_knowledge_page_context", { projectRoot: root, slug: "pitfalls" }),
    ).toMatchObject({
      outcome: "knowledge_page_context",
      sessions: [{ id: finalized.session.id }],
    });
    const section = { heading: "Build", content: "Run the build first.", sourceSessionIds: [] as string[] };
    const invalid = await callMcpOperation(client, "work_save_knowledge_page", {
      projectRoot: root,
      slug: "pitfalls",
      idempotencyKey: "page-1",
      sections: [section],
    });
    expect(invalid.isError).toBe(true);
    expect(
      await callJson(client, "work_save_knowledge_page", {
        projectRoot: root,
        slug: "pitfalls",
        idempotencyKey: "page-1",
        sections: [{ ...section, sourceSessionIds: [finalized.session.id] }],
      }),
    ).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 1, status: "fresh" } });
    expect(
      await callJson(client, "work_mark_knowledge_page_checked", {
        projectRoot: root,
        slug: "pitfalls",
        throughSessionId: finalized.session.id,
      }),
    ).toMatchObject({
      outcome: "knowledge_page_checked",
      page: { version: 1, status: "fresh", checkedThrough: { sessionId: finalized.session.id } },
    });

    for (let index = 1; index <= 3; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const result = await callJson<{ knowledgePageMaintenanceHint?: string }>(
        client,
        "work_finalize_session",
        finalizePayload(root, `mcp-page-new-${index}`, `New page data ${index}`),
      );
      if (index < 3) {
        expect(result).not.toHaveProperty("knowledgePageMaintenanceHint");
      } else {
        expect(result.knowledgePageMaintenanceHint).toContain("常見陷阱（3 筆新 Session）");
      }
    }

    expect(await operationAnnotations(client, "work_get_knowledge_page_context")).toMatchObject({ readOnlyHint: true });
    expect(await operationAnnotations(client, "work_save_knowledge_page")).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(await operationAnnotations(client, "work_mark_knowledge_page_checked")).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    const catalog = await getToolContractCatalog(client);
    expect(
      [...catalog.sections.keys()].some(
        (operation) => /knowledge_page/.test(operation) && /delete|remove/.test(operation),
      ),
    ).toBe(false);
  });

  it("explains how two graph nodes are related with a read-only path tool", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Path project", root);
    store.updateProject(project.id, { status: "tracked" });
    const first = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-path-001", "Plan"),
      changedFiles: ["docs/plan.md"],
    });
    await callJson(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-path-002", "Build"),
      changedFiles: ["docs/plan.md", "src/build.ts"],
    });

    const path = await callJson<{ found: boolean; steps: Array<{ reason: string }> }>(client, "work_get_graph_path", {
      projectRoot: root,
      from: `session:${first.session.id}`,
      to: `file:${project.id}:src/build.ts`,
    });
    expect(path.found).toBe(true);
    expect(path.steps.at(-1)?.reason).toBe("Session「Build」修改了 src/build.ts");

    const graph = await callJson<{ edges: Array<{ provenance: string }> }>(client, "work_get_graph", {
      projectRoot: root,
    });
    expect(new Set(graph.edges.map((edge) => edge.provenance))).toEqual(new Set(["recorded"]));
    expect(await operationAnnotations(client, "work_get_graph_path")).toMatchObject({
      readOnlyHint: true,
    });
  });

  it("lets an Agent attach a diagram idempotently, without a delete tool", async () => {
    const { client, store, root } = await connect();
    const project = store.addProject("Diagram project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = await callJson<{ session: { id: string } }>(client, "work_finalize_session", {
      ...finalizePayload(root, "mcp-diagram-001", "Diagrammed"),
      diagrams: [{ title: "At finalize", source: "flowchart LR\n  A --> B" }],
    });
    const payload = {
      sessionId: finalized.session.id,
      idempotencyKey: "diagram-1",
      title: "Later",
      source: "sequenceDiagram\n  A->>B: hi",
    };
    expect(await callJson(client, "work_attach_diagram", payload)).toMatchObject({
      outcome: "diagram_attached",
      duplicate: false,
    });
    expect(await callJson(client, "work_attach_diagram", payload)).toMatchObject({ duplicate: true });
    expect(store.getSessionDetail(finalized.session.id)?.diagrams.map((diagram) => diagram.title)).toEqual([
      "At finalize",
      "Later",
    ]);
    expect(await operationAnnotations(client, "work_attach_diagram")).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    const catalog = await getToolContractCatalog(client);
    expect(
      [...catalog.sections.keys()].some((operation) => /diagram/.test(operation) && /void|delete/.test(operation)),
    ).toBe(false);
    // Agents attach diagrams on their own only for flow, architecture, or multi-step changes.
    const finalizeContract = catalog.sections.get("work_finalize_session");
    expect(finalizeContract).toContain("without being asked");
    expect(finalizeContract).toContain("skip single-file fixes");
  });
});
