import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_DATA_IMPORT_STRATEGIES,
  PROJECT_DATA_TABLES,
  type ProjectDataExport,
  type ProjectDataRow,
  type ProjectDataTable,
  type ProjectDataValue,
} from "../../packages/core/src/index.js";
import { projectDataExportTableColumns } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

/**
 * The product lets a Session link point at a Session of another project (work_link_sessions and finalize
 * relatedSessionIds only require the related Session to exist and be tracked). A file the product exported must
 * re-import completely, so ownership checks must not treat that column as a claim on the other project.
 */

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

function openStore(location: string): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(location);
  stores.push(store);
  return store;
}

function row(table: ProjectDataTable, values: Record<string, ProjectDataValue>): ProjectDataRow {
  return Object.fromEntries(projectDataExportTableColumns[table].map((column) => [column, values[column] ?? null]));
}

function insertRow(db: DatabaseSync, table: ProjectDataTable, values: ProjectDataRow): void {
  const columns = projectDataExportTableColumns[table];
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => {
      const value = values[column];
      if (value === undefined) throw new Error(`Test data for ${table} is missing ${column}.`);
      return value;
    }),
  );
}

function total(counts: Record<string, number | undefined>): number {
  return Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

function rowCounts(bundle: ProjectDataExport): Record<string, number> {
  return Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, bundle.tables[table].length]));
}

interface Seeded {
  store: WorkIntelligenceStore;
  root: string;
  projectIds: [string, string];
  /** Sessions per project: [project][index]. */
  sessionIds: [[string, string, string], [string, string]];
}

function finalize(
  store: WorkIntelligenceStore,
  projectRoot: string,
  key: string,
  completedAt: string,
  extra: Record<string, unknown> = {},
): string {
  const result = store.finalizeSession({
    projectRoot,
    idempotencyKey: key,
    title: `Fictional work ${key}`,
    summary: `Fictional summary for ${key}.`,
    workSummary: {
      outcomes: ["Fictional outcome"],
      scope: [],
      decisions: [{ text: `Fictional decision ${key}`, origin: "agent_autonomous" }],
      verification: [],
      nextSteps: [`Fictional next step ${key}`],
    },
    changedFiles: ["README.md"],
    verification: { status: "passed", summary: "Fictional check passed." },
    events: [{ type: "execution", summary: `Fictional event ${key}.` }],
    handoffContent: `Fictional handoff ${key}.`,
    completedAt,
    ...extra,
  });
  if (result.outcome !== "finalized") throw new Error("Fixture projects must accept Sessions.");
  return result.session.id;
}

/**
 * A database with rows in every project-data table and every reference the product allows across projects.
 * The write paths are the product's own (finalize, link, knowledge, diagrams); rows its public API cannot
 * produce in a test (candidates, reports, cleanup review, ...) are inserted with the exported column list.
 */
function seedWorld(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-cross-project-"));
  tempDirs.push(root);
  const store = openStore(join(root, "source.sqlite"));
  const roots = [join(root, "alpha"), join(root, "beta")] as const;
  const projectIds = roots.map((projectRoot, index) => {
    mkdirSync(projectRoot);
    const project = store.addProject(index === 0 ? "Fictional Alpha" : "Fictional Beta", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    return project.id;
  }) as [string, string];

  const alpha1 = finalize(store, roots[0], "alpha-1", "2026-09-20T10:00:00.000Z");
  const alpha2 = finalize(store, roots[0], "alpha-2", "2026-09-21T10:00:00.000Z", { parentSessionId: alpha1 });
  // Product-allowed cross-project links: finalize parent and related ids, then work_link_sessions.
  const beta1 = finalize(store, roots[1], "beta-1", "2026-09-22T10:00:00.000Z", {
    parentSessionId: alpha1,
    relatedSessionIds: [alpha2],
  });
  const beta2 = finalize(store, roots[1], "beta-2", "2026-09-23T10:00:00.000Z");
  expect(
    store.linkSessions({ sessionId: alpha2, relatedSessionId: beta2, relation: "related", linked: true }).outcome,
  ).toBe("session_link_updated");

  // Knowledge: supersedes and last confirmation stay inside their project.
  const oldKnowledge = store.recordKnowledge({
    projectRoot: roots[0],
    sessionId: alpha1,
    idempotencyKey: "alpha-knowledge-old",
    kind: "pattern",
    title: "Fictional old pattern",
    body: "Fictional body.",
  });
  if (oldKnowledge.outcome !== "knowledge_recorded") throw new Error("Knowledge should be recorded.");
  const newKnowledge = store.recordKnowledge({
    projectRoot: roots[0],
    sessionId: alpha1,
    idempotencyKey: "alpha-knowledge-new",
    kind: "pattern",
    title: "Fictional new pattern",
    body: "Fictional replacement body.",
    supersedesId: oldKnowledge.knowledge.id,
  });
  if (newKnowledge.outcome !== "knowledge_recorded") throw new Error("Knowledge should be recorded.");
  const alpha3 = finalize(store, roots[0], "alpha-3", "2026-09-24T10:00:00.000Z", {
    appliedKnowledgeIds: [newKnowledge.knowledge.id],
  });
  const betaKnowledge = store.recordKnowledge({
    projectRoot: roots[1],
    sessionId: beta1,
    idempotencyKey: "beta-knowledge",
    kind: "gotcha",
    title: "Fictional beta gotcha",
    body: "Fictional beta body.",
  });
  if (betaKnowledge.outcome !== "knowledge_recorded") throw new Error("Knowledge should be recorded.");
  const diagram = store.attachDiagram({
    sessionId: alpha1,
    idempotencyKey: "alpha-diagram",
    title: "Fictional flow",
    kind: "architecture",
    formatVersion: 1,
    source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }] }),
  });
  expect(diagram.outcome).toBe("diagram_attached");

  const db = new DatabaseSync(store.databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // Promote one decision to Knowledge, the way the web review does.
    db.prepare(
      "UPDATE session_decisions SET review_status = 'promoted', reviewed_at = ?, knowledge_id = ? WHERE session_id = ?",
    ).run("2026-09-24T11:00:00.000Z", newKnowledge.knowledge.id, alpha1);
    insertRow(
      db,
      "evidence",
      row("evidence", {
        id: "evidence-alpha-1",
        session_id: alpha1,
        project_id: projectIds[0],
        kind: "test",
        reference: "vitest:fictional",
        summary: "Fictional evidence.",
        captured_at: "2026-09-21T11:00:00.000Z",
      }),
    );
    insertRow(
      db,
      "void_audit",
      row("void_audit", {
        id: "void-alpha-1",
        target_type: "evidence",
        target_id: "evidence-alpha-1",
        session_id: alpha1,
        project_id: projectIds[0],
        action: "restored",
        reason: "Fictional confirmation.",
        occurred_at: "2026-09-21T11:01:00.000Z",
      }),
    );
    insertRow(
      db,
      "session_verification_updates",
      row("session_verification_updates", {
        id: "verification-update-1",
        session_id: beta1,
        source: "web",
        resulting_json: JSON.stringify({ status: "passed", summary: "Fictional update." }),
        created_at: "2026-09-22T11:02:00.000Z",
      }),
    );
    insertRow(
      db,
      "knowledge_pages",
      row("knowledge_pages", {
        id: "page-alpha",
        project_id: projectIds[0],
        slug: "fictional-notes",
        title: "Fictional notes",
        question: "Fictional question?",
        sections_json: "[]",
        version: 1,
        last_author: "agent",
        created_at: "2026-09-21T12:00:00.000Z",
        updated_at: "2026-09-21T12:00:00.000Z",
      }),
    );
    insertRow(
      db,
      "knowledge_page_versions",
      row("knowledge_page_versions", {
        id: "page-alpha-v1",
        page_id: "page-alpha",
        project_id: projectIds[0],
        version: 1,
        title: "Fictional notes",
        question: "Fictional question?",
        sections_json: "[]",
        author: "agent",
        created_at: "2026-09-21T12:00:00.000Z",
      }),
    );
    insertRow(
      db,
      "knowledge_candidate_requests",
      row("knowledge_candidate_requests", {
        id: "candidate-request-alpha",
        project_id: projectIds[0],
        status: "completed",
        requested_at: "2026-09-21T12:10:00.000Z",
        source_session_ids_json: JSON.stringify([alpha1]),
        candidate_count: 1,
      }),
    );
    insertRow(
      db,
      "knowledge_candidates",
      row("knowledge_candidates", {
        id: "candidate-alpha",
        request_id: "candidate-request-alpha",
        project_id: projectIds[0],
        session_id: alpha1,
        kind: "gotcha",
        title: "Fictional candidate",
        body: "Fictional candidate body.",
        tags_json: "[]",
        references_json: "[]",
        applies_to_json: "[]",
        rationale: "Fictional rationale.",
        status: "accepted",
        knowledge_id: oldKnowledge.knowledge.id,
        created_at: "2026-09-21T12:10:01.000Z",
        decided_at: "2026-09-21T12:11:00.000Z",
      }),
    );
    const reportRequest = (id: string, scope: "project" | "all", projectId: string | null, sources: string[]) =>
      insertRow(
        db,
        "report_synthesis_requests",
        row("report_synthesis_requests", {
          id,
          idempotency_key: `${id}-key`,
          scope_type: scope,
          project_id: projectId,
          period: "week",
          range_from: "2026-09-14",
          range_to: "2026-09-27",
          status: "completed",
          requested_at: "2026-09-27T12:00:00.000Z",
          source_session_ids_json: JSON.stringify(sources),
        }),
      );
    const reportSummary = (id: string, requestId: string, projectId: string | null) =>
      insertRow(
        db,
        "report_summaries",
        row("report_summaries", {
          id,
          request_id: requestId,
          period: "week",
          range_from: "2026-09-14",
          range_to: "2026-09-27",
          project_id: projectId,
          title: `Fictional report ${id}`,
          executive_summary: "Fictional summary.",
          themes_json: "[]",
          highlights_json: "[]",
          verification_json: "[]",
          comparison_json: "[]",
          risks_json: "[]",
          decisions_json: "[]",
          next_steps_json: "[]",
          source_session_ids_json: "[]",
          generated_by_agent: "test-agent",
          prompt_version: "test-v1",
          created_at: "2026-09-27T12:00:02.000Z",
          is_current: 1,
        }),
      );
    reportRequest("report-request-alpha", "project", projectIds[0], [alpha1, alpha2]);
    reportSummary("report-summary-alpha", "report-request-alpha", projectIds[0]);
    // A report over all projects cites Sessions of both, and has no project of its own.
    reportRequest("report-request-all", "all", null, [alpha1, beta1]);
    reportSummary("report-summary-all", "report-request-all", null);
    insertRow(
      db,
      "report_presentations",
      row("report_presentations", {
        id: "report-presentation-all",
        summary_id: "report-summary-all",
        revision: 1,
        state_json: JSON.stringify({ hidden: [], pinned: [], overrides: [] }),
        actor: "web",
        created_at: "2026-09-27T12:05:00.000Z",
      }),
    );
    insertRow(
      db,
      "attention_preferences",
      row("attention_preferences", {
        id: "attention-alpha",
        project_id: projectIds[0],
        kind: "decision",
        source_id: "fictional-source",
        source_revision: "b".repeat(64),
        state: "hidden",
        revision: 1,
        updated_at: "2026-09-27T12:10:00.000Z",
      }),
    );
    insertRow(
      db,
      "metadata_backfill_requests",
      row("metadata_backfill_requests", {
        id: "metadata-request-alpha",
        idempotency_key: "metadata-request-alpha-key",
        scope_type: "project",
        project_id: projectIds[0],
        status: "completed",
        requested_at: "2026-09-27T12:20:00.000Z",
        source_session_ids_json: JSON.stringify([alpha1]),
      }),
    );
    insertRow(
      db,
      "session_summary_updates",
      row("session_summary_updates", {
        id: "summary-update-1",
        session_id: alpha1,
        idempotency_key: "summary-update-key",
        mode: "append",
        summary: "Fictional addition.",
        previous_summary: "Fictional before.",
        resulting_summary: "Fictional before. Fictional addition.",
        created_at: "2026-09-27T12:30:00.000Z",
      }),
    );
    insertRow(
      db,
      "session_work_summary_updates",
      row("session_work_summary_updates", {
        id: "work-summary-update-1",
        session_id: alpha1,
        idempotency_key: "work-summary-update-key",
        mode: "patch",
        work_summary_json: "{}",
        previous_work_summary_json: "{}",
        resulting_work_summary_json: "{}",
        created_at: "2026-09-27T12:31:00.000Z",
      }),
    );

    const item = db
      .prepare(
        "SELECT id, position, text, updated_at FROM outstanding_items WHERE source_session_id = ? ORDER BY position LIMIT 1",
      )
      .get(alpha1) as { id: string; position: number; text: string; updated_at: string };
    const createdAt = "2026-09-28T12:00:00.000Z";
    insertRow(
      db,
      "outstanding_cleanup_requests",
      row("outstanding_cleanup_requests", {
        id: "cleanup-request",
        project_id: projectIds[0],
        idempotency_key: "cleanup-request-key",
        status: "completed",
        requested_at: createdAt,
        completed_at: createdAt,
        item_count: 1,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_submissions",
      row("outstanding_cleanup_submissions", {
        id: "cleanup-submission",
        request_id: "cleanup-request",
        project_id: projectIds[0],
        idempotency_key: "cleanup-submission-key",
        payload_hash: "a".repeat(64),
        created_at: createdAt,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_request_items",
      row("outstanding_cleanup_request_items", {
        id: "cleanup-request-item",
        request_id: "cleanup-request",
        project_id: projectIds[0],
        item_id: item.id,
        source_session_id: alpha1,
        position: item.position,
        text: item.text,
        item_updated_at: item.updated_at,
        source_updated_at: createdAt,
        source_fingerprint: "source-fixture",
        source_completed_at: "2026-09-20T10:00:00.000Z",
        examined_submission_id: "cleanup-submission",
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_proposals",
      row("outstanding_cleanup_proposals", {
        id: "cleanup-proposal",
        request_id: "cleanup-request",
        project_id: projectIds[0],
        request_item_id: "cleanup-request-item",
        submission_id: "cleanup-submission",
        target_status: "completed",
        reason: "Fictional later Session verifies this.",
        review_status: "accepted",
        created_at: createdAt,
        decided_at: createdAt,
      }),
    );
    insertRow(
      db,
      "outstanding_cleanup_proposal_evidence",
      row("outstanding_cleanup_proposal_evidence", {
        id: "cleanup-evidence-link",
        proposal_id: "cleanup-proposal",
        project_id: projectIds[0],
        session_id: alpha2,
        session_updated_at: createdAt,
        session_fingerprint: "evidence-fixture",
        session_completed_at: "2026-09-21T10:00:00.000Z",
      }),
    );
    db.prepare("UPDATE outstanding_items SET status = 'completed', updated_at = ? WHERE id = ?").run(
      createdAt,
      item.id,
    );
    insertRow(
      db,
      "outstanding_item_events",
      row("outstanding_item_events", {
        id: "cleanup-event",
        item_id: item.id,
        project_id: projectIds[0],
        from_status: "pending",
        to_status: "completed",
        source: "web",
        created_at: createdAt,
        cleanup_request_id: "cleanup-request",
        cleanup_proposal_id: "cleanup-proposal",
      }),
    );
  } finally {
    db.close();
  }
  return {
    store,
    root,
    projectIds,
    sessionIds: [
      [alpha1, alpha2, alpha3],
      [beta1, beta2],
    ],
  };
}

function crossProjectLinkCount(bundle: ProjectDataExport): number {
  const owner = new Map(bundle.tables.sessions.map((session) => [String(session.id), session.project_id]));
  return bundle.tables.session_links.filter(
    (link) => owner.get(String(link.session_id)) !== owner.get(String(link.related_session_id)),
  ).length;
}

describe("importing project data with cross-project references", () => {
  it("seeds every project-data table and a cross-project link in both directions", () => {
    const { store, sessionIds } = seedWorld();
    const bundle = store.exportProjectData({ type: "all" });
    expect(Object.keys(projectDataExportTableColumns).sort()).toEqual([...PROJECT_DATA_TABLES].sort());
    expect(
      PROJECT_DATA_TABLES.filter((table) => bundle.tables[table].length === 0),
      "every project-data table needs a row so a new table cannot escape the round trip",
    ).toEqual([]);
    expect(crossProjectLinkCount(bundle)).toBe(3);
    const links = bundle.tables.session_links.map((link) => `${link.session_id}>${link.related_session_id}`);
    expect(links).toContain(`${sessionIds[1][0]}>${sessionIds[0][0]}`);
    expect(links).toContain(`${sessionIds[0][1]}>${sessionIds[1][1]}`);
  });

  it("round-trips an all-project export into an empty database with no conflicts and equal row counts", () => {
    const { store } = seedWorld();
    const bundle = store.exportProjectData({ type: "all" });
    const destination = openStore(":memory:");

    for (const strategy of PROJECT_DATA_IMPORT_STRATEGIES) {
      const preview = destination.previewProjectDataImport({ bundle, strategy });
      expect(total(preview.conflicts), strategy).toBe(0);
      expect(preview.conflictDetails).toEqual([]);
    }
    const result = destination.importProjectData({ bundle });
    expect(total(result.conflicts)).toBe(0);

    const imported = destination.exportProjectData({ type: "all" });
    expect(rowCounts(imported)).toEqual(rowCounts(bundle));
    expect(crossProjectLinkCount(imported)).toBe(crossProjectLinkCount(bundle));
    expect(imported.tables.session_links.map((link) => link.id).sort()).toEqual(
      bundle.tables.session_links.map((link) => link.id).sort(),
    );
  });

  it.each(PROJECT_DATA_IMPORT_STRATEGIES)(
    "imports the rest of an all-project export into a database that already holds one project (%s)",
    (strategy) => {
      const { store, projectIds } = seedWorld();
      const bundle = store.exportProjectData({ type: "all" });
      const destination = openStore(":memory:");
      // The destination already has project Alpha, without its links to project Beta.
      destination.importProjectData({ bundle: store.exportProjectData({ type: "project", projectId: projectIds[0] }) });
      const before = destination.exportProjectData({ type: "all" });
      expect(crossProjectLinkCount(before)).toBe(0);

      const preview = destination.previewProjectDataImport({ bundle, strategy });
      expect(total(preview.conflicts)).toBe(0);
      const result = destination.importProjectData({ bundle, strategy });
      expect(total(result.conflicts)).toBe(0);

      const imported = destination.exportProjectData({ type: "all" });
      expect(rowCounts(imported)).toEqual(rowCounts(bundle));
      expect(crossProjectLinkCount(imported)).toBe(crossProjectLinkCount(bundle));

      // A second import of the same file changes nothing.
      const again = destination.importProjectData({ bundle, strategy });
      expect(total(again.conflicts)).toBe(0);
      expect(again.changed).toBe(false);
    },
  );

  it("exports and imports one project as before: links to a Session outside the project are left out", () => {
    const { store, projectIds, sessionIds } = seedWorld();
    const full = store.exportProjectData({ type: "all" });
    const bundle = store.exportProjectData({ type: "project", projectId: projectIds[1] });
    expect(bundle.tables.session_links).toEqual([]);
    const destination = openStore(":memory:");
    const preview = destination.previewProjectDataImport({ bundle });
    expect(total(preview.conflicts)).toBe(0);
    destination.importProjectData({ bundle });
    expect(destination.exportProjectData({ type: "all" }).tables.sessions).toHaveLength(sessionIds[1].length);
    expect(full.tables.session_links.length).toBeGreaterThan(0);
  });

  it("still refuses a single-project file whose link points outside the exported Sessions", () => {
    const { store, projectIds, sessionIds } = seedWorld();
    const bundle = store.exportProjectData({ type: "project", projectId: projectIds[0] });
    const link = bundle.tables.session_links[0];
    if (!link) throw new Error("Project Alpha has an internal link.");
    link.related_session_id = sessionIds[1][0];
    const preview = openStore(":memory:").previewProjectDataImport({ bundle });
    expect(preview.conflicts.session_links).toBe(1);
    expect(preview.conflictDetails.map((detail) => detail.reason)).toContain(
      "Session 關聯的兩端都必須包含在匯入範圍內。",
    );
  });

  it("still refuses rows that attach one project's history to another project's parent", () => {
    const { store, sessionIds } = seedWorld();
    const bundle = store.exportProjectData({ type: "all" });
    const betaKnowledge = bundle.tables.knowledge.find((item) => item.session_id === sessionIds[1][0]);
    const alphaKnowledge = bundle.tables.knowledge.find((item) => item.supersedes_id !== null);
    const decision = bundle.tables.session_decisions.find((item) => item.session_id === sessionIds[0][0]);
    if (!betaKnowledge || !alphaKnowledge || !decision) throw new Error("The fixture has Knowledge and a decision.");
    alphaKnowledge.supersedes_id = betaKnowledge.id ?? null;
    decision.knowledge_id = betaKnowledge.id ?? null;

    const preview = openStore(":memory:").previewProjectDataImport({ bundle });
    expect(preview.conflicts.knowledge).toBeGreaterThan(0);
    expect(preview.conflicts.session_decisions).toBe(1);
    expect(preview.conflictDetails.map((detail) => detail.reason)).toContain("上層資料屬於另一個專案。");
  });

  it("does not let a same-ID link move to another owning Session", () => {
    const { store, sessionIds } = seedWorld();
    const bundle = store.exportProjectData({ type: "all" });
    const destination = openStore(":memory:");
    destination.importProjectData({ bundle });
    const moved = structuredClone(bundle);
    const link = moved.tables.session_links.find((item) => item.session_id === sessionIds[0][1]);
    if (!link) throw new Error("The fixture links Alpha to Beta.");
    // Re-owning an existing link to a Session of the other project is a different row, not an update.
    link.session_id = sessionIds[1][1];
    link.related_session_id = sessionIds[0][0];
    link.created_at = "2030-01-01T00:00:00.000Z";
    const preview = destination.previewProjectDataImport({ bundle: moved, strategy: "newer-wins" });
    expect(preview.updates.session_links ?? 0).toBe(0);
    expect(total(preview.conflicts)).toBeGreaterThan(0);
  });
});
