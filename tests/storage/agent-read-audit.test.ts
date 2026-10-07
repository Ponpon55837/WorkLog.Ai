import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_READ_AUDIT_MAX_IDS,
  AGENT_READ_AUDIT_MAX_ROWS,
  WorkIntelligenceStore,
  extractAgentReadRecords,
} from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-read-audit-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Audit Fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "audit-session-1",
    title: "Synthetic audit lantern session",
    summary: "Synthetic lantern summary for read audit coverage.",
    changedFiles: ["src/lantern.ts"],
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") throw new Error("Expected a finalized synthetic session");
  return { store, root, project, sessionId: finalized.session.id };
}

function rows(store: WorkIntelligenceStore, sql: string): Array<Record<string, unknown>> {
  return (store as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db
    .prepare(sql)
    .all();
}

describe("agent read audit", () => {
  it("extracts ids from a context result, recall hits, and a session detail", () => {
    const { store, root, sessionId } = createFixture();
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "audit-knowledge-1",
      kind: "gotcha",
      title: "Synthetic lantern gotcha",
      body: "Synthetic lantern body text.",
      sessionId,
    });
    const context = extractAgentReadRecords(store.getContext(root, { task: "lantern" }));
    expect(context.sessionIds).toContain(sessionId);
    expect(context.projectId).toBeDefined();

    const recall = extractAgentReadRecords(store.recall({ projectRoot: root, q: "lantern" }));
    expect(recall.sessionIds).toContain(sessionId);
    expect(recall.knowledgeIds.length).toBeGreaterThan(0);

    const detail = extractAgentReadRecords(store.getSessionDetailForAgent({ sessionId, includeRawSnapshots: false }));
    expect(detail.sessionIds).toEqual([sessionId]);
    expect(detail.projectId).toBeDefined();

    expect(extractAgentReadRecords({ outcome: "skipped", projectStatus: "paused" })).toEqual({
      projectId: undefined,
      sessionIds: [],
      knowledgeIds: [],
    });
  });

  it("stores ids and counts only, caps each list at 50, and reports omitted counts", () => {
    const { store, project } = createFixture();
    const hits = Array.from({ length: 53 }, (_, index) => ({
      type: "session",
      id: `synthetic-session-${index}`,
      projectId: project.id,
      title: "SECRET-TITLE",
      excerpt: "SECRET-EXCERPT",
    }));
    store.recordAgentRead({
      tool: "work_recall",
      agentClient: "fiction-agent",
      result: { outcome: "recall", hits },
      now: "2026-01-01T00:00:00.000Z",
    });
    const [row] = rows(store, "SELECT * FROM agent_read_audit");
    expect(Object.keys(row!).sort()).toEqual(
      [
        "agent_client",
        "created_at",
        "id",
        "knowledge_ids_json",
        "omitted_knowledge_count",
        "omitted_session_count",
        "outcome",
        "project_id",
        "returned_count",
        "session_ids_json",
        "tool",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(JSON.parse(String(row!.session_ids_json))).toHaveLength(AGENT_READ_AUDIT_MAX_IDS);
    expect(row).toMatchObject({
      returned_count: 53,
      omitted_session_count: 3,
      outcome: "recall",
      project_id: project.id,
      agent_client: "fiction-agent",
    });
    expect(rows(store, "SELECT COUNT(*) AS n FROM agent_read_audit_records")[0]).toEqual({ n: 50 });
  });

  it("records skipped results with the tool and outcome only", () => {
    const { store, project } = createFixture();
    store.recordAgentRead({
      tool: "work_get_context",
      result: { outcome: "skipped", projectId: project.id, projectRoot: "/never/stored", reason: "never stored" },
      projectId: project.id,
    });
    const [row] = rows(store, "SELECT * FROM agent_read_audit");
    expect(row).toMatchObject({ tool: "work_get_context", outcome: "skipped", project_id: null, returned_count: 0 });
    expect(JSON.stringify(row)).not.toContain("never");
  });

  it("never throws when the audit table is unusable", () => {
    const { store } = createFixture();
    (store as unknown as { db: { exec(sql: string): void } }).db.exec("DROP TABLE agent_read_audit_records");
    expect(() => store.recordAgentRead({ tool: "work_recall", result: { outcome: "recall", hits: [] } })).not.toThrow();
  });

  it("lists recent reads of tracked projects, filters by agent, and answers forRecord newest first", () => {
    const { store, project, sessionId } = createFixture();
    const hit = { type: "session", id: sessionId, projectId: project.id };
    store.recordAgentRead({
      tool: "work_recall",
      agentClient: "agent-a",
      result: { outcome: "recall", hits: [hit] },
      now: "2026-02-01T00:00:00.000Z",
    });
    store.recordAgentRead({
      tool: "work_get_session",
      agentClient: "agent-b",
      result: {
        outcome: "session_detail",
        session: { id: sessionId, projectId: project.id, completedAt: "x", summary: "" },
      },
      now: "2026-02-02T00:00:00.000Z",
    });
    const all = store.listAgentReads({});
    expect(all.items.map((item) => item.tool)).toEqual(["work_get_session", "work_recall"]);
    expect(all.items[0]).toMatchObject({ projectName: "Audit Fixture", sessionIds: [sessionId], returnedCount: 1 });
    expect(store.listAgentReads({ agentClient: "agent-a" }).items).toHaveLength(1);
    expect(store.listAgentReads({ projectId: "other" }).items).toHaveLength(0);

    const references = store.getAgentReadsForRecord("session", sessionId);
    expect(references.total).toBe(2);
    expect(references.items.map((item) => item.agentClient)).toEqual(["agent-b", "agent-a"]);
    expect(store.getAgentReadsForRecord("knowledge", sessionId).total).toBe(0);

    store.updateProject(project.id, { status: "paused" });
    expect(store.listAgentReads({}).items).toHaveLength(0);
  });

  it("prunes by age and by row count", () => {
    const { store } = createFixture();
    const service = (store as unknown as { agentReadAudit: { prune(now: string): void } }).agentReadAudit;
    const now = "2026-06-30T00:00:00.000Z";
    store.recordAgentRead({
      tool: "old_read",
      result: { outcome: "recall", hits: [] },
      now: "2026-05-01T00:00:00.000Z",
    });
    store.recordAgentRead({
      tool: "new_read",
      result: { outcome: "recall", hits: [] },
      now: "2026-06-29T00:00:00.000Z",
    });
    service.prune(now);
    expect(rows(store, "SELECT tool FROM agent_read_audit")).toEqual([{ tool: "new_read" }]);

    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${AGENT_READ_AUDIT_MAX_ROWS + 20})
      INSERT INTO agent_read_audit (id, created_at, tool, outcome)
      SELECT 'bulk-' || i, '2026-06-2' || (i % 10) || 'T00:00:00.000Z', 'bulk', 'ok' FROM n`);
    service.prune(now);
    expect(rows(store, "SELECT COUNT(*) AS n FROM agent_read_audit")[0]).toEqual({ n: AGENT_READ_AUDIT_MAX_ROWS });
  });
});
