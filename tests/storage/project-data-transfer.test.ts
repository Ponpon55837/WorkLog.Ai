import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  projectDataImportInputSchema,
} from "../../packages/schema/src/index.js";
import { remapPathPrefix } from "../../packages/storage/src/project-path-remap.js";
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
    workSummary: { outcomes: ["保留成果"], scope: [], decisions: [], verification: [], nextSteps: [] },
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

describe("portable project data transfer", () => {
  it("round-trips project data, pauses new projects, marks search state dirty, and stays idempotent while open", () => {
    const source = createSource();
    const bundle = source.store.exportProjectData({ type: "project", projectId: source.projectId });
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.tables.session_links).toHaveLength(1);
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
      const dirtySearchDocuments = db
        .prepare("SELECT COUNT(*) AS total FROM search_dirty WHERE doc_type IN ('session', 'knowledge')")
        .get() as { total: number };
      expect(dirtySearchDocuments.total).toBeGreaterThan(0);
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

    expect(() =>
      destination.previewProjectDataImport({ bundle: { ...bundle, schemaVersion: bundle.schemaVersion - 1 } }),
    ).toThrow(/schema 版本/);
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
