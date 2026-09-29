import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";

const TOOLS_LIST_CHARACTER_BUDGET = 30_000;
const CONTRACT_INDEX_CHARACTER_BUDGET = 6_000;
const LARGEST_OPERATION_CONTRACT_CHARACTER_BUDGET = 12_000;
const CONTRACT_INDEX_URI = "work-intelligence://agent/tool-contracts";
const PROJECT_ROOT = "/fictional/work-intelligence-mcp-tools-budget";
const cleanups: Array<() => Promise<void> | void> = [];

const EXPECTED_OPERATIONS = {
  work_read: [
    "work_get_project_status",
    "work_get_session",
    "work_list_sessions",
    "work_list_outstanding_items",
    "work_recall",
    "work_search",
    "work_get_context",
    "work_search_knowledge",
    "work_get_knowledge_history",
    "work_get_knowledge_page_context",
    "work_get_graph",
    "work_get_graph_path",
    "work_get_report",
    "work_export_report",
    "work_list_report_synthesis_requests",
    "work_preview_metadata_backfill",
    "work_list_metadata_backfill_requests",
    "work_preview_handoff_import",
  ],
  work_write_idempotent: [
    "work_finalize_session",
    "work_attach_evidence",
    "work_attach_diagram",
    "work_record_knowledge",
    "work_request_knowledge_candidates",
    "work_get_knowledge_candidate_context",
    "work_request_knowledge_page_update",
    "work_save_knowledge_page",
    "work_mark_knowledge_page_checked",
    "work_get_report_context",
    "work_save_report_summary",
    "work_cancel_report_synthesis",
    "work_get_metadata_backfill_context",
    "work_cancel_metadata_backfill",
    "work_import_handoffs",
  ],
  work_write_additive: [
    "work_submit_knowledge_candidates",
    "work_request_report_synthesis",
    "work_retry_report_synthesis",
    "work_request_metadata_backfill",
  ],
  work_write_overwrite: [
    "work_update_session_metadata",
    "work_update_session_summary",
    "work_update_session_work_summary",
    "work_void_session",
    "work_link_sessions",
    "work_void_evidence",
    "work_update_knowledge",
    "work_apply_metadata_backfill",
  ],
} as const;

const EXPECTED_DISPATCHER_ANNOTATIONS = {
  work_read: {
    title: "Read Work Intelligence",
    readOnlyHint: true,
    openWorldHint: false,
  },
  work_write_idempotent: {
    title: "Write Work Intelligence records",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  work_write_additive: {
    title: "Add Work Intelligence records or proposals",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  work_write_overwrite: {
    title: "Update or void Work Intelligence records",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const EXPECTED_OPERATION_ANNOTATIONS = {
  work_read: { readOnlyHint: true, openWorldHint: false },
  work_write_idempotent: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  work_write_additive: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  work_write_overwrite: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

async function connect() {
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Fictional MCP contract project", PROJECT_ROOT);
  store.updateProject(project.id, { status: "tracked" });

  const server = createWorkIntelligenceMcpServer(store, "9.9.9-test", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "tools-list-budget-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => client.close(),
    () => store.close(),
  );
  return { client, store };
}

async function callOperation(
  client: Client,
  dispatcher: string,
  operation: string,
  args: Record<string, unknown> = {},
) {
  return client.callTool({
    name: dispatcher,
    arguments: { operation, arguments: args },
  });
}

function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("Tool call did not return a content result.");
  }
  const textContent = ((result as { content: unknown }).content as Array<{ type: string; text: string }>).find(
    (item) => item.type === "text",
  );
  return textContent?.text ?? "null";
}

function resultJson<T>(result: unknown): T {
  return JSON.parse(resultText(result)) as T;
}

function resourceOperationSections(document: string): Map<string, string> {
  const sections = document.split(/(?=^## work_)/m).filter((section) => section.startsWith("## work_"));
  return new Map(
    sections.map((section) => {
      const operationId = section.match(/^## (work_[^\n]+)/)?.[1];
      if (!operationId) throw new Error("Tool contract section has no operation id.");
      return [operationId, section];
    }),
  );
}

async function readText(client: Client, uri: string): Promise<string> {
  return ((await client.readResource({ uri })).contents as Array<{ text?: string }>)[0]?.text ?? "";
}

/** Reads the operation index, then each operation's own contract, and joins them in index order. */
async function readAllOperationContracts(client: Client): Promise<string> {
  const index = await readText(client, CONTRACT_INDEX_URI);
  const operations = [...index.matchAll(/^- (work_\w+) → work_\w+: /gm)].map((match) => match[1] ?? "");
  const contracts = await Promise.all(
    operations.map((operation) => readText(client, `${CONTRACT_INDEX_URI}/${operation}`)),
  );
  return contracts.join("\n\n");
}

function contractSchema(section: string): Record<string, unknown> {
  const match = section.match(/Input schema[^\n]*\n```json\n([\s\S]*?)\n```/);
  const schemaJson = match?.[1];
  if (!schemaJson) throw new Error("Tool contract is missing its JSON input schema.");
  return JSON.parse(schemaJson) as Record<string, unknown>;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("Work Intelligence MCP dispatcher tools/list budget", () => {
  it("keeps the complete tools/list payload within 30,000 UTF-16 code units and advertises the four dispatcher semantics", async () => {
    const { client } = await connect();
    const listing = await client.listTools();
    const serializedCharacterCount = JSON.stringify(listing).length;

    console.info(`MCP tools/list JSON.stringify length: ${serializedCharacterCount} UTF-16 code units`);
    expect(serializedCharacterCount).toBeLessThanOrEqual(TOOLS_LIST_CHARACTER_BUDGET);
    expect(listing.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED_OPERATIONS).sort());
    expect(
      Object.keys(EXPECTED_OPERATIONS).reduce(
        (count, name) => count + EXPECTED_OPERATIONS[name as keyof typeof EXPECTED_OPERATIONS].length,
        0,
      ),
    ).toBe(45);

    for (const tool of listing.tools) {
      const expected = EXPECTED_DISPATCHER_ANNOTATIONS[tool.name as keyof typeof EXPECTED_DISPATCHER_ANNOTATIONS];
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.annotations).toEqual(expected);
      expect(tool.annotations?.readOnlyHint).toBe(expected.readOnlyHint);
      expect(tool.annotations?.openWorldHint).toBe(false);
      if ("destructiveHint" in expected) {
        expect(tool.annotations?.destructiveHint).toBe(expected.destructiveHint);
      }
      if ("idempotentHint" in expected) {
        expect(tool.annotations?.idempotentHint).toBe(expected.idempotentHint);
      }
    }
  });

  it("publishes each of the 45 operation contracts exactly once with its dispatcher, description, schema, and validation notes", async () => {
    const { client } = await connect();
    const document = await readAllOperationContracts(client);
    const sections = resourceOperationSections(document);
    const expectedOperationIds = Object.values(EXPECTED_OPERATIONS).flat();
    const operationHeadingCount = [...document.matchAll(/^## work_/gm)].length;

    expect(operationHeadingCount).toBe(45);
    expect([...sections.keys()].sort()).toEqual([...expectedOperationIds].sort());
    expect(sections.size).toBe(45);

    for (const [dispatcher, operationIds] of Object.entries(EXPECTED_OPERATIONS)) {
      for (const operationId of operationIds) {
        const section = sections.get(operationId);
        expect(section).toBeDefined();
        expect(section).toContain(`Dispatcher: ${dispatcher}`);
        expect(section).toMatch(/Title: .+/);
        expect(section).toMatch(/Use and limits: .+/);

        const annotationLine = section?.match(/^Annotations: (.+)$/m)?.[1];
        const operationTitle = section?.match(/^Title: (.+)$/m)?.[1];
        expect(annotationLine).toBeDefined();
        expect(JSON.parse(annotationLine ?? "null")).toEqual({
          title: operationTitle,
          ...EXPECTED_OPERATION_ANNOTATIONS[dispatcher as keyof typeof EXPECTED_OPERATION_ANNOTATIONS],
        });
        expect(contractSchema(section ?? "")).toMatchObject({ type: "object", properties: expect.any(Object) });
      }
    }

    const recall = sections.get("work_recall") ?? "";
    expect(recall).toContain("Ranked recall across tracked-project Sessions");
    expect(recall).toContain("At least one of q or a non-empty paths array is required");
    expect(contractSchema(recall)).toHaveProperty("properties.q");
    expect(contractSchema(recall)).toHaveProperty("properties.paths");

    const report = sections.get("work_get_report") ?? "";
    expect(report).toContain("Build a deterministic day, week, month, quarter, or year report");
    expect(report).toContain(
      "Custom from/to dates must be supplied together, in order, and span no more than 366 days.",
    );
    expect(contractSchema(report)).toHaveProperty("properties.from");
    expect(contractSchema(report)).toHaveProperty("properties.to");

    const finalize = sections.get("work_finalize_session") ?? "";
    expect(finalize).toContain("A changedFileChanges entry with status=renamed must include previousPath.");
    expect(finalize).toContain("Timestamps with offsets are normalized to UTC; future values are rejected.");
    expect(finalize).toContain("resolvedOutstandingItemIds");
    expect(contractSchema(finalize).properties).toHaveProperty("resolvedOutstandingItemIds");

    const outstandingItems = sections.get("work_list_outstanding_items") ?? "";
    expect(outstandingItems).toContain("This is read-only");
    expect(outstandingItems).toContain("projectRoot is policy-gated before reading");
    expect(outstandingItems).toContain("pageSize defaults to 5 and is capped at 5");
    expect(contractSchema(outstandingItems).properties).toHaveProperty("projectRoot");
    const outstandingProperties = contractSchema(outstandingItems).properties as Record<string, unknown>;
    expect(outstandingProperties.pageSize).toMatchObject({ minimum: 1, maximum: 5, default: 5 });
    expect(outstandingProperties).not.toHaveProperty("projectId");

    const context = sections.get("work_get_context") ?? "";
    expect(context).toContain("Outstanding nextSteps items exposed by context are pending only");
    expect(context).toContain("top-level pendingOutstandingItems list includes each source Session id");
    expect(context).toContain("text capped at 500 characters");
    expect(context).toContain("read-only work_list_outstanding_items to read the complete paged list");

    const sessionMetadata = sections.get("work_update_session_metadata") ?? "";
    expect(sessionMetadata).toContain("A changedFileChanges entry with status=renamed must include previousPath.");
    expect(sessionMetadata).toContain("Timestamps with offsets are normalized to UTC; future values are rejected.");

    const synthesis = sections.get("work_request_report_synthesis") ?? "";
    expect(synthesis).toContain("period=custom requires both from and to.");

    const metadataBackfill = sections.get("work_apply_metadata_backfill") ?? "";
    expect(metadataBackfill).toContain("Apply explicit changed-files, verification, and optional Git metadata updates");
    expect(metadataBackfill).toContain(
      "duplicate sessionIds are returned as failures after the first occurrence is processed.",
    );
    expect(metadataBackfill).toContain(
      "updates must contain 1 to 100 entries. For each sessionId, the handler processes the first update and returns each later duplicate as a failure in the result.",
    );
    expect(metadataBackfill).toContain(
      "Within each update, a changedFileChanges entry with status=renamed must include previousPath; timestamps with offsets are normalized to UTC, future values are rejected, and an invalid startedAt after completedAt is not applied and produces a warning.",
    );
    expect(contractSchema(metadataBackfill)).toHaveProperty("properties.updates.items.properties.sessionId");
    expect(contractSchema(metadataBackfill)).toHaveProperty(
      "properties.updates.items.properties.changedFileChanges.items.properties.previousPath",
    );
  });

  it("serves a compact operation index and bounded per-operation contracts instead of one full catalog", async () => {
    const { client } = await connect();
    const index = await readText(client, CONTRACT_INDEX_URI);
    const { resourceTemplates } = await client.listResourceTemplates();
    const expectedOperationIds = Object.values(EXPECTED_OPERATIONS).flat();
    const contracts = await Promise.all(
      expectedOperationIds.map(async (operation) => ({
        operation,
        length: (await readText(client, `${CONTRACT_INDEX_URI}/${operation}`)).length,
      })),
    );
    const largest = contracts.reduce((max, entry) => (entry.length > max.length ? entry : max));
    const finalizeLength = contracts.find((entry) => entry.operation === "work_finalize_session")?.length ?? 0;
    const outstandingItemsLength =
      contracts.find((entry) => entry.operation === "work_list_outstanding_items")?.length ?? 0;

    console.info(
      `MCP contract sizes (UTF-16 code units): ${JSON.stringify({
        index: index.length,
        finalize: finalizeLength,
        outstandingItems: outstandingItemsLength,
        largest,
        all: contracts.reduce((sum, entry) => sum + entry.length, 0),
      })}`,
    );
    expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(`${CONTRACT_INDEX_URI}/{operation}`);
    expect(index.length).toBeLessThanOrEqual(CONTRACT_INDEX_CHARACTER_BUDGET);
    expect(largest.length).toBeLessThanOrEqual(LARGEST_OPERATION_CONTRACT_CHARACTER_BUDGET);
    for (const [dispatcher, operationIds] of Object.entries(EXPECTED_OPERATIONS)) {
      for (const operationId of operationIds) expect(index).toContain(`- ${operationId} → ${dispatcher}: `);
    }
    await expect(readText(client, `${CONTRACT_INDEX_URI}/work_unknown_operation`)).rejects.toThrow();
  });

  it("rejects unknown argument keys at every level instead of silently dropping them", async () => {
    const { client } = await connect();

    const invalidEnvelope = await client.callTool({
      name: "work_read",
      arguments: {
        operation: "work_get_project_status",
        arguments: { projectRoot: PROJECT_ROOT },
        typo: true,
      },
    });
    expect(invalidEnvelope.isError).toBe(true);
    expect(resultText(invalidEnvelope)).toContain("typo");

    const topLevel = await callOperation(client, "work_read", "work_list_sessions", {
      projectRoot: PROJECT_ROOT,
      limit: 5,
    });
    expect(topLevel.isError).toBe(true);
    expect(resultText(topLevel)).toContain("Unknown argument(s): limit");

    const outstandingScope = await callOperation(client, "work_read", "work_list_outstanding_items", {
      projectRoot: PROJECT_ROOT,
      projectId: "another-project",
    });
    expect(outstandingScope.isError).toBe(true);
    expect(resultText(outstandingScope)).toContain("Unknown argument(s): projectId");

    const oversizedOutstandingPage = await callOperation(client, "work_read", "work_list_outstanding_items", {
      pageSize: 6,
    });
    expect(oversizedOutstandingPage.isError).toBe(true);
    expect(resultText(oversizedOutstandingPage)).toContain("Invalid outstanding item query.");

    const nested = await callOperation(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: PROJECT_ROOT,
      idempotencyKey: "fictional-unknown-nested-key",
      title: "Fictional",
      summary: "Fictional summary.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [], nextstep: [] },
      changedFiles: [],
      verification: { status: "not_run", note: "typo" },
    });
    expect(nested.isError).toBe(true);
    const nestedText = resultText(nested);
    expect(nestedText).toContain("Unknown argument(s) in workSummary: nextstep");
    expect(nestedText).toContain("Unknown argument(s) in verification: note");

    const unionMember = await callOperation(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: PROJECT_ROOT,
      idempotencyKey: "fictional-unknown-union-key",
      title: "Fictional",
      summary: "Fictional summary.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["legacy string", { text: "Agent choice", origin: "agent_autonomous", why: "extra" }],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "not_run" },
    });
    expect(unionMember.isError).toBe(true);
    expect(resultText(unionMember)).toContain("Unknown argument(s) in workSummary.decisions.1: why");

    const valid = await callOperation(client, "work_read", "work_list_sessions", {
      projectRoot: PROJECT_ROOT,
      pageSize: 5,
    });
    expect(valid.isError).toBeFalsy();
  });

  it("routes every advertised operation through its assigned dispatcher", async () => {
    const { client } = await connect();
    const document = await readAllOperationContracts(client);
    const sections = resourceOperationSections(document);
    let callCount = 0;

    for (const [dispatcher, operationIds] of Object.entries(EXPECTED_OPERATIONS)) {
      for (const operationId of operationIds) {
        const result = await callOperation(client, dispatcher, operationId);
        const responseText = resultText(result);

        expect(responseText).not.toContain("UNKNOWN_OPERATION");
        expect(responseText).not.toContain("INVALID_OPERATION_CALL");

        const advertisedSchema = contractSchema(sections.get(operationId) ?? "");
        const requiredFields = (advertisedSchema.required as string[] | undefined) ?? [];
        if (requiredFields.length > 0) {
          expect(result.isError).toBe(true);
          const payload = resultJson<{ details?: { fieldErrors?: Record<string, unknown> } }>(result);
          for (const field of requiredFields) {
            expect(payload.details?.fieldErrors).toHaveProperty(field);
          }
        }
        callCount += 1;
      }
    }

    expect(callCount).toBe(45);
  });

  it("routes representative handlers and reports invalid operation arguments as tool errors", async () => {
    const { client } = await connect();

    const status = await callOperation(client, "work_read", "work_get_project_status", { projectRoot: PROJECT_ROOT });
    expect(status.isError).toBeFalsy();
    expect(resultJson<Record<string, unknown>>(status)).toMatchObject({ projectStatus: "tracked", tracked: true });

    const finalizedResult = await callOperation(client, "work_write_idempotent", "work_finalize_session", {
      projectRoot: PROJECT_ROOT,
      idempotencyKey: "tools-list-budget-finalize-001",
      title: "Fictional dispatcher verification",
      summary: "Verified the fictional MCP dispatcher routing.",
      workSummary: {
        outcomes: ["Dispatcher routing was verified."],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: ["src/fictional-dispatcher.ts"],
      verification: { status: "passed" },
    });
    expect(finalizedResult.isError).toBeFalsy();
    const finalized = resultJson<{ session: { id: string } }>(finalizedResult);
    expect(finalized.session.id).toBeTruthy();

    const additive = await callOperation(client, "work_write_additive", "work_request_report_synthesis", {
      projectRoot: PROJECT_ROOT,
      period: "week",
      idempotencyKey: "tools-list-budget-report-request-001",
    });
    expect(additive.isError).toBeFalsy();

    const overwritten = await callOperation(client, "work_write_overwrite", "work_update_session_summary", {
      sessionId: finalized.session.id,
      idempotencyKey: "tools-list-budget-summary-001",
      mode: "append",
      summary: "A fictional follow-up confirmed the overwrite dispatcher.",
    });
    expect(overwritten.isError).toBeFalsy();
    expect(resultJson<Record<string, unknown>>(overwritten)).toMatchObject({ outcome: "summary_updated" });

    const duplicateMetadataIds = await callOperation(client, "work_write_overwrite", "work_apply_metadata_backfill", {
      updates: [
        { sessionId: finalized.session.id, changedFiles: ["src/fictional-dispatcher.ts"] },
        { sessionId: finalized.session.id, changedFiles: ["src/fictional-dispatcher.ts"] },
      ],
    });
    expect(duplicateMetadataIds.isError).toBeFalsy();
    expect(
      resultJson<{ failures: Array<{ sessionId: string; reason: string }> }>(duplicateMetadataIds).failures,
    ).toContainEqual({
      sessionId: finalized.session.id,
      reason: "The same sessionId was provided more than once in this batch.",
    });

    const missingRecallFields = await callOperation(client, "work_read", "work_recall");
    expect(missingRecallFields.isError).toBe(true);

    const missingFinalizeFields = await callOperation(client, "work_write_idempotent", "work_finalize_session");
    expect(missingFinalizeFields.isError).toBe(true);

    const unpairedCustomReportRange = await callOperation(client, "work_read", "work_get_report", {
      from: "2026-09-01",
    });
    expect(unpairedCustomReportRange.isError).toBe(true);

    const incompleteCustomSynthesisRange = await callOperation(
      client,
      "work_write_additive",
      "work_request_report_synthesis",
      {
        projectRoot: PROJECT_ROOT,
        period: "custom",
        from: "2026-09-01",
      },
    );
    expect(incompleteCustomSynthesisRange.isError).toBe(true);

    const unknownOperation = await callOperation(client, "work_read", "work_unknown_operation");
    expect(unknownOperation.isError).toBe(true);
  });
});
