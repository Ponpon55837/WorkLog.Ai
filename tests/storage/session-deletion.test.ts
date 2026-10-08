import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDeletionError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTrackedDiskStore(): { store: WorkIntelligenceStore; root: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-session-delete-"));
  tempDirs.push(directory);
  const root = join(directory, "workspace");
  mkdirSync(root);
  const databasePath = join(directory, "data", "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Session Deletion Fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, databasePath };
}

function finalize(store: WorkIntelligenceStore, root: string, key: string, nextSteps: string[] = []): string {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Synthetic ${key}`,
    summary: `Synthetic summary for ${key}.`,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps },
    handoffContent: `Synthetic handoff for ${key} with a unique phrase.`,
    changedFiles: ["src/fixture.ts"],
    verification: { status: "passed" },
    events: [{ type: "execution", summary: `Synthetic event for ${key}.` }],
  });
  if (result.outcome !== "finalized") {
    throw new Error("Expected the synthetic Session to be finalized");
  }
  return result.session.id;
}

function voidSession(store: WorkIntelligenceStore, sessionId: string): void {
  expect(store.setSessionVoid({ sessionId, voided: true, reason: "Recorded as a test." })).toMatchObject({
    outcome: "session_void_updated",
  });
}

function count(databasePath: string, sql: string, ...parameters: string[]): number {
  const db = new DatabaseSync(databasePath);
  try {
    return (db.prepare(sql).get(...parameters) as { count: number }).count;
  } finally {
    db.close();
  }
}

function deletionCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SessionDeletionError ? error.code : String(error);
  }
  return undefined;
}

describe("Session permanent deletion", () => {
  it("refuses Sessions that are missing or not voided, and in-memory databases without a backup", () => {
    const { store, root } = createTrackedDiskStore();
    const sessionId = finalize(store, root, "session-delete-active");

    expect(deletionCode(() => store.deleteSession("missing-session"))).toBe("SESSION_NOT_FOUND");
    expect(deletionCode(() => store.deleteSession(sessionId))).toBe("SESSION_NOT_VOIDED");
    expect(store.getSessionById(sessionId)).toBeDefined();

    const memory = new WorkIntelligenceStore(":memory:");
    stores.push(memory);
    expect(deletionCode(() => memory.deleteSession("missing-session"))).toBe("SESSION_NOT_FOUND");
  });

  it("backs up, deletes the Session with its records, keeps Knowledge, and leaves an id-only audit", () => {
    const { store, root, databasePath } = createTrackedDiskStore();
    const sessionId = finalize(store, root, "session-delete-target", ["Synthetic outstanding item to delete."]);
    const keptId = finalize(store, root, "session-delete-kept", ["Synthetic outstanding item to keep."]);
    store.attachEvidence({ sessionId, kind: "test", reference: "synthetic-evidence", summary: "Synthetic." });
    store.updateSessionSummary({
      sessionId,
      idempotencyKey: "session-delete-summary",
      mode: "append",
      summary: "Synthetic summary update.",
    });
    store.linkSessions({ sessionId: keptId, relatedSessionId: sessionId, relation: "related", linked: true }, "web");
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "session-delete-knowledge",
      kind: "gotcha",
      title: "Synthetic Knowledge from the deleted Session",
      body: "Synthetic body that must outlive its source Session.",
      sessionId,
    });
    if (knowledge.outcome !== "knowledge_recorded") {
      throw new Error("Expected synthetic Knowledge to be recorded");
    }
    voidSession(store, sessionId);

    const result = store.deleteSession(sessionId);

    expect(result).toMatchObject({ outcome: "session_deleted", sessionId });
    expect(result.backupFileName).toContain("pre-session-delete-");
    expect(result.deletedCounts).toMatchObject({
      sessions: 1,
      workEvents: expect.any(Number),
      rawSnapshots: 1,
      evidence: 1,
      voidAudit: 1,
      sessionLinks: 1,
      sessionSummaryUpdates: 1,
      outstandingItems: 1,
    });
    expect(store.getSessionById(sessionId)).toBeUndefined();
    expect(store.getSessionDetail(keptId)?.links ?? []).toEqual([]);
    expect(store.listBackups()).toMatchObject({
      backups: expect.arrayContaining([expect.objectContaining({ kind: "session_deletion" })]),
    });

    const sessionScoped = [
      "work_events",
      "raw_snapshots",
      "evidence",
      "void_audit",
      "session_summary_updates",
      "session_decisions",
    ];
    for (const table of sessionScoped) {
      expect(count(databasePath, `SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`, sessionId)).toBe(0);
    }
    expect(
      count(databasePath, "SELECT COUNT(*) AS count FROM outstanding_items WHERE source_session_id = ?", sessionId),
    ).toBe(0);
    expect(
      count(databasePath, "SELECT COUNT(*) AS count FROM outstanding_items WHERE source_session_id = ?", keptId),
    ).toBe(1);
    expect(
      count(
        databasePath,
        "SELECT COUNT(*) AS count FROM search_chunks WHERE doc_type = 'session' AND doc_id = ?",
        sessionId,
      ),
    ).toBe(0);
    expect(
      count(
        databasePath,
        "SELECT COUNT(*) AS count FROM knowledge WHERE id = ? AND session_id IS NULL",
        knowledge.knowledge.id,
      ),
    ).toBe(1);
    expect(
      count(databasePath, "SELECT COUNT(*) AS count FROM session_deletion_audit WHERE session_id = ?", sessionId),
    ).toBe(1);
  });

  it("keeps outstanding item history append-only while the item still exists", () => {
    const { store, root, databasePath } = createTrackedDiskStore();
    finalize(store, root, "session-delete-history", ["Synthetic outstanding item with history."]);
    const db = new DatabaseSync(databasePath);
    try {
      expect(() => db.exec("DELETE FROM outstanding_item_events")).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("refuses while a pending cleanup proposal for another Session's item cites it", () => {
    const { store, root, databasePath } = createTrackedDiskStore();
    const sourceId = finalize(store, root, "session-delete-cleanup-source", ["Synthetic item awaiting cleanup."]);
    const evidenceId = finalize(store, root, "session-delete-cleanup-evidence");
    const db = new DatabaseSync(databasePath);
    try {
      const item = db
        .prepare("SELECT id, project_id, updated_at FROM outstanding_items WHERE source_session_id = ?")
        .get(sourceId) as { id: string; project_id: string; updated_at: string };
      const at = "2026-10-01T00:00:00.000Z";
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare(
        `INSERT INTO outstanding_cleanup_requests (id, project_id, idempotency_key, status, requested_at, item_count)
         VALUES ('cleanup-request', ?, 'cleanup-key', 'awaiting_review', ?, 1)`,
      ).run(item.project_id, at);
      db.prepare(
        `INSERT INTO outstanding_cleanup_submissions (id, request_id, project_id, idempotency_key, payload_hash, created_at)
         VALUES ('cleanup-submission', 'cleanup-request', ?, 'submission-key', 'hash', ?)`,
      ).run(item.project_id, at);
      db.prepare(
        `INSERT INTO outstanding_cleanup_request_items (
           id, request_id, project_id, item_id, source_session_id, position, text,
           item_updated_at, source_updated_at, source_fingerprint, source_completed_at
         ) VALUES ('cleanup-item', 'cleanup-request', ?, ?, ?, 0, 'Synthetic item awaiting cleanup.', ?, ?, 'fp', ?)`,
      ).run(item.project_id, item.id, sourceId, item.updated_at, at, at);
      db.prepare(
        `INSERT INTO outstanding_cleanup_proposals (
           id, request_id, project_id, request_item_id, submission_id, target_status, reason, review_status, created_at
         ) VALUES ('cleanup-proposal', 'cleanup-request', ?, 'cleanup-item', 'cleanup-submission', 'completed',
           'Synthetic reason.', 'pending', ?)`,
      ).run(item.project_id, at);
      db.prepare(
        `INSERT INTO outstanding_cleanup_proposal_evidence (
           id, proposal_id, project_id, session_id, session_updated_at, session_fingerprint, session_completed_at
         ) VALUES ('cleanup-evidence', 'cleanup-proposal', ?, ?, ?, 'fp', ?)`,
      ).run(item.project_id, evidenceId, at, at);
    } finally {
      db.close();
    }
    voidSession(store, evidenceId);

    expect(deletionCode(() => store.deleteSession(evidenceId))).toBe("SESSION_CITED_BY_PENDING_CLEANUP");
    expect(store.getSessionById(evidenceId)).toBeDefined();
  });
});

describe("Session title update", () => {
  it("renames in place, keeps the previous title as a note, and is a no-op when unchanged", () => {
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-session-title-"));
    tempDirs.push(directory);
    const project = store.addProject("Title Fixture", directory);
    store.updateProject(project.id, { status: "tracked" });
    const sessionId = finalize(store, directory, "session-title");

    const renamed = store.updateSessionTitle({ sessionId, title: "  Corrected synthetic title  " });

    expect(renamed).toMatchObject({
      outcome: "title_updated",
      duplicate: false,
      previousTitle: "Synthetic session-title",
      session: { title: "Corrected synthetic title" },
    });
    const note = store
      .getSessionDetail(sessionId)
      ?.events.find((event) => event.type === "note" && event.summary.includes("Corrected synthetic title"));
    expect(note?.summary).toContain("Synthetic session-title");
    expect(store.updateSessionTitle({ sessionId, title: "Corrected synthetic title" })).toMatchObject({
      outcome: "title_updated",
      duplicate: true,
    });
    expect(store.getSessionDetail(sessionId)?.events.filter((event) => event.type === "note")).toHaveLength(1);
  });

  it("masks secrets, skips voided Sessions and untracked projects, and reports missing Sessions", () => {
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-session-title-"));
    tempDirs.push(directory);
    const project = store.addProject("Title Fixture", directory);
    store.updateProject(project.id, { status: "tracked" });
    const sessionId = finalize(store, directory, "session-title-guarded");

    const masked = store.updateSessionTitle({
      sessionId,
      title: "Rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 token",
    });
    expect(masked).toMatchObject({ outcome: "title_updated", redactions: { total: 1 } });
    expect(store.getSessionById(sessionId)?.title).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

    expect(store.updateSessionTitle({ sessionId: "missing-session", title: "Any title" })).toEqual({
      outcome: "not_found",
      sessionId: "missing-session",
    });

    voidSession(store, sessionId);
    expect(store.updateSessionTitle({ sessionId, title: "Not applied" })).toMatchObject({ outcome: "skipped" });

    store.updateProject(project.id, { status: "paused" });
    expect(store.updateSessionTitle({ sessionId, title: "Not applied" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });
});
