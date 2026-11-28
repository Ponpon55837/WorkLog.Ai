import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataImportStrategy } from "../../packages/core/src/index.js";
import { readProjectDataImportFile } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const PAGE = { slug: "hive-inspections", title: "Hive inspections", question: "How are hives inspected?" };

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const connections: DatabaseSync[] = [];

interface Machine {
  store: WorkIntelligenceStore;
  directory: string;
  projectRoot: string;
}

function sql(on: Machine): DatabaseSync {
  const db = new DatabaseSync(join(on.directory, "work-intelligence.sqlite"));
  connections.push(db);
  return db;
}

function machine(name: string): Machine {
  const directory = mkdtempSync(join(tmpdir(), `work-intelligence-session-two-db-${name}-`));
  tempDirs.push(directory);
  const projectRoot = join(directory, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(join(directory, "work-intelligence.sqlite"));
  stores.push(store);
  return { store, directory, projectRoot };
}

function finalize(on: Machine, key: string): string {
  const result = on.store.finalizeSession({
    projectRoot: on.projectRoot,
    idempotencyKey: key,
    title: `Synthetic ${key}`,
    summary: `Synthetic summary for ${key}.`,
    workSummary: {
      outcomes: [],
      scope: [],
      decisions: [{ text: `Decision of ${key}.`, origin: "agent_autonomous" }],
      verification: [],
      nextSteps: [`Follow up on ${key}.`],
    },
    handoffContent: `Synthetic handoff for ${key}.`,
    changedFiles: ["src/fixture.ts"],
    verification: { status: "passed" },
    events: [{ type: "execution", summary: `Synthetic event for ${key}.` }],
  });
  if (result.outcome !== "finalized") throw new Error("Expected the synthetic Session to be finalized");
  return result.session.id;
}

function exportFile(from: Machine, projectId: string, strategy: ProjectDataImportStrategy, name: string) {
  const path = join(from.directory, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({ bundle: from.store.exportProjectData({ type: "project", projectId }), strategy }),
  );
  return path;
}

function previewAndApply(into: Machine, path: string) {
  const input = readProjectDataImportFile(path, { envelope: "request", spillPath: join(into.directory, "spill") });
  try {
    const preview = into.store.previewProjectDataImport(input);
    const applied = into.store.importProjectData(input);
    return { preview, applied };
  } finally {
    input.dispose();
  }
}

function sessionIds(on: Machine): string[] {
  return on.store
    .listSessions({ limit: 50 })
    .map((session) => session.id)
    .sort();
}

const AT = "2026-09-26T00:00:00.000Z";

function seedChildren(a: Machine, projectId: string, sessionId: string, keptId: string) {
  const knowledge = a.store.recordKnowledge({
    projectRoot: a.projectRoot,
    idempotencyKey: "hive-knowledge",
    kind: "gotcha",
    title: "Smoke the hive first",
    body: "Smoke calms the bees before inspection.",
    sessionId,
  });
  if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
  const requested = a.store.requestKnowledgePageUpdate({ projectRoot: a.projectRoot, ...PAGE });
  if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected page request");
  const db = sql(a);
  db.prepare("UPDATE knowledge_pages SET checked_through_session_id = ? WHERE id = ?").run(
    sessionId,
    requested.page.id,
  );
  db.prepare(
    `INSERT INTO knowledge_candidate_requests (id, project_id, status, requested_at, source_session_ids_json, candidate_count)
     VALUES ('cand-request', ?, 'pending', ?, ?, 1)`,
  ).run(projectId, AT, JSON.stringify([sessionId]));
  db.prepare(
    `INSERT INTO knowledge_candidates (id, request_id, project_id, session_id, kind, title, body, rationale, status, created_at)
     VALUES ('cand-1', 'cand-request', ?, ?, 'gotcha', 'Candidate', 'Candidate body', 'Because.', 'proposed', ?)`,
  ).run(projectId, sessionId, AT);
  const decision = db.prepare("SELECT id FROM session_decisions WHERE session_id = ?").get(sessionId) as { id: string };
  db.prepare(
    `INSERT INTO agent_review_requests (id, project_id, idempotency_key, status, requested_at, completed_at, item_count)
     VALUES ('review-request', ?, 'review-request-key', 'completed', ?, ?, 1)`,
  ).run(projectId, AT, AT);
  db.prepare(
    `INSERT INTO agent_review_request_items (id, request_id, project_id, item_kind, item_id, source_session_id, position, fingerprint)
     VALUES ('review-item', 'review-request', ?, 'decision', ?, ?, 0, ?)`,
  ).run(projectId, decision.id, sessionId, "c".repeat(64));
  db.prepare(
    `INSERT INTO attention_preferences (id, project_id, kind, source_id, source_revision, state, revision, updated_at)
     VALUES ('attention-1', ?, 'decision', ?, '${"a".repeat(64)}', 'hidden', 1, ?)`,
  ).run(projectId, decision.id, AT);
  const item = db.prepare("SELECT id FROM outstanding_items WHERE source_session_id = ?").get(keptId) as { id: string };
  db.prepare(
    `INSERT INTO outstanding_item_events (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at)
     VALUES ('actor-event', ?, ?, 'pending', 'completed', 'agent', ?, ?)`,
  ).run(item.id, projectId, sessionId, AT);
  return { knowledgeId: knowledge.knowledge.id, pageId: requested.page.id, decisionId: decision.id };
}

function twoMachines() {
  const a = machine("a");
  const project = a.store.addProject("Apiary", a.projectRoot);
  a.store.updateProject(project.id, { status: "tracked" });
  const sessionId = finalize(a, "hive-inspection");
  const keptId = finalize(a, "queen-check");
  const children = seedChildren(a, project.id, sessionId, keptId);
  const b = machine("b");
  const seeded = readProjectDataImportFile(exportFile(a, project.id, "merge", "seed"), {
    envelope: "request",
    spillPath: join(b.directory, "seed-spill"),
  });
  try {
    b.store.importProjectData(seeded);
  } finally {
    seeded.dispose();
  }
  b.store.updateProject(project.id, { status: "tracked" });
  const bRoot = b.store.listProjects().find((item) => item.id === project.id)?.rootPath;
  if (!bRoot) throw new Error("Expected the project on B");
  return { a, b: { ...b, projectRoot: bRoot }, projectId: project.id, sessionId, keptId, ...children };
}

function deleteOnA(a: Machine, sessionId: string): void {
  a.store.setSessionVoid({ sessionId, voided: true, reason: "Recorded as a test." });
  a.store.deleteSession(sessionId);
}

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function expectAgreement(result: ReturnType<typeof previewAndApply>): void {
  expect(result.applied.additions).toEqual(result.preview.additions);
  expect(result.applied.updates).toEqual(result.preview.updates);
  expect(result.applied.conflicts).toEqual(result.preview.conflicts);
  expect(result.applied.conflictGroups).toEqual(result.preview.conflictGroups);
}

function totalAdditions(result: ReturnType<typeof previewAndApply>): number {
  return Object.values(result.preview.additions).reduce((total, count) => total + (count ?? 0), 0);
}

describe("importing between two independent databases after a Session was permanently deleted on one", () => {
  it.each(["merge", "newer-wins"] as const)(
    "does not bring the Session or anything under it back from an unchanged copy (%s)",
    (strategy) => {
      const { a, b, projectId, sessionId, keptId } = twoMachines();
      expect(sessionIds(b)).toEqual([keptId, sessionId].sort());
      deleteOnA(a, sessionId);

      const result = previewAndApply(a, exportFile(b, projectId, strategy, "from-b"));
      const { preview } = result;

      expect(totalAdditions(result)).toBe(0);
      expect(preview.writesData).toBe(false);
      expect(preview.conflicts).toMatchObject({
        sessions: 1,
        session_decisions: 1,
        agent_review_request_items: 1,
        attention_preferences: 1,
        outstanding_items: 1,
      });
      expect(preview.conflicts.knowledge ?? 0).toBe(0);
      expect(preview.conflicts.knowledge_candidates ?? 0).toBe(0);
      expect(preview.conflicts.knowledge_pages ?? 0).toBe(0);
      expect(preview.conflicts.outstanding_item_events ?? 0).toBe(1);
      expect(preview.conflictGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "sessions", category: "deleted", count: 1, sampleIds: [sessionId] }),
          expect.objectContaining({ table: "agent_review_request_items", category: "deleted" }),
          expect.objectContaining({ table: "attention_preferences", category: "deleted" }),
          expect.objectContaining({ table: "session_decisions", category: "dependency" }),
        ]),
      );
      expectAgreement(result);
      expect(sessionIds(a)).toEqual([keptId]);
    },
  );

  it("does not bring the Session back when the other database changed it after the deletion", () => {
    const { a, b, projectId, sessionId, keptId } = twoMachines();
    deleteOnA(a, sessionId);
    b.store.updateSessionSummary({
      sessionId,
      idempotencyKey: "later-edit",
      mode: "append",
      summary: "Added after the other computer deleted it.",
    });

    const result = previewAndApply(a, exportFile(b, projectId, "newer-wins", "from-b"));

    expect(totalAdditions(result)).toBe(0);
    expect(result.preview.conflictGroups).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "sessions", category: "deleted" })]),
    );
    expectAgreement(result);
    expect(sessionIds(a)).toEqual([keptId]);
  });

  it("keeps imported Knowledge, candidates and page cursors that cite the deleted Session, without the citation", () => {
    const { a, b, projectId, sessionId, knowledgeId, pageId } = twoMachines();
    deleteOnA(a, sessionId);
    sql(b)
      .prepare("UPDATE knowledge SET body = 'Smoke first, then check frames.', updated_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", knowledgeId);
    sql(b).prepare("UPDATE knowledge_pages SET updated_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", pageId);

    const result = previewAndApply(a, exportFile(b, projectId, "newer-wins", "from-b"));

    expect(result.preview.conflicts.knowledge ?? 0).toBe(0);
    expect(result.preview.conflicts.knowledge_candidates ?? 0).toBe(0);
    expect(result.preview.conflicts.knowledge_pages ?? 0).toBe(0);
    expect(result.preview.updates.knowledge).toBe(1);
    expectAgreement(result);
    const row = sql(a)
      .prepare("SELECT body, session_id, last_confirmed_session_id FROM knowledge WHERE id = ?")
      .get(knowledgeId);
    expect(row).toMatchObject({ body: "Smoke first, then check frames.", session_id: null });
    expect(
      sql(a).prepare("SELECT checked_through_session_id AS cursor FROM knowledge_pages WHERE id = ?").get(pageId),
    ).toEqual({ cursor: null });
  });

  it("imports an outstanding item event whose actor Session was deleted here, like an absent actor", () => {
    const { a, b, projectId, sessionId } = twoMachines();
    deleteOnA(a, sessionId);

    const result = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    const eventConflicts = result.preview.conflictGroups.filter((group) => group.table === "outstanding_item_events");
    expect(eventConflicts).toEqual([expect.objectContaining({ category: "dependency", count: 1 })]);
    expect(eventConflicts[0]?.sampleIds).not.toContain("actor-event");
    expect(result.preview.skipped.outstanding_item_events).toBeGreaterThan(0);
    expectAgreement(result);
  });

  it("adds a different Session from the same file normally", () => {
    const { a, b, projectId, sessionId, keptId } = twoMachines();
    const otherId = finalize(b, "honey-harvest");
    deleteOnA(a, sessionId);

    const result = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(result.preview.additions.sessions).toBe(1);
    expect(result.preview.conflicts.sessions).toBe(1);
    expectAgreement(result);
    expect(sessionIds(a)).toEqual([keptId, otherId].sort());
  });

  it("imports normally when nothing was deleted", () => {
    const { a, b, projectId, sessionId, keptId } = twoMachines();
    const otherId = finalize(b, "honey-harvest");

    const result = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(result.preview.additions.sessions).toBe(1);
    expect(result.preview.conflictGroups.filter((group) => group.category === "deleted")).toEqual([]);
    expectAgreement(result);
    expect(sessionIds(a)).toEqual([sessionId, keptId, otherId].sort());
  });

  it("keeps the normal merge path for a Session that is both present here and in the deletion record", () => {
    const { a, b, projectId, sessionId } = twoMachines();
    sql(a)
      .prepare(
        "INSERT INTO session_deletion_audit (id, deleted_at, session_id, project_id, deleted_counts_json) VALUES ('old-audit', ?, ?, ?, '{}')",
      )
      .run(AT, sessionId, projectId);

    const result = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(result.preview.conflictGroups.filter((group) => group.category === "deleted")).toEqual([]);
    expect(result.preview.writesData).toBe(false);
    expectAgreement(result);
    expect(sessionIds(a)).toContain(sessionId);
  });
});
