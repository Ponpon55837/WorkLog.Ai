import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDeletionError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

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

function createDiskStore(): { store: WorkIntelligenceStore; directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-project-delete-"));
  tempDirs.push(directory);
  const databasePath = join(directory, "data", "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  return { store, directory, databasePath };
}

describe("project deletion", () => {
  it("backs up first, deletes related and cross-project data atomically, and keeps a content-free audit", () => {
    const { store, directory, databasePath } = createDiskStore();
    const targetRoot = join(directory, "target-workspace");
    const otherRoot = join(directory, "other-workspace");
    mkdirSync(targetRoot);
    mkdirSync(otherRoot);
    const targetProject = store.addProject("Deletion Fixture", targetRoot);
    const otherProject = store.addProject("Related Fixture", otherRoot);
    store.updateProject(targetProject.id, { status: "tracked" });
    store.updateProject(otherProject.id, { status: "tracked" });

    const targetSession = store.finalizeSession({
      projectRoot: targetRoot,
      idempotencyKey: "project-delete-target-session",
      title: "Synthetic deletion source",
      summary: "Synthetic target summary for project deletion coverage.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [{ text: "Synthetic autonomous decision for deletion coverage.", origin: "agent_autonomous" }],
        verification: [],
        nextSteps: ["Synthetic outstanding item for deletion coverage."],
      },
      handoffContent: "Synthetic target handoff contains deletion search phrase.",
      changedFiles: ["src/target.ts"],
      verification: { status: "passed" },
      events: [{ type: "execution", summary: "Synthetic target event." }],
    });
    const otherSession = store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "project-delete-other-session",
      title: "Unrelated project session",
      summary: "This unrelated session must remain available after cleanup.",
      changedFiles: ["src/other.ts"],
      verification: { status: "passed" },
    });
    expect(targetSession.outcome).toBe("finalized");
    expect(otherSession.outcome).toBe("finalized");
    if (targetSession.outcome !== "finalized" || otherSession.outcome !== "finalized") {
      throw new Error("Expected both synthetic sessions to be finalized");
    }

    const targetSessionId = targetSession.session.id;
    const otherSessionId = otherSession.session.id;
    store.attachEvidence({
      sessionId: targetSessionId,
      kind: "test",
      reference: "synthetic-project-delete-evidence",
      summary: "Synthetic evidence for deletion coverage.",
    });
    store.updateSessionVerification(
      targetSessionId,
      { status: "failed", summary: "Synthetic verification update." },
      "web",
    );
    store.updateSessionSummary({
      sessionId: targetSessionId,
      idempotencyKey: "project-delete-summary-update",
      mode: "append",
      summary: "Synthetic summary update.",
    });
    store.updateSessionWorkSummary({
      sessionId: targetSessionId,
      idempotencyKey: "project-delete-work-summary-update",
      mode: "patch",
      workSummary: { outcomes: ["Synthetic work summary update."] },
    });
    const knowledge = store.recordKnowledge({
      projectRoot: targetRoot,
      idempotencyKey: "project-delete-knowledge",
      kind: "gotcha",
      title: "Synthetic target knowledge",
      body: "Synthetic target knowledge body for deletion coverage.",
      sessionId: targetSessionId,
    });
    expect(knowledge.outcome).toBe("knowledge_recorded");
    if (knowledge.outcome !== "knowledge_recorded") {
      throw new Error("Expected synthetic Knowledge to be recorded");
    }
    const linked = store.linkSessions(
      { sessionId: otherSessionId, relatedSessionId: targetSessionId, relation: "related", linked: true },
      "web",
    );
    expect(linked.outcome).toBe("session_link_updated");
    store.requestKnowledgeCandidates(targetRoot);

    const seed = new DatabaseSync(databasePath);
    try {
      const at = "2026-09-26T00:00:00.000Z";
      const candidateRequestId = "delete-fixture-candidate-request";
      seed
        .prepare(
          `INSERT INTO knowledge_candidate_requests
         (id, project_id, status, requested_at, source_session_ids_json, candidate_count)
         VALUES (?, ?, 'pending', ?, ?, 1)`,
        )
        .run(candidateRequestId, targetProject.id, at, JSON.stringify([targetSessionId]));
      seed
        .prepare(
          `INSERT INTO raw_snapshots (id, session_id, project_id, kind, content, captured_at)
           VALUES (?, ?, ?, 'handoff', ?, ?)`,
        )
        .run(
          "delete-fixture-cross-project-snapshot",
          targetSessionId,
          otherProject.id,
          "Synthetic related snapshot",
          at,
        );
      seed
        .prepare(
          `INSERT INTO evidence (id, session_id, project_id, kind, reference, summary, captured_at)
           VALUES (?, ?, ?, 'test', ?, ?, ?)`,
        )
        .run(
          "delete-fixture-cross-project-evidence",
          targetSessionId,
          otherProject.id,
          "synthetic-related-evidence",
          "Synthetic related evidence",
          at,
        );
      seed
        .prepare(
          `INSERT INTO void_audit (id, target_type, target_id, session_id, project_id, action, occurred_at)
           VALUES (?, 'session', ?, ?, ?, 'voided', ?)`,
        )
        .run("delete-fixture-cross-project-void-audit", targetSessionId, targetSessionId, otherProject.id, at);
      seed
        .prepare(
          `INSERT INTO knowledge_candidates
         (id, request_id, project_id, session_id, kind, title, body, rationale, status, created_at)
         VALUES (?, ?, ?, ?, 'gotcha', ?, ?, ?, 'proposed', ?)`,
        )
        .run(
          "delete-fixture-candidate",
          candidateRequestId,
          targetProject.id,
          targetSessionId,
          "Synthetic candidate",
          "Synthetic candidate body",
          "Synthetic candidate rationale",
          at,
        );

      const reportRequestId = "delete-fixture-global-report-request";
      seed
        .prepare(
          `INSERT INTO report_synthesis_requests
         (id, idempotency_key, scope_type, period, range_from, range_to, status, requested_at, source_session_ids_json)
         VALUES (?, ?, 'all', 'day', '2026-09-26', '2026-09-26', 'completed', ?, ?)`,
        )
        .run(reportRequestId, "delete-fixture-global-report", at, JSON.stringify([targetSessionId]));
      seed
        .prepare(
          `INSERT INTO report_summaries
         (id, request_id, period, range_from, range_to, title, executive_summary, source_session_ids_json,
          generated_by_agent, prompt_version, created_at)
         VALUES (?, ?, 'day', '2026-09-26', '2026-09-26', ?, ?, ?, 'synthetic-test', 'test-v1', ?)`,
        )
        .run(
          "delete-fixture-global-report-summary",
          reportRequestId,
          "Synthetic report title",
          "Synthetic report executive summary",
          JSON.stringify([targetSessionId]),
          at,
        );

      seed
        .prepare(
          `INSERT INTO metadata_backfill_requests
         (id, idempotency_key, scope_type, status, requested_at, source_session_ids_json)
         VALUES (?, ?, 'all', 'pending', ?, ?)`,
        )
        .run(
          "delete-fixture-global-backfill",
          "delete-fixture-global-backfill-key",
          at,
          JSON.stringify([targetSessionId]),
        );

      const cleanupItem = seed
        .prepare("SELECT id, position, text, updated_at FROM outstanding_items WHERE source_session_id = ? LIMIT 1")
        .get(targetSessionId) as { id: string; position: number; text: string; updated_at: string };
      const cleanupSource = seed
        .prepare("SELECT updated_at, completed_at FROM sessions WHERE id = ?")
        .get(targetSessionId) as { updated_at: string; completed_at: string };
      const cleanupRequestId = "delete-fixture-cleanup-request";
      const cleanupSubmissionId = "delete-fixture-cleanup-submission";
      const cleanupRequestItemId = "delete-fixture-cleanup-request-item";
      const cleanupProposalId = "delete-fixture-cleanup-proposal";
      const cleanupAt = "2026-09-26T00:01:00.000Z";
      seed
        .prepare(
          `INSERT INTO outstanding_cleanup_requests
         (id, project_id, idempotency_key, status, requested_at, completed_at, item_count)
         VALUES (?, ?, ?, 'completed', ?, ?, 1)`,
        )
        .run(cleanupRequestId, targetProject.id, "delete-fixture-cleanup-request-key", at, cleanupAt);
      seed
        .prepare(
          `INSERT INTO outstanding_cleanup_submissions
         (id, request_id, project_id, idempotency_key, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cleanupSubmissionId,
          cleanupRequestId,
          targetProject.id,
          "delete-fixture-cleanup-submission-key",
          "a".repeat(64),
          cleanupAt,
        );
      seed
        .prepare(
          `INSERT INTO outstanding_cleanup_request_items
         (id, request_id, project_id, item_id, source_session_id, position, text, item_updated_at,
          source_updated_at, source_fingerprint, source_completed_at, examined_submission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cleanupRequestItemId,
          cleanupRequestId,
          targetProject.id,
          cleanupItem.id,
          targetSessionId,
          cleanupItem.position,
          cleanupItem.text,
          cleanupItem.updated_at,
          cleanupSource.updated_at,
          "source-version-fixture",
          cleanupSource.completed_at,
          cleanupSubmissionId,
        );
      seed
        .prepare(
          `INSERT INTO outstanding_cleanup_proposals
         (id, request_id, project_id, request_item_id, submission_id, target_status, reason, review_status,
          created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, 'accepted', ?, ?)`,
        )
        .run(
          cleanupProposalId,
          cleanupRequestId,
          targetProject.id,
          cleanupRequestItemId,
          cleanupSubmissionId,
          "Synthetic evidence supports this accepted cleanup decision.",
          cleanupAt,
          cleanupAt,
        );
      seed
        .prepare(
          `INSERT INTO outstanding_cleanup_proposal_evidence
         (id, proposal_id, project_id, session_id, session_updated_at, session_fingerprint, session_completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "delete-fixture-cleanup-evidence-link",
          cleanupProposalId,
          targetProject.id,
          targetSessionId,
          cleanupSource.updated_at,
          "evidence-version-fixture",
          cleanupSource.completed_at,
        );
      seed
        .prepare("UPDATE outstanding_items SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(cleanupAt, cleanupItem.id);
      seed
        .prepare(
          `INSERT INTO outstanding_item_events
         (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at,
          cleanup_request_id, cleanup_proposal_id)
         VALUES (?, ?, ?, 'pending', 'completed', 'web', NULL, ?, ?, ?)`,
        )
        .run(
          "delete-fixture-cleanup-event",
          cleanupItem.id,
          targetProject.id,
          cleanupAt,
          cleanupRequestId,
          cleanupProposalId,
        );
    } finally {
      seed.close();
    }

    expect(store.recall({ q: "deletion search phrase", limit: 10 })).toMatchObject({ outcome: "recall" });
    const mismatched = (): unknown => store.deleteProject(targetProject.id, "Wrong Fixture Name");
    expect(mismatched).toThrowError(ProjectDeletionError);
    expect(store.listProjects().some((project) => project.id === targetProject.id)).toBe(true);

    const result = store.deleteProject(targetProject.id, "Deletion Fixture");
    expect(result).toMatchObject({
      outcome: "project_deleted",
      projectId: targetProject.id,
      backupFileName: expect.stringMatching(/pre-delete-.*\.sqlite$/),
      deletedCounts: {
        projects: 1,
        sessions: 1,
        workEvents: 2,
        rawSnapshots: 2,
        evidence: 2,
        knowledge: 1,
        knowledgeAudit: 1,
        voidAudit: 1,
        sessionVerificationUpdates: 1,
        sessionLinks: 1,
        knowledgeCandidateRequests: 2,
        knowledgeCandidates: 1,
        reportSynthesisRequests: 1,
        reportSummaries: 1,
        metadataBackfillRequests: 1,
        sessionSummaryUpdates: 1,
        sessionWorkSummaryUpdates: 1,
        sessionDecisions: 1,
        outstandingItems: 1,
        outstandingItemEvents: 2,
        outstandingCleanupRequests: 1,
        outstandingCleanupRequestItems: 1,
        outstandingCleanupSubmissions: 1,
        outstandingCleanupProposals: 1,
        outstandingCleanupProposalEvidence: 1,
      },
    });
    expect(result.deletedCounts.searchChunks).toBeGreaterThan(0);
    expect(result.deletedCounts.searchFts).toBeGreaterThan(0);
    expect(result.deletedCounts.searchPaths).toBeGreaterThan(0);
    expect(result.deletedCounts.searchDirty).toBeGreaterThan(0);
    const deletionAudits = store.listProjectDeletionAudits();
    expect(deletionAudits).toEqual([
      {
        deletedAt: result.deletedAt,
        projectId: targetProject.id,
        deletedCounts: result.deletedCounts,
      },
    ]);
    expect(JSON.stringify(deletionAudits)).not.toContain("Deletion Fixture");
    expect(JSON.stringify(deletionAudits)).not.toContain("Synthetic target summary");
    expect(store.listProjects().map((project) => project.id)).toContain(otherProject.id);
    expect(store.getSessionById(otherSessionId)).toBeDefined();
    expect(store.recall({ q: "deletion search phrase", limit: 10 })).toMatchObject({ hits: [] });

    const backupPath = join(directory, "data", "backups", result.backupFileName);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    const postDelete = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(backup.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(targetProject.id)).toMatchObject(
        {
          count: 1,
        },
      );
      expect(
        backup
          .prepare("SELECT COUNT(*) AS count FROM outstanding_items WHERE source_session_id = ?")
          .get(targetSessionId),
      ).toMatchObject({ count: 1 });
      expect(
        backup
          .prepare(
            "SELECT COUNT(*) AS count FROM outstanding_item_events WHERE item_id IN (SELECT id FROM outstanding_items WHERE source_session_id = ?)",
          )
          .get(targetSessionId),
      ).toMatchObject({ count: 2 });
      expect(
        postDelete.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(targetProject.id),
      ).toMatchObject({
        count: 0,
      });
      expect(
        postDelete
          .prepare("SELECT COUNT(*) AS count FROM outstanding_items WHERE source_session_id = ?")
          .get(targetSessionId),
      ).toMatchObject({ count: 0 });
      expect(
        postDelete
          .prepare("SELECT COUNT(*) AS count FROM outstanding_item_events WHERE project_id = ?")
          .get(targetProject.id),
      ).toMatchObject({ count: 0 });
      for (const table of [
        "outstanding_cleanup_requests",
        "outstanding_cleanup_submissions",
        "outstanding_cleanup_request_items",
        "outstanding_cleanup_proposals",
        "outstanding_cleanup_proposal_evidence",
      ]) {
        expect(
          postDelete.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(targetProject.id),
        ).toMatchObject({
          count: 0,
        });
      }
      expect(postDelete.prepare("SELECT COUNT(*) AS count FROM session_links").get()).toMatchObject({ count: 0 });
      expect(
        postDelete.prepare("SELECT COUNT(*) AS count FROM evidence WHERE session_id = ?").get(targetSessionId),
      ).toMatchObject({ count: 0 });
      expect(
        postDelete.prepare("SELECT COUNT(*) AS count FROM raw_snapshots WHERE session_id = ?").get(targetSessionId),
      ).toMatchObject({ count: 0 });
      expect(
        postDelete.prepare("SELECT COUNT(*) AS count FROM void_audit WHERE session_id = ?").get(targetSessionId),
      ).toMatchObject({ count: 0 });
      expect(postDelete.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get()).toMatchObject({
        count: 0,
      });
      expect(postDelete.prepare("SELECT COUNT(*) AS count FROM report_synthesis_requests").get()).toMatchObject({
        count: 0,
      });
      expect(postDelete.prepare("SELECT COUNT(*) AS count FROM report_summaries").get()).toMatchObject({ count: 0 });
      expect(postDelete.prepare("SELECT COUNT(*) AS count FROM metadata_backfill_requests").get()).toMatchObject({
        count: 0,
      });
      const audit = postDelete
        .prepare("SELECT project_id, deleted_counts_json FROM project_deletion_audit WHERE project_id = ?")
        .get(targetProject.id) as { project_id: string; deleted_counts_json: string };
      expect(audit.project_id).toBe(targetProject.id);
      expect(audit.deleted_counts_json).toContain('"projects":1');
      expect(audit.deleted_counts_json).not.toContain("Deletion Fixture");
    } finally {
      backup.close();
      postDelete.close();
    }
  });

  it("removes the project's Agent read audit rows and keeps other projects' rows", () => {
    const { store, directory, databasePath } = createDiskStore();
    const targetRoot = join(directory, "audit-target");
    const otherRoot = join(directory, "audit-other");
    mkdirSync(targetRoot);
    mkdirSync(otherRoot);
    const target = store.addProject("Audit Target", targetRoot);
    const other = store.addProject("Audit Other", otherRoot);
    store.updateProject(target.id, { status: "tracked" });
    store.updateProject(other.id, { status: "tracked" });
    for (const project of [target, other]) {
      store.recordAgentRead({
        tool: "work_recall",
        result: {
          outcome: "recall",
          hits: [{ type: "session", id: `session-of-${project.id}`, projectId: project.id }],
        },
      });
    }

    store.deleteProject(target.id, target.name);

    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(check.prepare("SELECT project_id FROM agent_read_audit").all()).toEqual([{ project_id: other.id }]);
      expect(check.prepare("SELECT record_id FROM agent_read_audit_records").all()).toEqual([
        { record_id: `session-of-${other.id}` },
      ]);
    } finally {
      check.close();
    }
  });

  it("refuses deletion when the backup cannot be created and leaves the project intact", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-delete-memory-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Memory Fixture", root);

    expect(() => store.deleteProject(project.id, project.name)).toThrowError(ProjectDeletionError);
    expect(store.getProjectById(project.id)).toBeDefined();
  });

  it("rolls back the deletion transaction if SQLite rejects the project removal and keeps its backup", () => {
    const { store, directory, databasePath } = createDiskStore();
    const targetRoot = join(directory, "rollback-target");
    const otherRoot = join(directory, "rollback-other");
    mkdirSync(targetRoot);
    mkdirSync(otherRoot);
    const targetProject = store.addProject("Rollback Fixture", targetRoot);
    store.updateProject(targetProject.id, { status: "tracked" });
    const otherProject = store.addProject("Rollback Relation Fixture", otherRoot);
    store.updateProject(otherProject.id, { status: "tracked" });
    const targetSession = store.finalizeSession({
      projectRoot: targetRoot,
      idempotencyKey: "project-delete-rollback-session",
      title: "Rollback source session",
      summary: "This Session must remain after a transaction rollback.",
    });
    const relationSession = store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "project-delete-rollback-relation-session",
      title: "Rollback relation session",
      summary: "This Session is the opposite end of a cross-project link.",
    });
    if (targetSession.outcome !== "finalized" || relationSession.outcome !== "finalized") {
      throw new Error("Expected rollback fixture Sessions to finalize");
    }
    store.linkSessions(
      {
        sessionId: relationSession.session.id,
        relatedSessionId: targetSession.session.id,
        relation: "related",
        linked: true,
      },
      "web",
    );

    const sabotage = new DatabaseSync(databasePath);
    try {
      sabotage.exec(
        `CREATE TRIGGER reject_rollback_fixture_delete BEFORE DELETE ON projects
         WHEN OLD.id = '${targetProject.id}'
         BEGIN SELECT RAISE(ABORT, 'private SQLite detail'); END;`,
      );
    } finally {
      sabotage.close();
    }

    let deletionError: unknown;
    try {
      store.deleteProject(targetProject.id, targetProject.name);
    } catch (error) {
      deletionError = error;
    }
    expect(deletionError).toBeInstanceOf(ProjectDeletionError);
    expect(deletionError).toMatchObject({ code: "PROJECT_DELETE_FAILED", message: "PROJECT_DELETE_FAILED" });
    expect((deletionError as Error).message).not.toContain("private SQLite detail");
    expect(store.getProjectById(targetProject.id)).toBeDefined();
    expect(store.getSessionById(targetSession.session.id)).toBeDefined();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS count FROM session_links").get()).toMatchObject({ count: 1 });
      expect(check.prepare("SELECT COUNT(*) AS count FROM project_deletion_audit").get()).toMatchObject({ count: 0 });
    } finally {
      check.close();
    }
    const backups = store.listBackups();
    expect(backups.outcome).toBe("database_backups");
    if (backups.outcome === "database_backups") {
      expect(backups.backups.some((backup) => backup.fileName.includes("pre-delete-"))).toBe(true);
    }
    expect(store.getProjectByRootPath(otherRoot)?.id).toBe(otherProject.id);
  });
});
