import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProjectDataExport,
  ProjectDataRow,
  ProjectDataTable,
  ProjectDataValue,
} from "../../packages/core/src/index.js";
import {
  projectDataExportSchema,
  projectDataExportTableColumns,
  projectDataColumnValue,
  projectDataImportInputSchema,
} from "../../packages/schema/src/index.js";
import { canonicalizeProjectRoot } from "../../packages/project-policy/src/index.js";
import { remapPathPrefix } from "../../packages/storage/src/project-path-remap.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function row(table: ProjectDataTable, values: Record<string, ProjectDataValue>): ProjectDataRow {
  return Object.fromEntries(projectDataExportTableColumns[table].map((column) => [column, values[column] ?? null]));
}

function insertRow(db: DatabaseSync, table: ProjectDataTable, values: ProjectDataRow): void {
  const columns = projectDataExportTableColumns[table];
  const rowValues = columns.map((column) => {
    const value = values[column];
    if (value === undefined) {
      throw new Error(`Test data for ${table} is missing a column.`);
    }
    return value;
  });
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...rowValues,
  );
}

function createSource(): {
  root: string;
  projectRoot: string;
  store: WorkIntelligenceStore;
  projectId: string;
  sessionIds: [string, string];
} {
  const root = createRoot("work-intelligence-project-export-");
  const projectRoot = join(root, "portable-project");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(join(root, "source.sqlite"));
  stores.push(store);
  const project = store.addProject("Portable project", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const first = store.finalizeSession({
    projectRoot,
    idempotencyKey: "portable-session-one",
    title: "第一筆工作",
    summary: "保存第一筆可攜式工作記錄。",
    workSummary: {
      outcomes: ["保留成果"],
      scope: [],
      decisions: [{ text: "匯出保留 Agent 自主決策來源。", origin: "agent_autonomous" }],
      verification: [],
      nextSteps: ["Synthetic portable outstanding item."],
    },
    changedFiles: ["README.md"],
    verification: { status: "passed", summary: "單元檢查完成。" },
    events: [{ type: "execution", summary: "完成第一筆工作。" }],
    handoffContent: "交接內容測試文字。",
    completedAt: "2026-09-20T10:00:00.000Z",
  });
  const second = store.finalizeSession({
    projectRoot,
    idempotencyKey: "portable-session-two",
    title: "第二筆工作",
    summary: "保存第二筆可攜式工作記錄。",
    completedAt: "2026-09-21T10:00:00.000Z",
  });
  if (first.outcome !== "finalized" || second.outcome !== "finalized") {
    throw new Error("Test projects must accept Sessions.");
  }
  const sessionIds: [string, string] = [first.session.id, second.session.id];
  store.updateSessionWorkSummary({
    sessionId: sessionIds[1],
    idempotencyKey: "portable-legacy-decision",
    mode: "patch",
    workSummary: { decisions: ["舊格式決策相容。"] },
  });
  const db = new DatabaseSync(store.databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("UPDATE raw_snapshots SET source_path = ? WHERE session_id = ?").run(
      join(projectRoot, "handoff.md"),
      sessionIds[0],
    );
    insertRow(
      db,
      "evidence",
      row("evidence", {
        id: "evidence-portable-1",
        session_id: sessionIds[0],
        project_id: project.id,
        kind: "test",
        reference: "vitest:project-transfer",
        summary: "匯出匯入單元測試證據。",
        captured_at: "2026-09-21T11:00:00.000Z",
        voided_at: null,
        void_reason: null,
      }),
    );
    insertRow(
      db,
      "void_audit",
      row("void_audit", {
        id: "void-portable-1",
        target_type: "evidence",
        target_id: "evidence-portable-1",
        session_id: sessionIds[0],
        project_id: project.id,
        action: "restored",
        reason: "確認證據有效。",
        occurred_at: "2026-09-21T11:01:00.000Z",
      }),
    );
    insertRow(
      db,
      "session_verification_updates",
      row("session_verification_updates", {
        id: "verification-update-1",
        session_id: sessionIds[1],
        source: "web",
        previous_json: null,
        resulting_json: JSON.stringify({ status: "passed", summary: "補充驗證。" }),
        created_at: "2026-09-21T11:02:00.000Z",
      }),
    );
    insertRow(
      db,
      "session_links",
      row("session_links", {
        id: "session-link-1",
        session_id: sessionIds[1],
        related_session_id: sessionIds[0],
        relation: "continues",
        source: "agent",
        created_at: "2026-09-21T11:03:00.000Z",
      }),
    );

    const knowledgeValues = (id: string, title: string, supersedesId: string | null): ProjectDataRow =>
      row("knowledge", {
        id,
        project_id: project.id,
        session_id: sessionIds[0],
        idempotency_key: `portable-${id}`,
        kind: "pattern",
        title,
        body: "以明確資料表維持匯入順序。",
        tags_json: JSON.stringify(["storage"]),
        references_json: JSON.stringify(["tests/storage/project-data-transfer.test.ts"]),
        status: "active",
        created_at: "2026-09-21T11:04:00.000Z",
        updated_at: "2026-09-21T11:04:00.000Z",
        applies_to_json: JSON.stringify(["packages/storage/**"]),
        last_confirmed_at: null,
        last_confirmed_session_id: null,
        supersedes_id: supersedesId,
        review_json: null,
      });
    insertRow(db, "knowledge", knowledgeValues("knowledge-old", "舊 Knowledge", null));
    insertRow(db, "knowledge", knowledgeValues("knowledge-new", "新 Knowledge", "knowledge-old"));
    insertRow(
      db,
      "knowledge_audit",
      row("knowledge_audit", {
        id: "knowledge-audit-1",
        knowledge_id: "knowledge-new",
        project_id: project.id,
        action: "updated",
        before_json: JSON.stringify({ title: "舊標題" }),
        after_json: JSON.stringify({ title: "新 Knowledge" }),
        changed_fields_json: JSON.stringify(["title"]),
        occurred_at: "2026-09-21T11:05:00.000Z",
      }),
    );
    insertRow(
      db,
      "knowledge_candidate_requests",
      row("knowledge_candidate_requests", {
        id: "candidate-request-1",
        project_id: project.id,
        status: "completed",
        requested_at: "2026-09-21T11:06:00.000Z",
        started_at: "2026-09-21T11:06:01.000Z",
        completed_at: "2026-09-21T11:06:02.000Z",
        failure_reason: null,
        source_session_ids_json: JSON.stringify([sessionIds[0]]),
        candidate_count: 1,
      }),
    );
    insertRow(
      db,
      "knowledge_candidates",
      row("knowledge_candidates", {
        id: "candidate-1",
        request_id: "candidate-request-1",
        project_id: project.id,
        session_id: sessionIds[0],
        kind: "gotcha",
        title: "候選標題",
        body: "候選內容。",
        tags_json: JSON.stringify(["review"]),
        references_json: JSON.stringify([]),
        applies_to_json: JSON.stringify(["README.md"]),
        rationale: "由來源記錄支持。",
        status: "proposed",
        knowledge_id: null,
        created_at: "2026-09-21T11:06:02.000Z",
        decided_at: null,
      }),
    );
    insertRow(
      db,
      "report_synthesis_requests",
      row("report_synthesis_requests", {
        id: "report-request-1",
        idempotency_key: "portable-report-request",
        scope_type: "project",
        project_id: project.id,
        period: "month",
        range_from: "2026-09-01",
        range_to: "2026-09-30",
        status: "completed",
        requested_at: "2026-09-21T11:07:00.000Z",
        started_at: "2026-09-21T11:07:01.000Z",
        completed_at: "2026-09-21T11:07:02.000Z",
        failure_reason: null,
        source_session_ids_json: JSON.stringify(sessionIds),
      }),
    );
    insertRow(
      db,
      "report_summaries",
      row("report_summaries", {
        id: "report-summary-1",
        request_id: "report-request-1",
        period: "month",
        range_from: "2026-09-01",
        range_to: "2026-09-30",
        project_id: project.id,
        title: "九月摘要",
        executive_summary: "本月完成可攜式匯入。",
        themes_json: JSON.stringify([]),
        highlights_json: JSON.stringify([]),
        verification_json: JSON.stringify([]),
        comparison_json: JSON.stringify([]),
        risks_json: JSON.stringify([]),
        decisions_json: JSON.stringify([]),
        next_steps_json: JSON.stringify([]),
        source_session_ids_json: JSON.stringify(sessionIds),
        generated_by_agent: "test-agent",
        generated_by_model: null,
        prompt_version: "test-v1",
        created_at: "2026-09-21T11:07:02.000Z",
        is_current: 1,
      }),
    );
    insertRow(
      db,
      "metadata_backfill_requests",
      row("metadata_backfill_requests", {
        id: "metadata-request-1",
        idempotency_key: "portable-metadata-request",
        scope_type: "project",
        project_id: project.id,
        status: "completed",
        requested_at: "2026-09-21T11:08:00.000Z",
        started_at: "2026-09-21T11:08:01.000Z",
        completed_at: "2026-09-21T11:08:02.000Z",
        failure_reason: null,
        source_session_ids_json: JSON.stringify(sessionIds),
      }),
    );
    insertRow(
      db,
      "session_summary_updates",
      row("session_summary_updates", {
        id: "summary-update-1",
        session_id: sessionIds[0],
        idempotency_key: "portable-summary-update",
        mode: "append",
        summary: "補充內容。",
        previous_summary: "原摘要。",
        resulting_summary: "原摘要。補充內容。",
        created_at: "2026-09-21T11:09:00.000Z",
      }),
    );
    insertRow(
      db,
      "session_work_summary_updates",
      row("session_work_summary_updates", {
        id: "work-summary-update-1",
        session_id: sessionIds[0],
        idempotency_key: "portable-work-summary-update",
        mode: "patch",
        work_summary_json: JSON.stringify({ decisions: ["保留舊決策"] }),
        previous_work_summary_json: JSON.stringify({ decisions: [] }),
        resulting_work_summary_json: JSON.stringify({ decisions: ["保留舊決策"] }),
        created_at: "2026-09-21T11:09:01.000Z",
      }),
    );
  } finally {
    db.close();
  }
  return { root, projectRoot, store, projectId: project.id, sessionIds };
}

function total(counts: Record<string, number | undefined>): number {
  return Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

function seedCleanupReview(
  store: WorkIntelligenceStore,
  projectId: string,
  sourceSessionId: string,
  evidenceSessionId: string,
  prefix: string,
  accepted = false,
): void {
  const db = new DatabaseSync(store.databasePath);
  try {
    const item = db
      .prepare(
        `SELECT id, position, text, updated_at
         FROM outstanding_items WHERE source_session_id = ? ORDER BY position, id LIMIT 1`,
      )
      .get(sourceSessionId) as { id: string; position: number; text: string; updated_at: string } | undefined;
    const source = db
      .prepare("SELECT updated_at, completed_at FROM sessions WHERE id = ? AND project_id = ?")
      .get(sourceSessionId, projectId) as { updated_at: string; completed_at: string } | undefined;
    const evidence = db
      .prepare("SELECT updated_at, completed_at FROM sessions WHERE id = ? AND project_id = ?")
      .get(evidenceSessionId, projectId) as { updated_at: string; completed_at: string } | undefined;
    if (!item || !source || !evidence)
      throw new Error("Cleanup review fixture needs same-project source and evidence Sessions.");

    const createdAt = "2026-09-22T12:00:00.000Z";
    const requestId = `${prefix}-request`;
    const submissionId = `${prefix}-submission`;
    const requestItemId = `${prefix}-request-item`;
    const proposalId = `${prefix}-proposal`;
    insertRow(
      db,
      "outstanding_cleanup_requests",
      row("outstanding_cleanup_requests", {
        id: requestId,
        project_id: projectId,
        idempotency_key: `${prefix}-request-key`,
        status: accepted ? "completed" : "awaiting_review",
        requested_at: createdAt,
        completed_at: accepted ? createdAt : null,
        item_count: 1,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_submissions",
      row("outstanding_cleanup_submissions", {
        id: submissionId,
        request_id: requestId,
        project_id: projectId,
        idempotency_key: `${prefix}-submission-key`,
        payload_hash: "a".repeat(64),
        created_at: createdAt,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_request_items",
      row("outstanding_cleanup_request_items", {
        id: requestItemId,
        request_id: requestId,
        project_id: projectId,
        item_id: item.id,
        source_session_id: sourceSessionId,
        position: item.position,
        text: item.text,
        item_updated_at: item.updated_at,
        source_updated_at: source.updated_at,
        source_fingerprint: "source-version-fixture",
        source_completed_at: source.completed_at,
        examined_submission_id: submissionId,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_proposals",
      row("outstanding_cleanup_proposals", {
        id: proposalId,
        request_id: requestId,
        project_id: projectId,
        request_item_id: requestItemId,
        submission_id: submissionId,
        target_status: "completed",
        reason: "A later same-project synthetic Session verifies this outcome.",
        review_status: accepted ? "accepted" : "pending",
        created_at: createdAt,
        decided_at: accepted ? createdAt : null,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_proposal_evidence",
      row("outstanding_cleanup_proposal_evidence", {
        id: `${prefix}-evidence-link`,
        proposal_id: proposalId,
        project_id: projectId,
        session_id: evidenceSessionId,
        session_updated_at: evidence.updated_at,
        session_fingerprint: "evidence-version-fixture",
        session_completed_at: evidence.completed_at,
      }),
    );
    if (accepted) {
      db.prepare("UPDATE outstanding_items SET status = 'completed', updated_at = ? WHERE id = ?").run(
        createdAt,
        item.id,
      );
      insertRow(
        db,
        "outstanding_item_events",
        row("outstanding_item_events", {
          id: `${prefix}-event`,
          item_id: item.id,
          project_id: projectId,
          from_status: "pending",
          to_status: "completed",
          source: "web",
          actor_session_id: null,
          created_at: createdAt,
          cleanup_request_id: requestId,
          cleanup_proposal_id: proposalId,
        }),
      );
    }
  } finally {
    db.close();
  }
}

describe("portable project data transfer", () => {
  // V8 coverage instruments fixture setup; the import itself still has a strict 20 s assertion below.
  it("imports 5,000 sessions and 50,000 events within the 20-second performance budget", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const baseSession = bundle.tables.sessions[0];
    const baseEvent = bundle.tables.work_events[0];
    if (!baseSession || !baseEvent) {
      throw new Error("The benchmark fixture needs a Session and work event template.");
    }

    const sessionRows = [...bundle.tables.sessions];
    const db = new DatabaseSync(source.store.databasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      const sessionColumns = projectDataExportTableColumns.sessions;
      const insertSession = db.prepare(
        `INSERT INTO sessions (${sessionColumns.join(", ")}) VALUES (${sessionColumns.map(() => "?").join(", ")})`,
      );
      for (let index = sessionRows.length; index < 5_000; index += 1) {
        const session: ProjectDataRow = {
          ...baseSession,
          id: `benchmark-session-${index}`,
          project_id: source.projectId,
          idempotency_key: `benchmark-session-key-${index}`,
          title: `Benchmark session ${index}`,
          summary: `Synthetic import benchmark session ${index}.`,
        };
        insertSession.run(...sessionColumns.map((column) => session[column] ?? null));
        sessionRows.push(session);
      }

      const eventColumns = projectDataExportTableColumns.work_events;
      const insertEvent = db.prepare(
        `INSERT INTO work_events (${eventColumns.join(", ")}) VALUES (${eventColumns.map(() => "?").join(", ")})`,
      );
      const existingEvents = bundle.tables.work_events.length;
      for (let index = existingEvents; index < 50_000; index += 1) {
        const session = sessionRows[index % sessionRows.length];
        if (!session) {
          throw new Error("The benchmark fixture needs a Session for every event.");
        }
        const event: ProjectDataRow = {
          ...baseEvent,
          id: `benchmark-event-${index}`,
          session_id: String(session.id),
          summary: `Synthetic import benchmark event ${index}.`,
        };
        insertEvent.run(...eventColumns.map((column) => event[column] ?? null));
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    } finally {
      db.close();
    }

    const largeBundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const beforeImport = destination.getChangeToken();
    const startedAt = performance.now();
    const result = destination.importProjectData({ bundle: largeBundle });
    const elapsedMs = performance.now() - startedAt;

    expect(result.additions.sessions).toBe(5_000);
    expect(result.additions.work_events).toBe(50_000);
    expect(total(result.conflicts)).toBe(0);
    expect(destination.getChangeToken().dataRevision).toBeGreaterThan(beforeImport.dataRevision);
    expect(elapsedMs).toBeLessThanOrEqual(20_000);
    console.info(
      `Synthetic portable import: 5,000 sessions + 50,000 events in ${elapsedMs.toFixed(1)} ms (Node ${process.version}).`,
    );
  }, 60_000);

  it("round-trips project data, pauses new projects, re-indexes search state, and stays idempotent while open", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.tables.session_links).toHaveLength(1);
    expect(bundle.tables.session_decisions).toHaveLength(2);
    expect(bundle.tables.session_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: source.sessionIds[0],
          text: "匯出保留 Agent 自主決策來源。",
          origin: "agent_autonomous",
          review_status: "pending",
        }),
        expect.objectContaining({
          session_id: source.sessionIds[1],
          text: "舊格式決策相容。",
          origin: "unspecified",
          review_status: "confirmed",
        }),
      ]),
    );
    expect(bundle.tables.knowledge).toHaveLength(2);
    expect(bundle.tables.report_summaries).toHaveLength(1);
    expect(bundle.tables.raw_snapshots[0]?.source_path).toBe(join(source.projectRoot, "handoff.md"));

    const destinationRoot = join(source.root, "new-computer-project");
    const destination = new WorkIntelligenceStore(join(source.root, "destination.sqlite"));
    stores.push(destination);
    const input = {
      bundle,
      remap: [{ from: source.projectRoot, to: destinationRoot }],
    };
    const preview = destination.previewProjectDataImport(input);
    expect(preview.additions.projects).toBe(1);
    expect(preview.additions.sessions).toBe(2);
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.selectedProjects).toMatchObject([
      { id: source.projectId, rootPath: destinationRoot, resolution: "new" },
    ]);
    expect(preview.remappedPaths).toEqual([{ projects: 1, snapshots: 1 }]);
    expect(destination.listProjects()).toHaveLength(0);

    const result = destination.importProjectData(input);
    expect(total(result.additions)).toBe(total(preview.additions));
    expect(destination.listProjects()).toMatchObject([
      { id: source.projectId, rootPath: destinationRoot, status: "paused" },
    ]);
    const imported = destination.exportProjectData({ type: "all" });
    const expected = structuredClone(bundle.tables);
    const project = expected.projects[0];
    if (!project) {
      throw new Error("The fixture should contain a project.");
    }
    project.root_path = destinationRoot;
    project.status = "paused";
    const snapshot = expected.raw_snapshots[0];
    if (snapshot) {
      snapshot.source_path = join(destinationRoot, "handoff.md");
    }
    expect(imported.tables).toEqual(expected);

    const db = new DatabaseSync(destination.databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS total FROM project_data_import_audits").get()).toEqual({ total: 1 });
      // Imported documents are re-indexed right after the import commits, not by the first read.
      expect(db.prepare("SELECT COUNT(*) AS total FROM search_dirty").get()).toEqual({ total: 0 });
      const indexedSessions = db
        .prepare(
          `SELECT COUNT(DISTINCT c.doc_id) AS total FROM search_chunks c
           WHERE c.doc_type = 'session' AND c.doc_id IN (SELECT id FROM sessions)`,
        )
        .get() as { total: number };
      const liveSessions = db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE voided_at IS NULL").get() as {
        total: number;
      };
      expect(liveSessions.total).toBeGreaterThan(0);
      expect(indexedSessions.total).toBe(liveSessions.total);
      expect(db.prepare("SELECT source_digest FROM project_data_import_audits").get()).toMatchObject({
        source_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      db.close();
    }

    const repeated = destination.previewProjectDataImport(input);
    expect(total(repeated.additions)).toBe(0);
    expect(total(repeated.skipped)).toBe(total(preview.additions));
    const repeatedResult = destination.importProjectData(input);
    expect(total(repeatedResult.additions)).toBe(0);
    expect(destination.listProjects()).toHaveLength(1);
  });

  it("round-trips cleanup review records, scopes them to one project, and remaps only project IDs", () => {
    const source = createSource();
    seedCleanupReview(source.store, source.projectId, source.sessionIds[0], source.sessionIds[1], "cleanup-main", true);

    const otherRoot = join(source.root, "cleanup-other-project");
    mkdirSync(otherRoot);
    const otherProject = source.store.addProject("Cleanup subset fixture", otherRoot);
    source.store.updateProject(otherProject.id, { status: "tracked" });
    const otherSource = source.store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "cleanup-subset-source",
      title: "Synthetic second-project source",
      summary: "Synthetic second-project source for transfer scope checks.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["Synthetic second-project obligation."],
      },
      completedAt: "2026-09-22T10:00:00.000Z",
    });
    const otherEvidence = source.store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "cleanup-subset-evidence",
      title: "Synthetic second-project evidence",
      summary: "Synthetic later evidence for transfer scope checks.",
      completedAt: "2026-09-23T10:00:00.000Z",
    });
    if (otherSource.outcome !== "finalized" || otherEvidence.outcome !== "finalized") {
      throw new Error("Expected the second cleanup project Sessions to finalize.");
    }
    seedCleanupReview(source.store, otherProject.id, otherSource.session.id, otherEvidence.session.id, "cleanup-other");

    const bundle = source.store.exportProjectData({ type: "all" });
    expect(bundle.tables.outstanding_cleanup_requests).toHaveLength(2);
    expect(bundle.tables.outstanding_cleanup_submissions).toHaveLength(2);
    expect(bundle.tables.outstanding_cleanup_request_items).toHaveLength(2);
    expect(bundle.tables.outstanding_cleanup_proposals).toHaveLength(2);
    expect(bundle.tables.outstanding_cleanup_proposal_evidence).toHaveLength(2);

    const subset = new WorkIntelligenceStore(":memory:");
    stores.push(subset);
    const subsetPreview = subset.previewProjectDataImport({ bundle, projectId: source.projectId });
    expect(total(subsetPreview.conflicts)).toBe(0);
    expect(subsetPreview.additions).toMatchObject({
      outstanding_cleanup_requests: 1,
      outstanding_cleanup_submissions: 1,
      outstanding_cleanup_request_items: 1,
      outstanding_cleanup_proposals: 1,
      outstanding_cleanup_proposal_evidence: 1,
    });

    const remappedRoot = join(source.root, "cleanup-remapped-project");
    mkdirSync(remappedRoot);
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const existingProject = destination.addProject("Matched cleanup project", remappedRoot);
    destination.updateProject(existingProject.id, { status: "tracked" });
    const importInput = {
      bundle,
      projectId: source.projectId,
      remap: [{ from: source.projectRoot, to: remappedRoot }],
    };
    const preview = destination.previewProjectDataImport(importInput);
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.selectedProjects).toMatchObject([
      { id: source.projectId, rootPath: remappedRoot, resolution: "existing" },
    ]);
    expect(preview.additions).toMatchObject({
      outstanding_cleanup_requests: 1,
      outstanding_cleanup_submissions: 1,
      outstanding_cleanup_request_items: 1,
      outstanding_cleanup_proposals: 1,
      outstanding_cleanup_proposal_evidence: 1,
    });
    destination.importProjectData(importInput);
    const imported = destination.exportProjectData({ type: "project", projectId: existingProject.id });
    expect(imported.tables.outstanding_cleanup_requests[0]?.project_id).toBe(existingProject.id);
    expect(imported.tables.outstanding_cleanup_request_items[0]).toMatchObject({
      item_id: bundle.tables.outstanding_cleanup_request_items.find((item) => item.project_id === source.projectId)
        ?.item_id,
      project_id: existingProject.id,
      source_session_id: source.sessionIds[0],
    });
    expect(imported.tables.outstanding_cleanup_proposal_evidence[0]).toMatchObject({
      session_id: source.sessionIds[1],
      project_id: existingProject.id,
    });
    expect(imported.tables.outstanding_item_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cleanup_request_id: "cleanup-main-request",
          cleanup_proposal_id: "cleanup-main-proposal",
          project_id: existingProject.id,
        }),
      ]),
    );
  });

  it("rejects cleanup imports with cross-project references or duplicate active requests", () => {
    const source = createSource();
    seedCleanupReview(source.store, source.projectId, source.sessionIds[0], source.sessionIds[1], "cleanup-main", true);

    const otherRoot = join(source.root, "cleanup-conflict-project");
    mkdirSync(otherRoot);
    const otherProject = source.store.addProject("Cleanup conflict project", otherRoot);
    source.store.updateProject(otherProject.id, { status: "tracked" });
    const otherSource = source.store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "cleanup-conflict-source",
      title: "Synthetic conflicting source",
      summary: "Synthetic source for transfer conflict checks.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["Synthetic conflict-project obligation."],
      },
      completedAt: "2026-09-22T10:00:00.000Z",
    });
    const otherEvidence = source.store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "cleanup-conflict-evidence",
      title: "Synthetic conflicting evidence",
      summary: "Synthetic later evidence for transfer conflict checks.",
      completedAt: "2026-09-23T10:00:00.000Z",
    });
    if (otherSource.outcome !== "finalized" || otherEvidence.outcome !== "finalized") {
      throw new Error("Expected the second cleanup project Sessions to finalize.");
    }
    seedCleanupReview(source.store, otherProject.id, otherSource.session.id, otherEvidence.session.id, "cleanup-other");

    const sameProjectSource = source.store.finalizeSession({
      projectRoot: source.projectRoot,
      idempotencyKey: "cleanup-same-project-source",
      title: "Synthetic same-project source",
      summary: "Synthetic second same-project cleanup source.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [],
        verification: [],
        nextSteps: ["Synthetic same-project second obligation."],
      },
      completedAt: "2026-09-24T10:00:00.000Z",
    });
    const sameProjectEvidence = source.store.finalizeSession({
      projectRoot: source.projectRoot,
      idempotencyKey: "cleanup-same-project-evidence",
      title: "Synthetic same-project evidence",
      summary: "Synthetic later same-project evidence.",
      completedAt: "2026-09-25T10:00:00.000Z",
    });
    if (sameProjectSource.outcome !== "finalized" || sameProjectEvidence.outcome !== "finalized") {
      throw new Error("Expected the same-project cleanup Sessions to finalize.");
    }
    seedCleanupReview(
      source.store,
      source.projectId,
      sameProjectSource.session.id,
      sameProjectEvidence.session.id,
      "cleanup-main-second",
    );

    const bundle = source.store.exportProjectData({ type: "all" });
    const mainRequest = bundle.tables.outstanding_cleanup_requests.find(
      (request) => request.project_id === source.projectId,
    );
    const otherRequest = bundle.tables.outstanding_cleanup_requests.find(
      (request) => request.project_id === otherProject.id,
    );
    const mainItem = bundle.tables.outstanding_cleanup_request_items.find(
      (item) => item.project_id === source.projectId,
    );
    const mainEvidence = bundle.tables.outstanding_cleanup_proposal_evidence.find(
      (item) => item.project_id === source.projectId,
    );
    const sameProjectRequest = bundle.tables.outstanding_cleanup_requests.find(
      (request) => request.id === "cleanup-main-second-request",
    );
    const sameProjectSubmission = bundle.tables.outstanding_cleanup_submissions.find(
      (submission) => submission.request_id === "cleanup-main-second-request",
    );
    const mainEvent = bundle.tables.outstanding_item_events.find(
      (event) => event.cleanup_request_id === mainRequest?.id,
    );
    if (
      !mainRequest ||
      !otherRequest ||
      !mainItem ||
      !mainEvidence ||
      !sameProjectRequest ||
      !sameProjectSubmission ||
      !mainEvent
    ) {
      throw new Error("Expected complete synthetic cleanup review records for both projects.");
    }

    const duplicateActive = {
      ...otherRequest,
      id: "zz-cleanup-duplicate-active-request",
      idempotency_key: "cleanup-duplicate-active-key",
    };
    const mainRequestIdempotencyKey = mainRequest.idempotency_key;
    if (typeof mainRequestIdempotencyKey !== "string") {
      throw new Error("Expected a string request idempotency key in the portable export.");
    }
    const duplicateRequestKey = {
      ...otherRequest,
      id: "zz-cleanup-duplicate-request-key",
      idempotency_key: mainRequestIdempotencyKey,
      status: "completed",
      completed_at: "2026-09-22T12:00:00.000Z",
    };
    const mainSubmission = bundle.tables.outstanding_cleanup_submissions.find(
      (submission) => submission.request_id === mainRequest.id,
    );
    const mainProposal = bundle.tables.outstanding_cleanup_proposals.find(
      (proposal) => proposal.request_id === mainRequest.id,
    );
    if (!mainSubmission || !mainProposal)
      throw new Error("Expected a submission and proposal for the primary request.");
    const duplicateSubmission = {
      ...mainSubmission,
      id: "zz-cleanup-duplicate-submission",
    };
    const duplicateRequestItem = {
      ...mainItem,
      id: "zz-cleanup-duplicate-request-item",
    };
    const duplicateProposal = {
      ...mainProposal,
      id: "zz-cleanup-duplicate-proposal",
    };
    const duplicateEvidence = {
      ...mainEvidence,
      id: "zz-cleanup-duplicate-evidence",
    };

    const crossProjectItemBundle = structuredClone(bundle);
    const crossProjectItem = crossProjectItemBundle.tables.outstanding_cleanup_request_items.find(
      (item) => item.project_id === source.projectId,
    );
    const otherItem = crossProjectItemBundle.tables.outstanding_cleanup_request_items.find(
      (item) => item.project_id === otherProject.id,
    );
    if (!crossProjectItem || !otherItem) throw new Error("Expected request items for both projects.");
    const otherItemId = otherItem.item_id;
    if (typeof otherItemId !== "string") throw new Error("Expected a string item id in the portable export.");
    crossProjectItem.item_id = otherItemId;
    crossProjectItem.source_session_id = otherSource.session.id;

    const sameProjectWrongSourceBundle = structuredClone(bundle);
    const wrongSourceItem = sameProjectWrongSourceBundle.tables.outstanding_cleanup_request_items.find(
      (item) => item.project_id === source.projectId,
    );
    if (!wrongSourceItem) throw new Error("Expected a same-project cleanup request item.");
    wrongSourceItem.source_session_id = source.sessionIds[1];

    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const duplicateEvidenceBundle = structuredClone(bundle);
    duplicateEvidenceBundle.tables.outstanding_cleanup_proposal_evidence.push(duplicateEvidence);
    const duplicateEvidencePreview = destination.previewProjectDataImport({ bundle: duplicateEvidenceBundle });
    expect(duplicateEvidencePreview.conflictDetails).toContainEqual({
      table: "outstanding_cleanup_proposal_evidence",
      id: duplicateEvidence.id,
      reason: "匯入檔內有重複的唯一識別值。",
      category: "unique",
    });

    const crossProjectItemPreview = destination.previewProjectDataImport({ bundle: crossProjectItemBundle });
    expect(crossProjectItemPreview.conflictDetails).toContainEqual({
      table: "outstanding_cleanup_request_items",
      id: crossProjectItem.id,
      reason: "清理快照項目必須引用同一專案中可用的待結項。",
      category: "dependency",
    });
    const wrongSourcePreview = destination.previewProjectDataImport({ bundle: sameProjectWrongSourceBundle });
    expect(wrongSourcePreview.conflictDetails).toContainEqual({
      table: "outstanding_cleanup_request_items",
      id: wrongSourceItem.id,
      reason: "清理快照項目的來源 Session 必須與待結項來源一致。",
      category: "dependency",
    });

    const wrongSubmissionBundle = structuredClone(bundle);
    const wrongSubmissionProposal = wrongSubmissionBundle.tables.outstanding_cleanup_proposals.find(
      (proposal) => proposal.request_id === mainRequest.id,
    );
    if (!wrongSubmissionProposal) throw new Error("Expected a proposal for the primary cleanup request.");
    const sameProjectSubmissionId = sameProjectSubmission.id;
    if (typeof sameProjectSubmissionId !== "string") {
      throw new Error("Expected a string submission id in the portable export.");
    }
    wrongSubmissionProposal.submission_id = sameProjectSubmissionId;
    const wrongSubmissionPreview = destination.previewProjectDataImport({ bundle: wrongSubmissionBundle });
    expect(wrongSubmissionPreview.conflictDetails).toContainEqual({
      table: "outstanding_cleanup_proposals",
      id: wrongSubmissionProposal.id,
      reason: "清理提案及其關聯資料必須屬於同一專案與請求。",
      category: "dependency",
    });

    const mismatchedExaminedSubmissionBundle = structuredClone(bundle);
    const extraSameRequestSubmission = {
      ...mainSubmission,
      id: "cleanup-main-alternate-submission",
      idempotency_key: "cleanup-main-alternate-submission-key",
    };
    mismatchedExaminedSubmissionBundle.tables.outstanding_cleanup_submissions.push(extraSameRequestSubmission);
    const mismatchedExaminedProposal = mismatchedExaminedSubmissionBundle.tables.outstanding_cleanup_proposals.find(
      (proposal) => proposal.request_id === mainRequest.id,
    );
    if (!mismatchedExaminedProposal) throw new Error("Expected a proposal for the primary cleanup request.");
    mismatchedExaminedProposal.submission_id = extraSameRequestSubmission.id;
    const mismatchedExaminedPreview = destination.previewProjectDataImport({
      bundle: mismatchedExaminedSubmissionBundle,
    });
    expect(mismatchedExaminedPreview.conflictDetails).toContainEqual({
      table: "outstanding_cleanup_proposals",
      id: mismatchedExaminedProposal.id,
      reason: "清理提案提交紀錄必須與快照項目檢視的提交一致。",
      category: "dependency",
    });

    const emptyCleanupAuditIdsBundle = structuredClone(bundle);
    const emptyCleanupAuditEvent = emptyCleanupAuditIdsBundle.tables.outstanding_item_events.find(
      (event) => event.cleanup_request_id === mainRequest.id,
    );
    if (!emptyCleanupAuditEvent) throw new Error("Expected a linked cleanup audit event.");
    emptyCleanupAuditEvent.cleanup_request_id = "";
    emptyCleanupAuditEvent.cleanup_proposal_id = "";
    const emptyCleanupAuditPreview = destination.previewProjectDataImport({ bundle: emptyCleanupAuditIdsBundle });
    expect(emptyCleanupAuditPreview.conflictDetails).toContainEqual({
      table: "outstanding_item_events",
      id: emptyCleanupAuditEvent.id,
      reason: "清理稽核事件引用的請求或提案發生衝突或不存在。",
      category: "dependency",
    });

    bundle.tables.outstanding_cleanup_requests.push(duplicateActive, duplicateRequestKey);
    bundle.tables.outstanding_cleanup_submissions.push(duplicateSubmission);
    bundle.tables.outstanding_cleanup_request_items.push(duplicateRequestItem);
    bundle.tables.outstanding_cleanup_proposals.push(duplicateProposal);
    mainEvidence.session_id = otherEvidence.session.id;
    mainEvent.cleanup_proposal_id =
      bundle.tables.outstanding_cleanup_proposals.find((proposal) => proposal.request_id === otherRequest.id)?.id ??
      null;

    const preview = destination.previewProjectDataImport({ bundle });
    expect(preview.conflictDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "outstanding_cleanup_requests",
          id: duplicateActive.id,
          reason: "匯入檔內有重複的唯一識別值。",
        }),
        expect.objectContaining({
          table: "outstanding_cleanup_requests",
          id: duplicateRequestKey.id,
          reason: "匯入檔內有重複的唯一識別值。",
        }),
        expect.objectContaining({
          table: "outstanding_cleanup_submissions",
          id: duplicateSubmission.id,
          reason: "匯入檔內有重複的唯一識別值。",
        }),
        expect.objectContaining({
          table: "outstanding_cleanup_request_items",
          id: duplicateRequestItem.id,
          reason: "匯入檔內有重複的唯一識別值。",
        }),
        expect.objectContaining({
          table: "outstanding_cleanup_proposals",
          id: duplicateProposal.id,
          reason: "匯入檔內有重複的唯一識別值。",
        }),
        expect.objectContaining({
          table: "outstanding_cleanup_proposal_evidence",
          id: mainEvidence.id,
          reason: "清理提案證據 Session 必須位於提案所屬專案。",
        }),
        expect.objectContaining({
          table: "outstanding_item_events",
          id: mainEvent.id,
          reason: "清理稽核事件的請求、提案、項目必須屬於同一專案與請求。",
        }),
      ]),
    );
  });

  it("carries the confirmed-empty changed files flag and still imports exports made before it existed", () => {
    const source = createSource();
    const sourceDb = new DatabaseSync(source.store.databasePath);
    try {
      sourceDb.prepare("UPDATE sessions SET changed_files_confirmed = 1 WHERE id = ?").run(source.sessionIds[0]);
    } finally {
      sourceDb.close();
    }
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const confirmedRow = bundle.tables.sessions.find((session) => session.id === source.sessionIds[0]);
    expect(confirmedRow?.changed_files_confirmed).toBe(1);

    const confirmedFlag = (store: WorkIntelligenceStore): unknown => {
      const db = new DatabaseSync(store.databasePath);
      try {
        return db.prepare("SELECT changed_files_confirmed FROM sessions WHERE id = ?").get(source.sessionIds[0]);
      } finally {
        db.close();
      }
    };

    const current = new WorkIntelligenceStore(join(source.root, "current-format.sqlite"));
    stores.push(current);
    current.importProjectData({ bundle, remap: [] });
    expect(confirmedFlag(current)).toEqual({ changed_files_confirmed: 1 });

    // An export written before the column existed has no such key; it must import with the default.
    const legacy = structuredClone(bundle);
    for (const session of legacy.tables.sessions) {
      delete session.changed_files_confirmed;
      delete session.redaction_count;
    }
    expect(projectDataExportSchema.safeParse(legacy).success).toBe(true);
    const older = new WorkIntelligenceStore(join(source.root, "legacy-format.sqlite"));
    stores.push(older);
    const result = older.importProjectData({ bundle: legacy, remap: [] });
    expect(result.additions.sessions).toBe(2);
    expect(confirmedFlag(older)).toEqual({ changed_files_confirmed: 0 });
    const olderSession = older.getSessionById(source.sessionIds[0]);
    expect(olderSession?.redactionCount).toBe(0);
  });

  it("carries the stored candidate advisory, imports schema-32 exports without it, and never conflicts on it", () => {
    const source = createSource();
    const advisory = JSON.stringify([
      { relation: "possible_duplicate", type: "knowledge", id: "knowledge-1", status: "active", score: 0.42 },
    ]);
    runSql(source.store, "UPDATE knowledge_candidates SET overlaps_json = ? WHERE id = 'candidate-1'", advisory);
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(bundle.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(bundle.tables.knowledge_candidates[0]?.overlaps_json).toBe(advisory);
    const advisoryOf = (store: WorkIntelligenceStore) =>
      readRows(store, "SELECT overlaps_json FROM knowledge_candidates WHERE id = 'candidate-1'");

    for (const strategy of ["merge", "newer-wins"] as const) {
      const current = new WorkIntelligenceStore(join(source.root, `advisory-${strategy}.sqlite`));
      stores.push(current);
      current.importProjectData({ bundle, remap: [], strategy });
      expect(advisoryOf(current)).toEqual([{ overlaps_json: advisory }]);
      // A local copy without the advisory (submitted before schema 33) is the same candidate: skipped, kept local.
      runSql(current, "UPDATE knowledge_candidates SET overlaps_json = NULL WHERE id = 'candidate-1'");
      const again = current.previewProjectDataImport({ bundle, remap: [], strategy });
      expect(total(again.conflicts)).toBe(0);
      expect(total(again.additions)).toBe(0);
      current.importProjectData({ bundle, remap: [], strategy });
      expect(advisoryOf(current)).toEqual([{ overlaps_json: null }]);
    }

    // A schema-32 export has no such key; it imports with the advisory empty.
    const legacy = structuredClone(bundle);
    legacy.schemaVersion = 32;
    for (const candidate of legacy.tables.knowledge_candidates) delete candidate.overlaps_json;
    expect(projectDataExportSchema.safeParse(legacy).success).toBe(true);
    const older = new WorkIntelligenceStore(join(source.root, "advisory-legacy.sqlite"));
    stores.push(older);
    expect(older.importProjectData({ bundle: legacy, remap: [] }).additions.knowledge_candidates).toBe(1);
    expect(advisoryOf(older)).toEqual([{ overlaps_json: null }]);
    // Older and newer export schemas stay refused, as before.
    for (const schemaVersion of [30, LATEST_SCHEMA_VERSION + 1]) {
      expect(() => older.previewProjectDataImport({ bundle: { ...legacy, schemaVersion }, remap: [] })).toThrow(
        /schema 版本/,
      );
    }

    // Only the stored form is accepted: ids, statuses and scores, no text and no unknown keys.
    for (const invalid of [
      "{}",
      JSON.stringify([{ relation: "possible_duplicate", type: "knowledge", id: "k", status: "active", score: 2 }]),
      JSON.stringify([
        { relation: "possible_duplicate", type: "knowledge", id: "k", status: "active", score: 0.5, title: "Text" },
      ]),
    ]) {
      const tampered = structuredClone(bundle);
      tampered.tables.knowledge_candidates[0]!.overlaps_json = invalid;
      expect(projectDataExportSchema.safeParse(tampered).success).toBe(false);
    }
  });

  it("round-trips the Agent source columns and imports exports made before they existed", () => {
    const source = createSource();
    const sourceDb = new DatabaseSync(source.store.databasePath);
    try {
      sourceDb
        .prepare("UPDATE sessions SET agent_client = ?, agent_model = ? WHERE id = ?")
        .run("fiction-client", "fiction-model-1", source.sessionIds[0]);
    } finally {
      sourceDb.close();
    }
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const exported = bundle.tables.sessions.find((session) => session.id === source.sessionIds[0]);
    expect(exported).toMatchObject({ agent_client: "fiction-client", agent_model: "fiction-model-1" });

    const current = new WorkIntelligenceStore(join(source.root, "agent-current.sqlite"));
    stores.push(current);
    current.importProjectData({ bundle, remap: [] });
    expect(current.getSessionById(source.sessionIds[0])).toMatchObject({
      agentClient: "fiction-client",
      agentModel: "fiction-model-1",
    });

    const legacy = structuredClone(bundle);
    for (const session of legacy.tables.sessions) {
      delete session.agent_client;
      delete session.agent_model;
    }
    expect(projectDataExportSchema.safeParse(legacy).success).toBe(true);
    const older = new WorkIntelligenceStore(join(source.root, "agent-legacy.sqlite"));
    stores.push(older);
    older.importProjectData({ bundle: legacy, remap: [] });
    const imported = older.getSessionById(source.sessionIds[0]);
    expect(imported?.agentClient).toBeUndefined();
    expect(imported?.agentModel).toBeUndefined();
  });

  it("masks legacy secrets in portable exports and sanitizes secrets before import", () => {
    const source = createSource();
    const exportToken = `gho_${"A".repeat(36)}`;
    const sourceDb = new DatabaseSync(source.store.databasePath);
    try {
      sourceDb.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(exportToken, source.sessionIds[0]);
      sourceDb
        .prepare("UPDATE work_events SET summary = ? WHERE session_id = ?")
        .run(exportToken, source.sessionIds[0]);
      sourceDb
        .prepare("UPDATE outstanding_items SET text = ? WHERE source_session_id = ?")
        .run(exportToken, source.sessionIds[0]);
    } finally {
      sourceDb.close();
    }

    const exported = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(JSON.stringify(exported)).not.toContain(exportToken);
    expect(exported.tables.sessions.find((session) => session.id === source.sessionIds[0])?.redaction_count).toBe(4);

    const importToken = `sk-${"B".repeat(24)}`;
    const contaminated = structuredClone(exported);
    const session = contaminated.tables.sessions.find((item) => item.id === source.sessionIds[0]);
    const snapshot = contaminated.tables.raw_snapshots.find((item) => item.session_id === source.sessionIds[0]);
    if (!session || !snapshot) {
      throw new Error("The fixture should include a Session and handoff snapshot.");
    }
    session.summary = importToken;
    snapshot.content = `handoff ${importToken}`;

    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const imported = destination.importProjectData({ bundle: contaminated, remap: [] });
    expect(imported.redactions).toMatchObject({ total: 2, byKind: { openai_token: 2 } });
    const importedBundle = destination.exportProjectData({ type: "all" });
    expect(JSON.stringify(importedBundle)).not.toContain(importToken);
    expect(importedBundle.tables.sessions.find((item) => item.id === source.sessionIds[0])?.redaction_count).toBe(6);
  });

  it("redacts cleanup snapshot text and proposal reasons in exports and imports", () => {
    const source = createSource();
    seedCleanupReview(source.store, source.projectId, source.sessionIds[0], source.sessionIds[1], "cleanup-redaction");
    const token = `gho_${"C".repeat(36)}`;
    const sourceDb = new DatabaseSync(source.store.databasePath);
    try {
      sourceDb
        .prepare("UPDATE outstanding_cleanup_request_items SET text = ? WHERE request_id = ?")
        .run(token, "cleanup-redaction-request");
      sourceDb
        .prepare("UPDATE outstanding_cleanup_proposals SET reason = ? WHERE request_id = ?")
        .run(token, "cleanup-redaction-request");
    } finally {
      sourceDb.close();
    }

    const exported = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(JSON.stringify(exported)).not.toContain(token);
    expect(exported.tables.outstanding_cleanup_request_items[0]?.text).not.toBe(token);
    expect(exported.tables.outstanding_cleanup_proposals[0]?.reason).not.toBe(token);
    expect(exported.tables.sessions.find((session) => session.id === source.sessionIds[0])?.redaction_count).toBe(2);

    const contaminated = structuredClone(exported);
    const cleanupItem = contaminated.tables.outstanding_cleanup_request_items[0];
    const proposal = contaminated.tables.outstanding_cleanup_proposals[0];
    if (!cleanupItem || !proposal) throw new Error("Expected cleanup text rows in the portable export.");
    cleanupItem.text = token;
    proposal.reason = token;
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const imported = destination.importProjectData({ bundle: contaminated, remap: [] });
    const importedRedactions = imported.redactions;
    if (!importedRedactions) throw new Error("Expected the import redaction summary.");
    expect(importedRedactions.total).toBe(2);
    const importedBundle = destination.exportProjectData({ type: "all" });
    expect(JSON.stringify(importedBundle)).not.toContain(token);
    expect(importedBundle.tables.sessions.find((session) => session.id === source.sessionIds[0])?.redaction_count).toBe(
      4,
    );
  });

  it("imports one selected project from an all-project file", () => {
    const source = createSource();
    const secondRoot = join(source.root, "second-project");
    mkdirSync(secondRoot);
    source.store.addProject("Second project", secondRoot);
    const bundle = source.store.exportProjectData({ type: "all" });
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);

    const preview = destination.previewProjectDataImport({ bundle, projectId: source.projectId });
    expect(preview.selectedProjects).toHaveLength(1);
    expect(preview.selectedProjects[0]?.id).toBe(source.projectId);
    expect(preview.additions.projects).toBe(1);
    expect(preview.additions.sessions).toBe(2);
  });

  it("matches an existing project by its remapped root without changing its status", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const existingRoot = join(source.root, "existing-project-location");
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const existingProject = destination.addProject("Local project name", existingRoot);
    destination.updateProject(existingProject.id, { status: "tracked" });

    const input = {
      bundle,
      remap: [{ from: source.projectRoot, to: existingRoot }],
    };
    const preview = destination.previewProjectDataImport(input);
    expect(preview.additions.projects).toBe(0);
    expect(preview.skipped.projects).toBe(1);
    expect(preview.additions.sessions).toBe(2);
    expect(preview.selectedProjects).toMatchObject([
      { id: source.projectId, rootPath: existingRoot, resolution: "existing" },
    ]);

    destination.importProjectData(input);
    expect(destination.listProjects()).toMatchObject([
      { id: existingProject.id, name: "Local project name", rootPath: existingProject.rootPath, status: "tracked" },
    ]);
    expect(destination.getSessionById(source.sessionIds[0])?.projectId).toBe(existingProject.id);
  });

  it("reports ID and idempotency-key conflicts without overwriting existing rows", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const targetRoot = join(source.root, "conflict.sqlite");
    const destination = new WorkIntelligenceStore(targetRoot);
    stores.push(destination);
    const db = new DatabaseSync(targetRoot);
    try {
      const project = bundle.tables.projects[0];
      const session = bundle.tables.sessions[0];
      if (!project || !session) {
        throw new Error("The fixture should contain a project and a Session.");
      }
      insertRow(db, "projects", project);
      insertRow(db, "sessions", row("sessions", { ...session, summary: "不同內容的既有 Session" }));
      insertRow(
        db,
        "sessions",
        row("sessions", {
          ...session,
          id: "other-session-id",
          idempotency_key: String(bundle.tables.sessions[1]?.idempotency_key),
        }),
      );
    } finally {
      db.close();
    }

    const preview = destination.previewProjectDataImport({ bundle });
    expect(preview.conflicts.sessions).toBe(2);
    expect(preview.conflictDetails.map((item) => item.reason)).toContain("相同 ID 的既有資料內容不同。");
    expect(preview.conflictDetails.map((item) => item.reason)).toContain("唯一識別值已被另一筆資料使用。");
    destination.importProjectData({ bundle });
    expect(destination.getSessionById(String(bundle.tables.sessions[0]?.id ?? ""))?.summary).toBe(
      "不同內容的既有 Session",
    );
  });

  it("reuses the local root when the same project ID already exists under a different root", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const project = bundle.tables.projects[0];
    if (!project) {
      throw new Error("The fixture should contain a project.");
    }
    const targetRoot = join(source.root, "project-path-auto-remap.sqlite");
    const localRoot = join(source.root, "different-project-location");
    const destination = new WorkIntelligenceStore(targetRoot);
    stores.push(destination);
    const db = new DatabaseSync(targetRoot);
    try {
      insertRow(db, "projects", row("projects", { ...project, root_path: localRoot }));
    } finally {
      db.close();
    }

    const preview = destination.previewProjectDataImport({ bundle });

    expect(total(preview.conflicts)).toBe(0);
    expect(preview.skipped.projects).toBe(1);
    expect(preview.additions.sessions).toBe(2);
    expect(preview.selectedProjects).toMatchObject([
      { id: source.projectId, sourceRootPath: String(project.root_path), rootPath: localRoot, resolution: "existing" },
    ]);
    expect(preview.autoRemaps).toEqual([
      { projectId: source.projectId, from: String(project.root_path), to: localRoot, snapshots: 1 },
    ]);

    destination.importProjectData({ bundle });
    const check = new DatabaseSync(targetRoot, { readOnly: true });
    try {
      expect(check.prepare("SELECT root_path FROM projects").all()).toEqual([{ root_path: localRoot }]);
      expect(check.prepare("SELECT source_path FROM raw_snapshots").all()).toEqual([
        { source_path: join(localRoot, "handoff.md") },
      ]);
    } finally {
      check.close();
    }
    // Importing the same file again is a no-op instead of a project-wide conflict.
    const again = destination.previewProjectDataImport({ bundle });
    expect(total(again.conflicts)).toBe(0);
    expect(total(again.additions)).toBe(0);
  });

  it("treats Windows handoff paths that differ only in case or separators as the same path", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const windowsRoot = "C:\\Users\\Dev\\Portable";
    const targetRoot = join(source.root, "windows-paths.sqlite");
    const destination = new WorkIntelligenceStore(targetRoot);
    stores.push(destination);
    destination.importProjectData({ bundle, remap: [{ from: source.projectRoot, to: windowsRoot }] });
    // A Windows database keeps its root lowercase (canonical) while the handoff path keeps the original case.
    runSql(destination, "UPDATE projects SET root_path = ?", windowsRoot.toLowerCase());
    runSql(destination, "UPDATE raw_snapshots SET source_path = ?", "C:\\USERS\\Dev\\Portable\\handoff.md");

    const preview = destination.previewProjectDataImport({ bundle, strategy: "newer-wins" });
    expect(preview.autoRemaps).toHaveLength(1);
    expect(preview.conflictGroups).toEqual([]);
    expect(preview.skipped.raw_snapshots).toBe(1);
  });

  it("still reports a handoff path that really points elsewhere as a path conflict", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const destination = new WorkIntelligenceStore(join(source.root, "moved-handoff.sqlite"));
    stores.push(destination);
    destination.importProjectData({ bundle });
    runSql(destination, "UPDATE raw_snapshots SET source_path = ?", join(source.root, "elsewhere", "handoff.md"));

    const preview = destination.previewProjectDataImport({ bundle });
    expect(preview.conflictGroups).toEqual([
      expect.objectContaining({ category: "path", table: "raw_snapshots", count: 1 }),
    ]);
  });

  it("rejects supersedes and link references that are outside the selected scope", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const knowledge = bundle.tables.knowledge[1];
    const link = bundle.tables.session_links[0];
    if (!knowledge || !link) {
      throw new Error("The fixture should include Knowledge and a Session link.");
    }
    knowledge.supersedes_id = "knowledge-outside-scope";
    link.related_session_id = "session-outside-scope";
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);

    const preview = destination.previewProjectDataImport({ bundle });
    expect(preview.conflicts.knowledge).toBe(2);
    expect(preview.conflicts.knowledge_audit).toBe(1);
    expect(preview.conflicts.session_links).toBe(1);
    expect(preview.conflictDetails.map((item) => item.reason)).toContain(
      "Knowledge 的 supersedes 關聯不在匯入範圍內。",
    );
    expect(preview.conflictDetails.map((item) => item.reason)).toContain("Session 關聯的兩端都必須包含在匯入範圍內。");

    link.related_session_id = String(link.session_id);
    const selfLinkPreview = destination.previewProjectDataImport({ bundle });
    expect(selfLinkPreview.conflicts.session_links).toBe(1);
    expect(selfLinkPreview.conflictDetails.map((item) => item.reason)).toContain("Session 不可與自己建立關聯。");
  });

  it("rejects an outstanding audit event assigned to a different project than its item", () => {
    const source = createSource();
    const secondRoot = join(source.root, "event-project-mismatch");
    mkdirSync(secondRoot);
    const secondProject = source.store.addProject("Synthetic other project", secondRoot);
    const bundle = source.store.exportProjectData({ type: "all" });
    const event = bundle.tables.outstanding_item_events[0];
    if (!event) throw new Error("Expected the synthetic outstanding item audit event.");
    event.project_id = secondProject.id;
    event.actor_session_id = null;

    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    const preview = destination.previewProjectDataImport({ bundle });

    expect(preview.conflictDetails).toContainEqual({
      table: "outstanding_item_events",
      id: event.id,
      reason: "待結項稽核事件必須屬於對應項目的專案。",
      category: "dependency",
    });
  });

  it("rolls back the entire import if a row fails during the transaction", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const targetRoot = join(source.root, "rollback.sqlite");
    const destination = new WorkIntelligenceStore(targetRoot);
    stores.push(destination);
    const db = new DatabaseSync(targetRoot);
    db.exec(
      "CREATE TRIGGER reject_import_event BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    db.close();

    expect(() => destination.importProjectData({ bundle })).toThrow();
    expect(destination.listProjects()).toHaveLength(0);
    const check = new DatabaseSync(targetRoot, { readOnly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS total FROM sessions").get()).toEqual({ total: 0 });
      expect(check.prepare("SELECT COUNT(*) AS total FROM project_data_import_audits").get()).toEqual({ total: 0 });
    } finally {
      check.close();
    }
  });

  it("rejects unsupported schema versions and malformed row values", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);

    // Exports from schema 31 up to this program's import; a newer one asks for an update, an older one is refused.
    expect(() =>
      destination.previewProjectDataImport({ bundle: { ...bundle, schemaVersion: bundle.schemaVersion + 1 } }),
    ).toThrow(/請先更新 Work Intelligence/);
    expect(() => destination.previewProjectDataImport({ bundle: { ...bundle, schemaVersion: 30 } })).toThrow(
      /schema 版本/,
    );
    const legacy = structuredClone(bundle) as unknown as { schemaVersion: number; tables: Record<string, unknown> };
    legacy.schemaVersion = 22;
    delete legacy.tables.outstanding_cleanup_requests;
    delete legacy.tables.outstanding_cleanup_submissions;
    delete legacy.tables.outstanding_cleanup_request_items;
    delete legacy.tables.outstanding_cleanup_proposals;
    delete legacy.tables.outstanding_cleanup_proposal_evidence;
    const legacyEvents = legacy.tables.outstanding_item_events as ProjectDataRow[];
    for (const event of legacyEvents) {
      delete event.cleanup_request_id;
      delete event.cleanup_proposal_id;
    }
    const parsedLegacy = projectDataExportSchema.safeParse(legacy);
    expect(parsedLegacy.success).toBe(true);
    if (parsedLegacy.success) {
      expect(parsedLegacy.data.tables.outstanding_cleanup_requests).toEqual([]);
      expect(parsedLegacy.data.tables.outstanding_cleanup_submissions).toEqual([]);
      expect(parsedLegacy.data.tables.outstanding_cleanup_request_items).toEqual([]);
      expect(parsedLegacy.data.tables.outstanding_cleanup_proposals).toEqual([]);
      expect(parsedLegacy.data.tables.outstanding_cleanup_proposal_evidence).toEqual([]);
    }
    expect(
      projectDataColumnValue(
        "outstanding_item_events",
        legacyEvents[0] ?? ({} as ProjectDataRow),
        "cleanup_request_id",
      ),
    ).toBeNull();
    legacy.schemaVersion = 21;
    delete legacy.tables.outstanding_items;
    delete legacy.tables.outstanding_item_events;
    expect(projectDataExportSchema.safeParse(legacy).success).toBe(true);
    expect(() => destination.previewProjectDataImport({ bundle: legacy as unknown as ProjectDataExport })).toThrow(
      /schema 版本/,
    );
    const invalid = structuredClone(bundle) as ProjectDataExport;
    const project = invalid.tables.projects[0];
    if (!project) {
      throw new Error("The fixture should contain a project.");
    }
    project.status = 4;
    expect(projectDataExportSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires absolute paths for portable import remapping", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });

    expect(
      projectDataImportInputSchema.safeParse({ bundle, remap: [{ from: "/old/projects", to: "new/projects" }] })
        .success,
    ).toBe(false);
    expect(
      projectDataImportInputSchema.safeParse({ bundle, remap: [{ from: "C:\\old\\projects", to: "/new/projects" }] })
        .success,
    ).toBe(true);
  });
});

function runSql(store: WorkIntelligenceStore, sql: string, ...values: ProjectDataValue[]): void {
  const db = new DatabaseSync(store.databasePath);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function readRows(store: WorkIntelligenceStore, sql: string, ...values: ProjectDataValue[]): unknown[] {
  const db = new DatabaseSync(store.databasePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...values);
  } finally {
    db.close();
  }
}

/**
 * Machine A records work, machine B imports it under another root, and then both keep working on their own:
 * each changes rows the other also has, and each saves "version 2" of the same Knowledge page.
 */
let twoMachineClock = Date.now();

function later(minutes: number): string {
  return new Date(twoMachineClock + minutes * 60_000).toISOString();
}

function createTwoMachines() {
  const machineA = createSource();
  // Every edit happens after the fixture rows were written, so the edited copy is the newer one.
  twoMachineClock = Date.now() + 60_000;
  const pageId = "sync-page";
  const page = (version: number, updatedAt: string): ProjectDataRow =>
    row("knowledge_pages", {
      id: pageId,
      project_id: machineA.projectId,
      slug: "sync-notes",
      title: "同步筆記",
      question: "兩台電腦的進度？",
      sections_json: JSON.stringify([{ heading: "進度", body: `版本 ${version}` }]),
      version,
      sourced_through: null,
      update_requested_at: null,
      last_author: "agent",
      checked_through_session_id: null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: updatedAt,
    });
  const pageVersion = (id: string, version: number, createdAt: string): ProjectDataRow =>
    row("knowledge_page_versions", {
      id,
      page_id: pageId,
      project_id: machineA.projectId,
      version,
      title: "同步筆記",
      question: "兩台電腦的進度？",
      sections_json: JSON.stringify([{ heading: "進度", body: id }]),
      author: "agent",
      idempotency_key: `${id}-key`,
      created_at: createdAt,
    });
  const dbA = new DatabaseSync(machineA.store.databasePath);
  try {
    insertRow(dbA, "knowledge_pages", page(1, "2026-10-01T00:00:00.000Z"));
    insertRow(dbA, "knowledge_page_versions", pageVersion("page-v1", 1, "2026-10-01T00:00:00.000Z"));
  } finally {
    dbA.close();
  }

  mkdirSync(join(machineA.root, "machine-b-checkout"));
  // Stored roots are canonical (on Windows: long-form and lowercase), so compare and remap with that form.
  const machineBRoot = canonicalizeProjectRoot(join(machineA.root, "machine-b-checkout"));
  const machineARoot = canonicalizeProjectRoot(machineA.projectRoot);
  const machineB = new WorkIntelligenceStore(join(machineA.root, "machine-b.sqlite"));
  stores.push(machineB);
  machineB.importProjectData({
    bundle: machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId }),
    remap: [{ from: machineARoot, to: machineBRoot }],
  });
  machineB.updateProject(machineA.projectId, { status: "tracked" });
  const [firstSessionId, secondSessionId] = machineA.sessionIds;

  // Machine A: newer summary on the first Session, a confirmed decision, a completed outstanding item,
  // its own version 2 of the page, and a new Session.
  runSql(
    machineA.store,
    "UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?",
    "A 機器更新第一筆。",
    later(1),
    firstSessionId,
  );
  runSql(
    machineA.store,
    "UPDATE session_decisions SET review_status = 'confirmed', reviewed_at = ? WHERE session_id = ?",
    later(2),
    firstSessionId,
  );
  runSql(
    machineA.store,
    "UPDATE outstanding_items SET status = 'completed', updated_at = ? WHERE source_session_id = ?",
    later(3),
    firstSessionId,
  );
  runSql(
    machineA.store,
    "UPDATE knowledge_pages SET version = 2, sections_json = ?, updated_at = ? WHERE id = ?",
    JSON.stringify([{ heading: "進度", body: "A 的版本 2" }]),
    later(4),
    pageId,
  );
  const dbA2 = new DatabaseSync(machineA.store.databasePath);
  try {
    insertRow(dbA2, "knowledge_page_versions", pageVersion("page-v2-a", 2, later(4)));
  } finally {
    dbA2.close();
  }
  const onlyOnA = machineA.store.finalizeSession({
    projectRoot: machineA.projectRoot,
    idempotencyKey: "machine-a-only",
    title: "只在 A 的工作",
    summary: "只在 A 機器記錄的工作。",
  });

  // Machine B: newer summary on the second Session, its own version 2 (saved later than A's), and a new Session.
  runSql(
    machineB,
    "UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?",
    "B 機器更新第二筆。",
    later(5),
    secondSessionId,
  );
  runSql(
    machineB,
    "UPDATE knowledge_pages SET version = 2, sections_json = ?, updated_at = ? WHERE id = ?",
    JSON.stringify([{ heading: "進度", body: "B 的版本 2" }]),
    later(6),
    pageId,
  );
  const dbB = new DatabaseSync(machineB.databasePath);
  try {
    insertRow(dbB, "knowledge_page_versions", pageVersion("page-v2-b", 2, later(6)));
  } finally {
    dbB.close();
  }
  const onlyOnB = machineB.finalizeSession({
    projectRoot: machineBRoot,
    idempotencyKey: "machine-b-only",
    title: "只在 B 的工作",
    summary: "只在 B 機器記錄的工作。",
  });
  if (onlyOnA.outcome !== "finalized" || onlyOnB.outcome !== "finalized") {
    throw new Error("Both machines must accept their own Sessions.");
  }
  return {
    machineA,
    machineB,
    machineARoot,
    machineBRoot,
    pageId,
    firstSessionId,
    secondSessionId,
    onlyOnA: onlyOnA.session.id,
    onlyOnB: onlyOnB.session.id,
  };
}

describe("two-machine portable sync", () => {
  it("merges two machines' independent work both ways with newer-wins and no conflicts", () => {
    const setup = createTwoMachines();
    const { machineA, machineB, pageId } = setup;
    const exportA = machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId });
    const exportB = machineB.exportProjectData({ type: "project", projectId: machineA.projectId });

    const intoA = { bundle: exportB, strategy: "newer-wins" as const };
    const previewA = machineA.store.previewProjectDataImport(intoA);
    expect(previewA.conflictGroups).toEqual([]);
    expect(total(previewA.conflicts)).toBe(0);
    expect(previewA.autoRemaps).toMatchObject([{ projectId: machineA.projectId, to: setup.machineARoot }]);
    expect(previewA.additions.sessions).toBe(1);
    expect(previewA.updates).toMatchObject({ sessions: 1, knowledge_pages: 1 });
    expect(previewA.keptLocal).toMatchObject({ sessions: 1, session_decisions: 1, outstanding_items: 1 });
    expect(previewA.renumbered).toEqual({ knowledge_page_versions: 1 });
    machineA.store.importProjectData(intoA);

    const intoB = { bundle: exportA, strategy: "newer-wins" as const };
    const previewB = machineB.previewProjectDataImport(intoB);
    expect(total(previewB.conflicts)).toBe(0);
    expect(previewB.autoRemaps).toMatchObject([{ from: setup.machineARoot, to: setup.machineBRoot }]);
    expect(previewB.updates).toMatchObject({ sessions: 1, session_decisions: 1, outstanding_items: 1 });
    expect(previewB.keptLocal).toMatchObject({ sessions: 1, knowledge_pages: 1 });
    expect(previewB.renumbered).toEqual({ knowledge_page_versions: 1 });
    machineB.importProjectData(intoB);

    for (const store of [machineA.store, machineB]) {
      expect(store.getSessionById(setup.firstSessionId)?.summary).toBe("A 機器更新第一筆。");
      expect(store.getSessionById(setup.secondSessionId)?.summary).toBe("B 機器更新第二筆。");
      expect(store.getSessionById(setup.onlyOnA)).toBeDefined();
      expect(store.getSessionById(setup.onlyOnB)).toBeDefined();
      // Both machines' version 2 survive, renumbered by time; the page counter points past the newest one.
      expect(
        readRows(store, "SELECT id, version FROM knowledge_page_versions WHERE page_id = ? ORDER BY version", pageId),
      ).toEqual([
        { id: "page-v1", version: 1 },
        { id: "page-v2-a", version: 2 },
        { id: "page-v2-b", version: 3 },
      ]);
      expect(readRows(store, "SELECT version FROM knowledge_pages WHERE id = ?", pageId)).toEqual([{ version: 3 }]);
      expect(
        readRows(store, "SELECT review_status FROM session_decisions WHERE session_id = ?", setup.firstSessionId),
      ).toEqual([{ review_status: "confirmed" }]);
    }
    expect(readRows(machineA.store, "SELECT root_path FROM projects")).toEqual([{ root_path: setup.machineARoot }]);
    expect(readRows(machineB, "SELECT root_path FROM projects")).toEqual([{ root_path: setup.machineBRoot }]);

    // Once both directions ran, a further round trip finds nothing to change.
    const settled = machineB.previewProjectDataImport({
      bundle: machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId }),
      strategy: "newer-wins",
    });
    expect(total(settled.conflicts)).toBe(0);
    expect(total(settled.additions)).toBe(0);
    expect(total(settled.updates)).toBe(0);
    expect(total(settled.keptLocal)).toBe(0);
  });

  it("keeps local rows that are newer and never overwrites them with an older imported copy", () => {
    const { machineA, machineB, secondSessionId } = createTwoMachines();
    const exportA = machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId });

    const preview = machineB.previewProjectDataImport({ bundle: exportA, strategy: "newer-wins" });
    expect(preview.keptLocal.sessions).toBe(1);
    machineB.importProjectData({ bundle: exportA, strategy: "newer-wins" });
    expect(machineB.getSessionById(secondSessionId)?.summary).toBe("B 機器更新第二筆。");
  });

  it("merge mode reports newer imported rows by reason without blocking new child rows", () => {
    const { machineA, machineB, onlyOnB, pageId } = createTwoMachines();
    const exportB = machineB.exportProjectData({ type: "project", projectId: machineA.projectId });

    const preview = machineA.store.previewProjectDataImport({ bundle: exportB });
    expect(preview.strategy).toBe("merge");
    expect(total(preview.updates)).toBe(0);
    expect(preview.conflictGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "newer_content", table: "sessions", count: 1 }),
        expect.objectContaining({ category: "newer_content", table: "knowledge_pages", count: 1 }),
        expect.objectContaining({ category: "dependency", table: "knowledge_page_versions", count: 1 }),
      ]),
    );
    expect(preview.conflictGroups.every((group) => group.sampleIds.length > 0)).toBe(true);
    expect(preview.additions.sessions).toBe(1);
    machineA.store.importProjectData({ bundle: exportB });
    expect(machineA.store.getSessionById(onlyOnB)).toBeDefined();
    expect(readRows(machineA.store, "SELECT version FROM knowledge_pages WHERE id = ?", pageId)).toEqual([
      { version: 2 },
    ]);
  });

  it("ignores locally derived columns and newer masking rules when comparing rows", () => {
    const machineA = createSource();
    const token = `gho_${"C".repeat(36)}`;
    const [firstSessionId] = machineA.sessionIds;
    runSql(machineA.store, "UPDATE sessions SET summary = ? WHERE id = ?", `摘要 ${token}`, firstSessionId);
    const bundle = machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId });
    const machineB = new WorkIntelligenceStore(join(machineA.root, "derived.sqlite"));
    stores.push(machineB);
    machineB.importProjectData({ bundle });
    // B keeps the unmasked text from before a masking rule existed, its own redaction count,
    // and the same changed-file provenance merged in a different order.
    runSql(
      machineB,
      "UPDATE sessions SET summary = ?, redaction_count = 9, changed_files_provenance_json = ? WHERE id = ?",
      `摘要 ${token}`,
      JSON.stringify([
        { path: "README.md", sources: ["git", "agent"], references: ["b", "a"] },
        { path: "README.md", sources: ["agent", "git"], references: ["a", "b"] },
      ]),
      firstSessionId,
    );
    runSql(
      machineA.store,
      "UPDATE sessions SET changed_files_provenance_json = ? WHERE id = ?",
      JSON.stringify([{ path: "README.md", sources: ["agent", "git"], references: ["a", "b"] }]),
      firstSessionId,
    );

    const preview = machineB.previewProjectDataImport({
      bundle: machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId }),
    });
    expect(total(preview.conflicts)).toBe(0);
    expect(preview.skipped.sessions).toBe(2);
    expect(readRows(machineB, "SELECT redaction_count FROM sessions WHERE id = ?", firstSessionId)).toEqual([
      { redaction_count: 9 },
    ]);
  });

  it("renumbers colliding page versions that arrive in the same file and keeps the counter in sync", () => {
    const { machineA, machineB, pageId } = createTwoMachines();
    const exportB = machineB.exportProjectData({ type: "project", projectId: machineA.projectId });
    const duplicate = exportB.tables.knowledge_page_versions.find((version) => version.id === "page-v2-b");
    if (!duplicate) throw new Error("Expected machine B's page version.");
    exportB.tables.knowledge_page_versions.push({
      ...duplicate,
      id: "page-v2-b-late",
      idempotency_key: "page-v2-b-late-key",
      created_at: later(7),
    });

    machineA.store.importProjectData({ bundle: exportB, strategy: "newer-wins" });
    expect(
      readRows(
        machineA.store,
        "SELECT id, version FROM knowledge_page_versions WHERE page_id = ? ORDER BY version",
        pageId,
      ),
    ).toEqual([
      { id: "page-v1", version: 1 },
      { id: "page-v2-a", version: 2 },
      { id: "page-v2-b", version: 3 },
      { id: "page-v2-b-late", version: 4 },
    ]);
    expect(readRows(machineA.store, "SELECT version FROM knowledge_pages WHERE id = ?", pageId)).toEqual([
      { version: 4 },
    ]);
  });

  it("refuses a newer-wins update that would take another row's unique key", () => {
    const { machineA, machineB, secondSessionId } = createTwoMachines();
    const exportB = machineB.exportProjectData({ type: "project", projectId: machineA.projectId });
    const session = exportB.tables.sessions.find((item) => item.id === secondSessionId);
    if (!session) throw new Error("Expected the second Session.");
    session.idempotency_key = "machine-a-only";

    const preview = machineA.store.previewProjectDataImport({ bundle: exportB, strategy: "newer-wins" });
    expect(preview.conflictDetails).toContainEqual({
      table: "sessions",
      id: secondSessionId,
      reason: "唯一識別值已被另一筆資料使用。",
      category: "unique",
    });
    expect(preview.updates.sessions ?? 0).toBe(0);
  });

  it("never overwrites append-only history or the local project row, even with newer-wins", () => {
    const { machineA, machineB, firstSessionId } = createTwoMachines();
    const exportB = machineB.exportProjectData({ type: "project", projectId: machineA.projectId });
    // An event both machines already have (the export also holds B's own new events, which are simply added).
    const event = exportB.tables.work_events.find((item) => item.session_id === firstSessionId);
    const project = exportB.tables.projects[0];
    if (!event || !project) throw new Error("Expected a work event and the project.");
    event.summary = "改寫過的歷史事件。";
    project.name = "另一台電腦的名稱";

    const preview = machineA.store.previewProjectDataImport({ bundle: exportB, strategy: "newer-wins" });
    expect(preview.conflictDetails).toContainEqual({
      table: "work_events",
      id: String(event.id),
      reason: "相同 ID 的既有資料內容不同。",
      category: "content",
    });
    machineA.store.importProjectData({ bundle: exportB, strategy: "newer-wins" });
    expect(readRows(machineA.store, "SELECT summary FROM work_events WHERE id = ?", String(event.id))).not.toEqual([
      { summary: "改寫過的歷史事件。" },
    ]);
    expect(machineA.store.listProjects()).toMatchObject([{ name: "Portable project", status: "tracked" }]);
  });

  it("rejects an unknown import strategy", () => {
    const { machineA } = createTwoMachines();
    const bundle = machineA.store.exportProjectData({ type: "project", projectId: machineA.projectId });
    expect(projectDataImportInputSchema.safeParse({ bundle, strategy: "overwrite" }).success).toBe(false);
    expect(() =>
      machineA.store.previewProjectDataImport({ bundle, strategy: "overwrite" } as unknown as Parameters<
        typeof machineA.store.previewProjectDataImport
      >[0]),
    ).toThrow();
  });

  it("carries cross-project reports that cite the project so deleting and re-importing keeps them", () => {
    const source = createSource();
    insertCrossProjectReport(source.store, source.sessionIds);
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(bundle.tables.report_synthesis_requests.map((item) => item.id)).toContain("cross-report-request");
    expect(bundle.tables.report_summaries.map((item) => item.id)).toContain("cross-report-summary");
    expect(bundle.tables.metadata_backfill_requests.map((item) => item.id)).toContain("cross-metadata-request");

    source.store.deleteProject(source.projectId, "Portable project");
    expect(readRows(source.store, "SELECT id FROM report_summaries WHERE id = 'cross-report-summary'")).toEqual([]);
    const preview = source.store.previewProjectDataImport({ bundle, projectId: source.projectId });
    expect(total(preview.conflicts)).toBe(0);
    source.store.importProjectData({ bundle, projectId: source.projectId });
    expect(readRows(source.store, "SELECT id, is_current FROM report_summaries WHERE project_id IS NULL")).toEqual([
      { id: "cross-report-summary", is_current: 1 },
    ]);
  });
});

function insertCrossProjectReport(store: WorkIntelligenceStore, sessionIds: readonly string[]): void {
  const db = new DatabaseSync(store.databasePath);
  try {
    insertRow(
      db,
      "report_synthesis_requests",
      row("report_synthesis_requests", {
        id: "cross-report-request",
        idempotency_key: "cross-report-request-key",
        scope_type: "all",
        project_id: null,
        period: "week",
        range_from: "2026-09-14",
        range_to: "2026-09-20",
        status: "completed",
        requested_at: "2026-09-21T12:00:00.000Z",
        started_at: "2026-09-21T12:00:01.000Z",
        completed_at: "2026-09-21T12:00:02.000Z",
        failure_reason: null,
        source_session_ids_json: JSON.stringify(sessionIds),
      }),
    );
    insertRow(
      db,
      "report_summaries",
      row("report_summaries", {
        id: "cross-report-summary",
        request_id: "cross-report-request",
        period: "week",
        range_from: "2026-09-14",
        range_to: "2026-09-20",
        project_id: null,
        title: "跨專案週報",
        executive_summary: "本週跨專案摘要。",
        themes_json: "[]",
        highlights_json: "[]",
        verification_json: "[]",
        comparison_json: "[]",
        risks_json: "[]",
        decisions_json: "[]",
        next_steps_json: "[]",
        source_session_ids_json: JSON.stringify(sessionIds),
        generated_by_agent: "test-agent",
        generated_by_model: null,
        prompt_version: "test-v1",
        created_at: "2026-09-21T12:00:02.000Z",
        is_current: 1,
      }),
    );
    insertRow(
      db,
      "metadata_backfill_requests",
      row("metadata_backfill_requests", {
        id: "cross-metadata-request",
        idempotency_key: "cross-metadata-request-key",
        scope_type: "all",
        project_id: null,
        status: "completed",
        requested_at: "2026-09-21T12:01:00.000Z",
        started_at: "2026-09-21T12:01:01.000Z",
        completed_at: "2026-09-21T12:01:02.000Z",
        failure_reason: null,
        source_session_ids_json: JSON.stringify(sessionIds),
      }),
    );
  } finally {
    db.close();
  }
}

describe("project path prefix conversion", () => {
  it("matches complete path segments and converts separators across platforms", () => {
    expect(remapPathPrefix("/old/app/src/index.ts", { from: "/old/app", to: "C:\\work\\app" })).toBe(
      "C:\\work\\app\\src\\index.ts",
    );
    expect(
      remapPathPrefix("C:\\Users\\Old\\Repo\\handoff.md", { from: "c:/users/old/repo", to: "/Users/new/repo" }),
    ).toBe("/Users/new/repo/handoff.md");
    expect(remapPathPrefix("C:\\work\\apple\\README.md", { from: "C:\\work\\app", to: "/new/app" })).toBe(
      "C:\\work\\apple\\README.md",
    );
    expect(remapPathPrefix("/old/app", { from: "/old/app/", to: "/new/app/" })).toBe("/new/app/");
  });
});

describe("import preview root spelling", () => {
  it("shows Windows roots in their original spelling while matching them case-insensitively", () => {
    const source = new WorkIntelligenceStore(":memory:");
    const destination = new WorkIntelligenceStore(":memory:");
    try {
      const project = source.addProject("Spelling fixture", "/synthetic/spelling-fixture");
      const bundle = source.exportProjectData({ type: "project", projectId: project.id });
      bundle.tables.projects[0]!.root_path = "D:\\Old Machine\\Round6-Alpha";
      const mapped = destination.previewProjectDataImport({
        bundle,
        remap: [{ from: "d:/old machine/round6-alpha", to: "E:\\New Machine\\Round6-Alpha" }],
      });
      expect(mapped.selectedProjects[0]).toMatchObject({
        sourceRootPath: "D:\\Old Machine\\Round6-Alpha",
        rootPath: "E:\\New Machine\\Round6-Alpha",
      });
      const unmapped = destination.previewProjectDataImport({ bundle });
      expect(unmapped.selectedProjects[0]).toMatchObject({
        sourceRootPath: "D:\\Old Machine\\Round6-Alpha",
        rootPath: "D:\\Old Machine\\Round6-Alpha",
      });
    } finally {
      source.close();
      destination.close();
    }
  });
});
