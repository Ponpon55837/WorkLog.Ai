import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { toFinalizeReceipt } from "../../apps/mcp/src/finalize-receipt.js";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

type FinalizeResult = ReturnType<WorkIntelligenceStore["finalizeSession"]>;
type Finalized = Extract<FinalizeResult, { outcome: "finalized" }>;

const HINT_LIMITS = {
  knowledgeToReviewHint: 100,
  pendingItemsAfterSaveHint: 90,
  timestampWarning: 340,
  privateTagWarnings: 280,
  outstandingReasonEntry: 100,
} as const;
const EARLY = "2026-05-01T08:00:00.000Z";
const LATE = "2026-05-02T08:00:00.000Z";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SESSION: Finalized["session"] = {
  id: "session-hints-1",
  projectId: "project-hints",
  idempotencyKey: "hints-key",
  title: "Fictional title",
  summary: "Fictional summary.",
  workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
  status: "finalized",
  executionStatus: "completed",
  startedAt: "2026-06-01T08:00:00.000Z",
  completedAt: "2026-06-01T09:00:00.000Z",
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  changedFiles: [],
  changedFilesProvenance: [],
  changedFileChanges: [],
};

function finalized(overrides: Partial<Finalized> = {}): Finalized {
  return {
    outcome: "finalized",
    duplicate: false,
    session: SESSION,
    redactions: { total: 0, byKind: {} },
    resolvedOutstandingItemIds: [],
    supersededOutstandingItemIds: [],
    ...overrides,
  };
}

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-mcp-hints-"));
  const store = new WorkIntelligenceStore(":memory:");
  const server = createWorkIntelligenceMcpServer(store, "9.9.9", LATEST_SCHEMA_VERSION);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => client.close(),
  );
  const project = store.addProject("Hint fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  return { client, root };
}

async function call(client: Client, dispatcher: string, operation: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name: dispatcher, arguments: { operation, arguments: args } });
  const [content] = result.content as Array<{ text: string }>;
  return JSON.parse(content?.text ?? "null") as Record<string, any>;
}

function finalizeArgs(root: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    idempotencyKey: key,
    title: key,
    summary: `Finished ${key}.`,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
    completedAt: EARLY,
    ...extra,
  };
}

describe("knowledgeToReviewHint", () => {
  it("accompanies a non-empty knowledgeToReview within its size limit", () => {
    const receipt = toFinalizeReceipt(
      {},
      finalized({
        knowledgeToReview: [{ id: "knowledge-1", title: "Fictional rule", path: "src/ledger.ts" } as never],
      }),
    ) as { knowledgeToReviewHint?: string };
    expect(receipt.knowledgeToReviewHint).toContain("work_update_knowledge");
    expect(receipt.knowledgeToReviewHint).toContain("confirm: true");
    expect(receipt.knowledgeToReviewHint!.length).toBeLessThanOrEqual(HINT_LIMITS.knowledgeToReviewHint);
  });

  it("is absent without knowledgeToReview", () => {
    expect(toFinalizeReceipt({}, finalized())).not.toHaveProperty("knowledgeToReviewHint");
    expect(toFinalizeReceipt({}, finalized({ knowledgeToReview: [] }))).not.toHaveProperty("knowledgeToReviewHint");
  });
});

describe("related outstanding items in the receipt", () => {
  it("point to one resolve call instead of the closed finalize lists", () => {
    const related = {
      items: [{ id: "item-1", sourceSessionId: "session-0", text: "Fictional pending check." }],
      total: 1,
      hint: "context hint",
    };
    const receipt = toFinalizeReceipt(
      {},
      finalized({ relatedOutstandingItems: related as never, continuedOutstandingItems: related as never }),
    ) as { relatedOutstandingItems: { hint: string }; continuedOutstandingItems: { hint: string } };
    for (const { hint } of [receipt.relatedOutstandingItems, receipt.continuedOutstandingItems]) {
      expect(hint).toContain("work_resolve_outstanding_items");
      expect(hint).not.toContain("resolvedOutstandingItemIds");
      expect(hint.length).toBeLessThanOrEqual(HINT_LIMITS.pendingItemsAfterSaveHint);
    }
  });
});

describe("finalize warnings through MCP", () => {
  it("passes reasons, privateTagWarnings, and bounded timestamp warnings into the receipt", async () => {
    const { client, root } = await connect();
    await call(client, "work_write_idempotent", "work_finalize_session", {
      ...finalizeArgs(root, "hints-source", {
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: ["Pending follow-up"] },
      }),
    });
    const ids = ["missing-a", "missing-b", "missing-c"];
    const receipt = await call(client, "work_write_idempotent", "work_finalize_session", {
      ...finalizeArgs(root, "hints-actor", {
        completedAt: LATE,
        summary: "Opened <private> without closing it.",
        resolvedOutstandingItemIds: ids,
      }),
    });
    expect(receipt.outstandingItemWarnings.reasons).toEqual(
      expect.arrayContaining([
        { id: "missing-a", list: "resolved", code: "not_found" },
        { id: "missing-b", list: "resolved", code: "not_found" },
      ]),
    );
    expect(receipt.outstandingItemWarnings.reasons.length).toBeLessThanOrEqual(
      receipt.outstandingItemWarnings.unresolvedIds.length + receipt.outstandingItemWarnings.unsupersededIds.length,
    );
    for (const reason of receipt.outstandingItemWarnings.reasons) {
      expect(JSON.stringify(reason).length).toBeLessThanOrEqual(HINT_LIMITS.outstandingReasonEntry);
    }
    expect(receipt.privateTagWarnings).toEqual({ fields: ["summary"], unclosed: 1, message: expect.any(String) });
    expect(JSON.stringify(receipt.privateTagWarnings).length).toBeLessThanOrEqual(HINT_LIMITS.privateTagWarnings);
    expect(JSON.stringify(receipt)).not.toContain("without closing it");

    const backfill = await call(
      client,
      "work_write_idempotent",
      "work_finalize_session",
      finalizeArgs(root, "hints-backfill", { completedAt: new Date(Date.now() - 72 * 3_600_000).toISOString() }),
    );
    expect(backfill.timestampWarnings).toHaveLength(1);
    expect(backfill.timestampWarnings[0]).toContain("work_update_session_metadata");
    expect(backfill.timestampWarnings[0].length).toBeLessThanOrEqual(HINT_LIMITS.timestampWarning);
  });

  it("passes reasons through work_resolve_outstanding_items", async () => {
    const { client, root } = await connect();
    const actor = await call(
      client,
      "work_write_idempotent",
      "work_finalize_session",
      finalizeArgs(root, "hints-resolver"),
    );
    const resolved = await call(client, "work_write_overwrite", "work_resolve_outstanding_items", {
      sessionId: actor.session.id,
      resolvedOutstandingItemIds: ["missing-id"],
    });
    expect(resolved.outstandingItemWarnings.reasons).toEqual([
      { id: "missing-id", list: "resolved", code: "not_found" },
    ]);
  });
});
