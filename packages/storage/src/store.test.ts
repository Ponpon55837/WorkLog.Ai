import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "./store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: WorkIntelligenceStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-test-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return { store, root };
}

describe("WorkIntelligenceStore", () => {
  it("skips unregistered, paused, and ignored projects without creating sessions", () => {
    const { store, root } = createStore();
    const project = store.addProject("Private side project", root);
    const handoffPath = join(root, "closing.md");
    writeFileSync(handoffPath, "must not be read while unregistered", "utf8");

    const unregistered = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "skip-unregistered",
      title: "Should not persist",
      summary: "The policy gate must stop ingestion.",
      handoffPath: "closing.md"
    });
    expect(unregistered).toMatchObject({ outcome: "skipped", projectStatus: "unregistered" });
    expect(store.listSessions()).toHaveLength(0);

    store.updateProject(project.id, { status: "paused" });
    expect(store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "skip-paused",
      title: "Still skipped",
      summary: "Paused projects stay quiet."
    })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });

    store.updateProject(project.id, { status: "ignored" });
    expect(store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "skip-ignored",
      title: "Still skipped",
      summary: "Ignored projects stay quiet."
    })).toMatchObject({ outcome: "skipped", projectStatus: "ignored" });
    expect(store.listSessions()).toHaveLength(0);
  });

  it("finalizes only tracked projects, captures handoff, and is idempotent", () => {
    const { store, root } = createStore();
    const project = store.addProject("Work project", root);
    store.updateProject(project.id, { status: "tracked" });
    const handoffPath = join(root, "closing.md");
    writeFileSync(handoffPath, "# Verification\n\nAll checks passed.", "utf8");

    const input = {
      projectRoot: root,
      idempotencyKey: "session-001",
      title: "Add policy gate",
      summary: "Implemented default-deny ingestion and tracking states.",
      handoffPath: "closing.md",
      changedFiles: ["packages/project-policy/src/index.ts"],
      verification: { status: "passed" as const, summary: "Unit tests passed." },
      events: [
        { type: "planning" as const, summary: "Defined explicit opt-in policy." },
        { type: "verification" as const, summary: "Verified skipped states." }
      ]
    };

    const first = store.finalizeSession(input);
    expect(first).toMatchObject({ outcome: "finalized", duplicate: false });
    if (first.outcome !== "finalized") {
      throw new Error("Expected a finalized result");
    }
    expect(first.session.commitRequired).toBe(false);
    expect(first.session.changedFiles).toEqual(["packages/project-policy/src/index.ts"]);

    const second = store.finalizeSession({ ...input, title: "A retry with the same key" });
    expect(second).toMatchObject({ outcome: "finalized", duplicate: true, session: { id: first.session.id } });
    expect(store.listSessions()).toHaveLength(1);

    const detail = store.getSessionDetail(first.session.id);
    expect(detail?.rawSnapshots[0]?.content).toContain("All checks passed");
    expect(detail?.events.map((event) => event.type)).toEqual(["planning", "verification", "finalized"]);
  });

  it("keeps finalize idempotent across two SQLite store connections", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-shared-db-"));
    tempDirs.push(root);
    const databasePath = join(root, "shared.sqlite");
    const firstStore = new WorkIntelligenceStore(databasePath);
    const secondStore = new WorkIntelligenceStore(databasePath);
    stores.push(firstStore, secondStore);

    const project = firstStore.addProject("Shared database project", root);
    firstStore.updateProject(project.id, { status: "tracked" });
    const input = {
      projectRoot: root,
      idempotencyKey: "shared-finalize-key",
      title: "Shared connection finalize",
      summary: "Only one Session should be stored for this key.",
      changedFiles: ["src/shared.ts"],
      verification: { status: "passed" as const }
    };

    const first = firstStore.finalizeSession(input);
    const second = secondStore.finalizeSession(input);
    expect(first).toMatchObject({ outcome: "finalized", duplicate: false });
    expect(second).toMatchObject({ outcome: "finalized", duplicate: true });
    expect(firstStore.listSessions()).toHaveLength(1);
    expect(secondStore.listSessions()).toHaveLength(1);
  });

  it("updates a finalized session summary in place without losing its evidence or metadata", () => {
    const { store, root } = createStore();
    const project = store.addProject("Summary update project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "summary-update-finalize-001",
      title: "Update a finalized summary",
      summary: "Original summary before the later UI correction.",
      handoffContent: "Closing handoff preserved for the summary update test.",
      changedFiles: ["src/original.ts"],
      verification: { status: "passed", summary: "Original verification remains intact." },
      events: [{ type: "verification", summary: "The original verification event remains intact." }]
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized session for summary update");
    }
    const evidence = store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "pnpm test --filter summary-update",
      summary: "Evidence must remain attached after the summary changes."
    });
    expect(evidence).toMatchObject({ outcome: "evidence_attached" });

    const input = {
      sessionId: finalized.session.id,
      idempotencyKey: "summary-update-001",
      mode: "append" as const,
      summary: "補充 knowledgeChunkViewer 編輯態按鈕已同步改為儲存，並更新三個語系與 aria-label。"
    };
    const updated = store.updateSessionSummary(input);
    expect(updated).toMatchObject({
      outcome: "summary_updated",
      duplicate: false,
      session: {
        id: finalized.session.id,
        summary: "Original summary before the later UI correction.\n\n補充 knowledgeChunkViewer 編輯態按鈕已同步改為儲存，並更新三個語系與 aria-label。",
        changedFiles: ["src/original.ts"],
        verification: { status: "passed" }
      },
      mode: "append"
    });

    const retry = store.updateSessionSummary(input);
    expect(retry).toMatchObject({ outcome: "summary_updated", duplicate: true, session: { id: finalized.session.id } });
    expect(store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "summary-update-finalize-001",
      title: finalized.session.title,
      summary: "A different summary must not silently look like a successful retry.",
      changedFiles: ["src/other.ts"],
      verification: { status: "failed" }
    })).toMatchObject({
      outcome: "idempotency_conflict",
      sessionId: finalized.session.id,
      suggestedTool: "work_update_session_summary"
    });

    const detail = store.getSessionDetail(finalized.session.id);
    expect(detail).toMatchObject({
      session: {
        id: finalized.session.id,
        summary: "Original summary before the later UI correction.\n\n補充 knowledgeChunkViewer 編輯態按鈕已同步改為儲存，並更新三個語系與 aria-label。",
        changedFiles: ["src/original.ts"],
        verification: { status: "passed" }
      },
      events: [expect.objectContaining({ type: "verification" }), expect.objectContaining({ type: "finalized" })],
      evidence: [expect.objectContaining({ reference: "pnpm test --filter summary-update" })]
    });
    const context = store.getContext(root);
    expect(context).toMatchObject({
      outcome: "context",
      recentSessions: [expect.objectContaining({
        id: finalized.session.id,
        summary: "Original summary before the later UI correction.\n\n補充 knowledgeChunkViewer 編輯態按鈕已同步改為儲存，並更新三個語系與 aria-label。"
      })]
    });

    store.updateProject(project.id, { status: "paused" });
    expect(store.updateSessionSummary({
      sessionId: finalized.session.id,
      idempotencyKey: "summary-update-paused",
      summary: "This must not be written while the project is paused."
    })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(store.getSessionById(finalized.session.id)?.summary).toBe(
      "Original summary before the later UI correction.\n\n補充 knowledgeChunkViewer 編輯態按鈕已同步改為儲存，並更新三個語系與 aria-label。"
    );
  });

  it("filters sessions by project and inclusive completion date range", () => {
    const { store, root } = createStore();
    const firstProject = store.addProject("First project", root);
    const secondProject = store.addProject("Second project", join(root, "second"));
    store.updateProject(firstProject.id, { status: "tracked" });
    store.updateProject(secondProject.id, { status: "tracked" });

    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "date-filter-001",
      title: "Included session",
      summary: "Falls inside the requested date range.",
      completedAt: "2026-09-01T12:00:00.000Z"
    });
    store.finalizeSession({
      projectRoot: join(root, "second"),
      idempotencyKey: "date-filter-002",
      title: "Excluded session",
      summary: "Falls outside the requested date range.",
      completedAt: "2026-10-01T12:00:00.000Z"
    });

    expect(store.listSessions({ from: "2026-09-01", to: "2026-09-30" }).map((session) => session.title)).toEqual([
      "Included session"
    ]);
    expect(store.listSessions({ projectId: secondProject.id }).map((session) => session.title)).toEqual([
      "Excluded session"
    ]);
  });

  it("builds tracked-only reports with a deterministic UTC range and provenance", () => {
    const { store, root } = createStore();
    const trackedProject = store.addProject("Tracked project", root);
    const pausedProject = store.addProject("Paused project", join(root, "paused"));
    store.updateProject(trackedProject.id, { status: "tracked" });
    store.updateProject(pausedProject.id, { status: "tracked" });

    const tracked = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "report-001",
      title: "Report source session",
      summary: "Included in the daily report.",
      completedAt: "2026-09-16T12:00:00.000Z",
      handoffContent: "# Closing\n\nThe tracked report source is complete.",
      changedFiles: ["src/index.ts", "README.md"],
      verification: { status: "passed", summary: "Checks passed." },
      events: [
        { type: "verification", summary: "Report source verified." },
        { type: "note", summary: "Keep the report source linked to this session." }
      ]
    });
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "report-previous-001",
      title: "Previous report source",
      summary: "Included only in the previous-period comparison.",
      completedAt: "2026-09-15T12:00:00.000Z",
      changedFiles: ["src/previous.ts"]
    });
    const paused = store.finalizeSession({
      projectRoot: join(root, "paused"),
      idempotencyKey: "report-002",
      title: "Paused source session",
      summary: "Must not appear in the global report.",
      completedAt: "2026-09-16T13:00:00.000Z"
    });
    store.updateProject(pausedProject.id, { status: "paused" });

    expect(tracked).toMatchObject({ outcome: "finalized" });
    expect(paused).toMatchObject({ outcome: "finalized" });

    const report = store.getReport({ period: "day", date: "2026-09-16" });
    expect(report).toMatchObject({
      outcome: "report",
      period: "day",
      range: { from: "2026-09-16", to: "2026-09-16" },
      previousRange: { from: "2026-09-15", to: "2026-09-15" },
      timezone: "UTC",
      totals: { sessions: 1, events: 3, changedFiles: 2 },
      comparison: {
        sessions: { current: 1, previous: 1, delta: 0, direction: "flat" },
        events: { current: 3, previous: 1, delta: 2, direction: "up" },
        changedFiles: { current: 2, previous: 1, delta: 1, direction: "up" }
      }
    });
    if (report.outcome !== "report" || tracked.outcome !== "finalized") {
      throw new Error("Expected a tracked report and finalized source session");
    }
    expect(report.sourceSessionIds).toEqual([tracked.session.id]);
    expect(report.projects).toEqual([
      expect.objectContaining({
        projectId: trackedProject.id,
        projectName: "Tracked project",
        sessionCount: 1,
        eventCount: 3,
        sourceSessionIds: [tracked.session.id]
      })
    ]);
    expect(report.periodSummary).toContain("完成 1 個 Session");
    expect(report.completedWork.map((session) => session.id)).toEqual([tracked.session.id]);
    expect(report.decisions).toEqual([
      expect.objectContaining({
        sessionId: tracked.session.id,
        summary: "Keep the report source linked to this session."
      })
    ]);
    expect(report.trends).toEqual([{ date: "2026-09-16", sessions: 1, events: 3 }]);
    expect(report.evidence.map((item) => item.kind)).toEqual([
      "handoff",
      "verification",
      "changed-files",
      "event"
    ]);
    expect(report.risks).toEqual([]);

    expect(store.getReport({ period: "week", date: "2026-09-16" })).toMatchObject({
      outcome: "report",
      range: { from: "2026-09-14", to: "2026-09-20" },
      totals: { sessions: 2 }
    });
    expect(store.getReport({ period: "day", date: "2026-09-16", projectId: pausedProject.id })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused"
    });
  });

  it("builds quarter and year reports with monthly activity buckets", () => {
    const { store, root } = createStore();
    const project = store.addProject("Calendar report project", root);
    store.updateProject(project.id, { status: "tracked" });

    for (const [idempotencyKey, completedAt, changedFiles] of [
      ["calendar-jan", "2026-01-15T12:00:00.000Z", ["src/january.ts"]],
      ["calendar-mar", "2026-03-31T12:00:00.000Z", ["src/march.ts"]],
      ["calendar-apr", "2026-04-01T12:00:00.000Z", ["src/april.ts"]],
      ["calendar-dec", "2026-12-31T12:00:00.000Z", ["src/december.ts"]]
    ] as const) {
      store.finalizeSession({
        projectRoot: root,
        idempotencyKey,
        title: idempotencyKey,
        summary: "Calendar report source.",
        completedAt,
        changedFiles: [...changedFiles]
      });
    }

    const quarter = store.getReport({ period: "quarter", date: "2026-03-16", projectId: project.id });
    expect(quarter).toMatchObject({
      outcome: "report",
      period: "quarter",
      range: { from: "2026-01-01", to: "2026-03-31" },
      previousRange: { from: "2025-10-01", to: "2025-12-31" },
      trendGranularity: "month",
      totals: { sessions: 2, changedFiles: 2 }
    });
    if (quarter.outcome !== "report") {
      throw new Error("Expected a quarter report");
    }
    expect(quarter.trends).toEqual([
      { date: "2026-01-01", sessions: 1, events: 1 },
      { date: "2026-02-01", sessions: 0, events: 0 },
      { date: "2026-03-01", sessions: 1, events: 1 }
    ]);

    const year = store.getReport({ period: "year", date: "2026-09-16", projectId: project.id });
    expect(year).toMatchObject({
      outcome: "report",
      period: "year",
      range: { from: "2026-01-01", to: "2026-12-31" },
      previousRange: { from: "2025-01-01", to: "2025-12-31" },
      trendGranularity: "month",
      totals: { sessions: 4, changedFiles: 4 }
    });
    if (year.outcome !== "report") {
      throw new Error("Expected a year report");
    }
    expect(year.trends).toHaveLength(12);
    expect(year.trends.filter((point) => point.sessions > 0).map((point) => point.date)).toEqual([
      "2026-01-01",
      "2026-03-01",
      "2026-04-01",
      "2026-12-01"
    ]);
  });

  it("preserves explicit added, modified, deleted, and renamed file history", () => {
    const { store, root } = createStore();
    const project = store.addProject("File history project", root);
    store.updateProject(project.id, { status: "tracked" });

    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "file-history-001",
      title: "Track file lifecycle",
      summary: "Keep the semantic file changes separate from Git commit state.",
      changedFiles: [],
      changedFileChanges: [
        { path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts" },
        { path: "src/removed.ts", status: "deleted" }
      ],
      verification: { status: "passed" }
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized file history session");
    }
    expect(finalized.session.changedFiles).toEqual([
      "src/new-name.ts",
      "src/old-name.ts",
      "src/removed.ts"
    ]);
    expect(finalized.session.changedFileChanges).toEqual([
      { path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts" },
      { path: "src/removed.ts", status: "deleted" }
    ]);

    const merged = store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/added.ts"],
      changedFilesMode: "merge",
      changedFileChanges: [
        { path: "src/added.ts", status: "added" },
        { path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts" }
      ]
    });
    expect(merged).toMatchObject({
      outcome: "updated",
      session: {
        changedFileChanges: [
          { path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts" },
          { path: "src/removed.ts", status: "deleted" },
          { path: "src/added.ts", status: "added" }
        ]
      }
    });

    const replaced = store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/final.ts"],
      changedFileChanges: [{ path: "src/final.ts", status: "modified" }]
    });
    expect(replaced).toMatchObject({
      outcome: "updated",
      session: {
        changedFiles: ["src/final.ts"],
        changedFileChanges: [{ path: "src/final.ts", status: "modified" }]
      }
    });

    expect(() => store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "file-history-invalid-001",
      title: "Invalid rename",
      summary: "A rename without its previous path must be rejected.",
      changedFiles: [],
      changedFileChanges: [{ path: "src/missing-previous.ts", status: "renamed" }],
      verification: { status: "passed" }
    })).toThrow("previousPath");
  });

  it("keeps missing verification distinct and lets an agent backfill session metadata", () => {
    const { store, root } = createStore();
    const project = store.addProject("Backfill project", root);
    store.updateProject(project.id, { status: "tracked" });

    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "backfill-001",
      title: "Completed work without structured metadata",
      summary: "The handoff says the task is complete, but the first submission omitted structured fields.",
      completedAt: "2026-09-17T12:00:00.000Z",
      handoffContent: "Status: complete"
    });
    expect(finalized).toMatchObject({
      outcome: "finalized",
      verificationFollowUp: { required: true },
      changedFilesFollowUp: { required: true }
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized session");
    }

    const before = store.getReport({ period: "day", date: "2026-09-17" });
    expect(before).toMatchObject({
      outcome: "report",
      totals: { verification: { not_supplied: 1 } },
      risks: expect.arrayContaining([
        expect.objectContaining({ label: "Verification 尚未回報" }),
        expect.objectContaining({ label: "變更檔案 metadata 未提供" })
      ])
    });

    const updated = store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/completed-work.ts"],
      verification: { status: "passed", summary: "Agent confirmed the verification result." }
    });
    expect(updated).toMatchObject({ outcome: "updated", session: { id: finalized.session.id } });

    const after = store.getReport({ period: "day", date: "2026-09-17" });
    expect(after).toMatchObject({
      outcome: "report",
      totals: { changedFiles: 1, verification: { passed: 1, not_supplied: 0 } }
    });
    if (after.outcome !== "report") {
      throw new Error("Expected an updated report");
    }
    expect(after.risks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Verification 尚未回報" }),
      expect.objectContaining({ label: "變更檔案 metadata 未提供" })
    ]));

    store.updateProject(project.id, { status: "paused" });
    expect(store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/should-not-update.ts"]
    })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });

  it("exports deterministic Markdown and JSON reports while preserving policy skips", () => {
    const { store, root } = createStore();
    const project = store.addProject("Export project", root);
    store.updateProject(project.id, { status: "tracked" });
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "export-001",
      title: "Export source session",
      summary: "A report should be downloadable without losing source evidence.",
      completedAt: "2026-09-17T12:00:00.000Z",
      handoffContent: "# Closing\n\nThe export source is complete.",
      changedFiles: ["src/export.ts"],
      verification: { status: "passed", summary: "Export source verified." },
      events: [{ type: "note", summary: "Keep the exported report reproducible." }]
    });

    const markdown = store.exportReport({
      period: "day",
      date: "2026-09-17",
      projectId: project.id,
      format: "markdown"
    });
    expect(markdown).toMatchObject({
      outcome: "report_export",
      format: "markdown",
      filename: "work-report-day-2026-09-17-to-2026-09-17-Export-project.md",
      contentType: "text/markdown; charset=utf-8",
      report: { outcome: "report", sourceSessionIds: expect.any(Array) }
    });
    if (markdown.outcome !== "report_export") {
      throw new Error("Expected a Markdown report export");
    }
    expect(markdown.content).toContain("# Work Intelligence 工作報告");
    expect(markdown.content).toContain("## 上一期比較");
    expect(markdown.content).toContain("Export source session");
    expect(markdown.content).toContain("## 來源證據");

    const json = store.exportReport({
      period: "day",
      date: "2026-09-17",
      projectId: project.id,
      format: "json"
    });
    expect(json).toMatchObject({
      outcome: "report_export",
      format: "json",
      filename: "work-report-day-2026-09-17-to-2026-09-17-Export-project.json",
      contentType: "application/json; charset=utf-8"
    });
    if (json.outcome !== "report_export") {
      throw new Error("Expected a JSON report export");
    }
    expect(JSON.parse(json.content)).toMatchObject({
      outcome: "report",
      period: "day",
      range: { from: "2026-09-17", to: "2026-09-17" },
      sourceSessionIds: [expect.any(String)]
    });

    store.updateProject(project.id, { status: "paused" });
    expect(store.exportReport({
      period: "day",
      date: "2026-09-17",
      projectId: project.id,
      format: "markdown"
    })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });

  it("normalizes changed file paths and merges their evidence sources", () => {
    const { store, root } = createStore();
    const project = store.addProject("Provenance project", root);
    store.updateProject(project.id, { status: "tracked" });

    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "provenance-001",
      title: "Normalize changed files",
      summary: "Store project-relative file metadata with evidence sources.",
      changedFiles: [join(root, "src", "index.ts"), "src\\index.ts", "./README.md"],
      changedFilesProvenance: [
        {
          path: "src/index.ts",
          sources: ["git"],
          references: ["git diff --name-only"]
        },
        {
          path: join(root, "src", "index.ts"),
          sources: ["worktree"],
          references: ["worktree diff"]
        }
      ],
      verification: { status: "passed" }
    });

    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized provenance session");
    }
    expect(finalized.session.changedFiles).toEqual(["src/index.ts", "README.md"]);
    expect(finalized.session.changedFilesProvenance).toEqual([
      {
        path: "src/index.ts",
        sources: ["git", "worktree"],
        references: ["git diff --name-only", "worktree diff"]
      },
      { path: "README.md", sources: ["agent"] }
    ]);

    expect(() => store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "provenance-outside-001",
      title: "Reject outside path",
      summary: "An outside path must not be stored.",
      changedFiles: [join(root, "..", "outside.ts")],
      verification: { status: "not_run" }
    })).toThrow("inside the tracked project root");
    expect(store.listSessions()).toHaveLength(1);
  });

  it("previews metadata gaps and applies only explicit batch updates", () => {
    const { store, root } = createStore();
    const project = store.addProject("Backfill queue project", root);
    const pausedRoot = join(root, "paused");
    const pausedProject = store.addProject("Paused backfill project", pausedRoot);
    store.updateProject(project.id, { status: "tracked" });
    store.updateProject(pausedProject.id, { status: "tracked" });

    const missing = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "batch-backfill-missing",
      title: "Missing metadata session",
      summary: "This session needs both structured fields.",
      completedAt: "2026-09-17T12:00:00.000Z"
    });
    const notRun = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "batch-backfill-not-run",
      title: "Not run verification session",
      summary: "This session needs a confirmed verification result.",
      completedAt: "2026-09-16T12:00:00.000Z",
      changedFiles: ["src/not-run.ts"],
      verification: { status: "not_run" }
    });
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "batch-backfill-complete",
      title: "Complete metadata session",
      summary: "This session should not appear in the queue.",
      completedAt: "2026-09-15T12:00:00.000Z",
      changedFiles: ["src/complete.ts"],
      verification: { status: "passed" }
    });
    const paused = store.finalizeSession({
      projectRoot: pausedRoot,
      idempotencyKey: "batch-backfill-paused",
      title: "Paused metadata session",
      summary: "The project will be paused before applying updates.",
      changedFiles: ["src/paused.ts"],
      verification: { status: "not_run" }
    });
    store.updateProject(pausedProject.id, { status: "paused" });

    expect(missing).toMatchObject({ outcome: "finalized" });
    expect(notRun).toMatchObject({ outcome: "finalized" });
    expect(paused).toMatchObject({ outcome: "finalized" });
    if (missing.outcome !== "finalized" || notRun.outcome !== "finalized" || paused.outcome !== "finalized") {
      throw new Error("Expected metadata backfill sessions to be finalized");
    }

    const preview = store.previewMetadataBackfill({ limit: 10 });
    expect(preview).toMatchObject({
      outcome: "backfill_preview",
      scannedSessions: 3,
      truncated: false,
      totals: {
        needsBackfill: 2,
        changedFilesMissing: 1,
        verificationMissing: 1,
        verificationNotRun: 1
      }
    });
    if (preview.outcome !== "backfill_preview") {
      throw new Error("Expected a metadata backfill preview");
    }
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: missing.session.id,
        title: "Missing metadata session",
        verificationStatus: "not_supplied",
        gaps: ["changed_files", "verification"],
        rawSnapshotCount: 0
      }),
      expect.objectContaining({
        sessionId: notRun.session.id,
        title: "Not run verification session",
        verificationStatus: "not_run",
        gaps: ["verification"],
        changedFilesCount: 1
      })
    ]));

    const request = store.createMetadataBackfillRequest({});
    expect(request).toMatchObject({
      outcome: "metadata_backfill_request",
      duplicate: false,
      request: { status: "pending", sourceSessionIds: expect.arrayContaining([missing.session.id, notRun.session.id]) }
    });
    if (request.outcome !== "metadata_backfill_request") {
      throw new Error("Expected a metadata backfill request");
    }
    expect(store.createMetadataBackfillRequest({})).toMatchObject({
      outcome: "metadata_backfill_request",
      duplicate: true,
      request: { id: request.request.id }
    });
    const context = store.getMetadataBackfillContext({ requestId: request.request.id });
    expect(context).toMatchObject({
      outcome: "metadata_backfill_context",
      request: { status: "processing" },
      items: expect.arrayContaining([
        expect.objectContaining({ sessionId: missing.session.id, changedFiles: [] }),
        expect.objectContaining({ sessionId: notRun.session.id, changedFiles: ["src/not-run.ts"] })
      ])
    });

    const updated = store.applyMetadataBackfill({
      requestId: request.request.id,
      updates: [{
        sessionId: missing.session.id,
        changedFiles: ["src/recovered.ts"],
        changedFilesProvenance: [{
          path: "src/recovered.ts",
          sources: ["worktree"],
          references: ["confirmed worktree diff"]
        }],
        verification: { status: "passed", summary: "Agent confirmed the existing verification evidence." },
        git: { branch: "feature/backfill" }
      }]
    });
    expect(updated).toMatchObject({
      outcome: "backfill_applied",
      requestedCount: 1,
      skipped: [],
      failures: []
    });
    expect(updated).toMatchObject({
      request: { id: request.request.id, status: "processing" },
      remainingItems: [expect.objectContaining({ sessionId: notRun.session.id })]
    });
    expect(updated.outcome).toBe("backfill_applied");
    if (updated.outcome !== "backfill_applied") {
      throw new Error("Expected metadata backfill to be applied.");
    }
    expect(updated.updated).toHaveLength(1);
    expect(store.getSessionById(missing.session.id)).toMatchObject({
      id: missing.session.id,
      idempotencyKey: "batch-backfill-missing",
      title: "Missing metadata session",
      summary: "This session needs both structured fields.",
      changedFiles: ["src/recovered.ts"],
      verification: { status: "passed" },
      gitBranch: "feature/backfill"
    });

    const completed = store.applyMetadataBackfill({
      requestId: request.request.id,
      updates: [{
        sessionId: notRun.session.id,
        changedFiles: [],
        changedFilesMode: "merge",
        verification: { status: "passed", summary: "Agent confirmed the verification evidence." }
      }]
    });
    expect(completed).toMatchObject({
      outcome: "backfill_applied",
      request: { id: request.request.id, status: "completed" },
      remainingItems: []
    });

    const retry = store.applyMetadataBackfill({
      updates: [
        { sessionId: missing.session.id, changedFiles: ["src/last-writer.ts"] },
        { sessionId: missing.session.id, changedFiles: ["src/duplicate.ts"] }
      ]
    });
    expect(retry).toMatchObject({
      outcome: "backfill_applied",
      requestedCount: 2,
      updated: [expect.objectContaining({ id: missing.session.id })],
      skipped: [],
      failures: [{ sessionId: missing.session.id }]
    });
    expect(store.getSessionById(missing.session.id)?.changedFiles).toEqual(["src/last-writer.ts"]);

    const pausedUpdate = store.applyMetadataBackfill({
      updates: [{ sessionId: paused.session.id, changedFiles: ["src/should-not-update.ts"] }]
    });
    expect(pausedUpdate).toMatchObject({
      outcome: "backfill_applied",
      updated: [],
      skipped: [{ sessionId: paused.session.id, projectStatus: "paused" }],
      failures: []
    });

    const unregisteredRoot = join(root, "unregistered");
    const unregistered = store.addProject("Unregistered backfill project", unregisteredRoot);
    expect(unregistered).toMatchObject({ status: "unregistered" });
    expect(store.previewMetadataBackfill({ projectRoot: unregisteredRoot })).toMatchObject({
      outcome: "skipped",
      projectStatus: "unregistered"
    });
  });

  it("cancels metadata backfill without writing and allows a fresh request", () => {
    const { store, root } = createStore();
    const project = store.addProject("Cancellable metadata project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "metadata-cancel-session-001",
      title: "Metadata cancellation source",
      summary: "This session intentionally has missing structured metadata."
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a metadata cancellation source session");
    }

    const first = store.createMetadataBackfillRequest({});
    expect(first).toMatchObject({ outcome: "metadata_backfill_request", duplicate: false });
    if (first.outcome !== "metadata_backfill_request") {
      throw new Error("Expected a metadata backfill request");
    }
    expect(store.cancelMetadataBackfillRequest(first.request.id)).toMatchObject({
      outcome: "metadata_backfill_request_cancelled",
      duplicate: false,
      request: { id: first.request.id, status: "cancelled" }
    });
    expect(store.cancelMetadataBackfillRequest(first.request.id)).toMatchObject({
      outcome: "metadata_backfill_request_cancelled",
      duplicate: true,
      request: { id: first.request.id, status: "cancelled" }
    });
    expect(store.getMetadataBackfillContext({ requestId: first.request.id })).toMatchObject({
      outcome: "metadata_backfill_request_not_ready",
      request: { status: "cancelled" }
    });
    expect(store.applyMetadataBackfill({
      requestId: first.request.id,
      updates: [{ sessionId: finalized.session.id, changedFiles: ["src/must-not-write.ts"] }]
    })).toMatchObject({
      outcome: "metadata_backfill_request_not_ready",
      request: { status: "cancelled" }
    });
    expect(store.getSessionById(finalized.session.id)?.changedFiles).toEqual([]);

    const recreated = store.createMetadataBackfillRequest({});
    expect(recreated).toMatchObject({ outcome: "metadata_backfill_request", duplicate: false, request: { status: "pending" } });
    if (recreated.outcome !== "metadata_backfill_request") {
      throw new Error("Expected a fresh metadata backfill request after cancellation");
    }
    expect(recreated.request.id).not.toBe(first.request.id);
  });

  it("returns projectId when project-scoped metadata operations are policy-skipped", () => {
    const { store, root } = createStore();
    const project = store.addProject("Policy-scoped metadata project", root);

    expect(store.createMetadataBackfillRequest({ projectId: "missing-project" })).toMatchObject({
      outcome: "skipped",
      projectId: "missing-project",
      projectStatus: "unregistered"
    });
    expect(store.listMetadataBackfillRequests({ projectId: "missing-project" })).toMatchObject({
      outcome: "skipped",
      projectId: "missing-project",
      projectStatus: "unregistered"
    });

    store.updateProject(project.id, { status: "tracked" });
    const session = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "metadata-policy-session-001",
      title: "Policy scoped metadata source",
      summary: "This tracked session creates a policy-scoped metadata request."
    });
    expect(session).toMatchObject({ outcome: "finalized" });
    const request = store.createMetadataBackfillRequest({ projectId: project.id });
    expect(request).toMatchObject({ outcome: "metadata_backfill_request" });
    if (request.outcome !== "metadata_backfill_request") {
      throw new Error("Expected a project-scoped metadata backfill request");
    }

    store.updateProject(project.id, { status: "paused" });
    expect(store.listMetadataBackfillRequests({ projectId: project.id })).toMatchObject({
      outcome: "skipped",
      projectId: project.id,
      projectStatus: "paused"
    });
    expect(store.cancelMetadataBackfillRequest(request.request.id)).toMatchObject({
      outcome: "skipped",
      projectId: project.id,
      projectStatus: "paused"
    });
    expect(store.getMetadataBackfillContext({ requestId: request.request.id })).toMatchObject({
      outcome: "skipped",
      projectId: project.id,
      projectStatus: "paused"
    });
  });

  it("recovers stale metadata backfill processing requests", () => {
    const { store, root } = createStore();
    const project = store.addProject("Stale metadata project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "stale-metadata-session-001",
      title: "Stale metadata source",
      summary: "This Session needs metadata recovery."
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a stale metadata source Session");
    }

    const created = store.createMetadataBackfillRequest({ idempotencyKey: "stale-metadata-request-001" });
    if (created.outcome !== "metadata_backfill_request") {
      throw new Error("Expected a metadata backfill request");
    }
    expect(store.getMetadataBackfillContext({ requestId: created.request.id })).toMatchObject({
      outcome: "metadata_backfill_context",
      request: { status: "processing" }
    });

    const database = (store as unknown as { db: DatabaseSync }).db;
    database
      .prepare("UPDATE metadata_backfill_requests SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), created.request.id);

    expect(store.listMetadataBackfillRequests({ requestId: created.request.id })).toMatchObject({
      outcome: "metadata_backfill_requests",
      requests: [{ status: "failed", failureReason: expect.stringContaining("30 分鐘") }]
    });
  });

  it("previews and idempotently imports only explicitly completed handoffs", () => {
    const { store, root } = createStore();
    const project = store.addProject("Historical project", root);
    store.updateProject(project.id, { status: "tracked" });
    const handoffDirectory = join(root, ".openspec", "handoffs");
    mkdirSync(handoffDirectory, { recursive: true });
    writeFileSync(
      join(handoffDirectory, "completed.md"),
      `# Completed feature

Recorded date: 2026-09-17
Status: complete

Implemented the feature and captured its verification evidence.

## Changed files
- src/feature.ts

## Verification
Result: PASSED
`,
      "utf8"
    );
    writeFileSync(join(handoffDirectory, "blocked.md"), "# Blocked task\n\nStatus: blocked\n", "utf8");
    writeFileSync(join(handoffDirectory, "pending.md"), "# Pending task\n\nStatus: pending\n", "utf8");
    writeFileSync(join(handoffDirectory, "planning.md"), "# Planning task\n\nStatus: planning\n", "utf8");
    writeFileSync(join(handoffDirectory, "unknown.md"), "# Undecided task\n\nNotes without a completion status.\n", "utf8");
    writeFileSync(join(handoffDirectory, "excluded.md"), "# Excluded complete task\n\nStatus: complete\n", "utf8");

    const preview = store.previewHandoffImport({
      projectRoot: root,
      excludePaths: [".openspec/handoffs/excluded.md"]
    });
    expect(preview).toMatchObject({
      outcome: "preview",
      project: { id: project.id, status: "tracked" },
      handoffDirectory: ".openspec/handoffs",
      directoryFound: true,
      truncated: false,
      totals: { discovered: 6, eligible: 1, excluded: 5, alreadyImported: 0, errors: 0 }
    });
    if (preview.outcome !== "preview") {
      throw new Error("Expected a handoff import preview");
    }
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: ".openspec/handoffs/completed.md",
        title: "Completed feature",
        decision: "eligible",
        recordedDate: "2026-09-17",
        verificationStatus: "passed",
        changedFiles: ["src/feature.ts"],
        changedFilesStatus: "detected"
      }),
      expect.objectContaining({ sourcePath: ".openspec/handoffs/blocked.md", decision: "excluded", reason: "blocked" }),
      expect.objectContaining({ sourcePath: ".openspec/handoffs/pending.md", decision: "excluded", reason: "pending" }),
      expect.objectContaining({ sourcePath: ".openspec/handoffs/planning.md", decision: "excluded", reason: "planning_only" }),
      expect.objectContaining({ sourcePath: ".openspec/handoffs/unknown.md", decision: "excluded", reason: "no_explicit_completion" }),
      expect.objectContaining({ sourcePath: ".openspec/handoffs/excluded.md", decision: "excluded", reason: "excluded_by_user" })
    ]));

    const imported = store.importHandoffs({
      projectRoot: root,
      sourcePaths: [".openspec/handoffs/completed.md"],
      excludePaths: [".openspec/handoffs/excluded.md"]
    });
    expect(imported).toMatchObject({ outcome: "imported", selectedCount: 1, failures: [], skipped: [] });
    if (imported.outcome !== "imported") {
      throw new Error("Expected a handoff import result");
    }
    expect(imported.imported).toHaveLength(1);
    expect(imported.imported[0]).toMatchObject({
      title: "Completed feature",
      completedAt: "2026-09-17T12:00:00.000Z",
      changedFiles: ["src/feature.ts"],
      changedFilesProvenance: [{ path: "src/feature.ts", sources: ["handoff"], references: [".openspec/handoffs/completed.md"] }],
      verification: { status: "passed" }
    });
    const detail = store.getSessionDetail(imported.imported[0]?.id ?? "");
    expect(detail?.rawSnapshots[0]?.sourcePath).toBe(".openspec/handoffs/completed.md");

    const retry = store.importHandoffs({
      projectRoot: root,
      sourcePaths: [".openspec/handoffs/completed.md"]
    });
    expect(retry).toMatchObject({ outcome: "imported", selectedCount: 1, imported: [], failures: [] });
    if (retry.outcome !== "imported") {
      throw new Error("Expected an idempotent handoff import result");
    }
    expect(retry.skipped).toEqual([
      expect.objectContaining({
        sourcePath: ".openspec/handoffs/completed.md",
        decision: "already_imported",
        reason: "already_imported"
      })
    ]);
    expect(store.listSessions()).toHaveLength(1);
  });

  it("attaches idempotent evidence to tracked sessions and keeps policy skips quiet", () => {
    const { store, root } = createStore();
    const project = store.addProject("Evidence project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "evidence-001",
      title: "Capture evidence",
      summary: "Keep external verification references linked to the session.",
      verification: { status: "passed" }
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected an evidence session");
    }

    const input = {
      sessionId: finalized.session.id,
      kind: "test",
      reference: "pnpm test --filter storage",
      summary: "Storage and policy tests passed."
    };
    const first = store.attachEvidence(input);
    expect(first).toMatchObject({
      outcome: "evidence_attached",
      duplicate: false,
      evidence: {
        sessionId: finalized.session.id,
        projectId: project.id,
        kind: "test",
        reference: input.reference,
        summary: input.summary
      }
    });
    if (first.outcome !== "evidence_attached") {
      throw new Error("Expected evidence to be attached");
    }

    const retry = store.attachEvidence({ ...input, summary: "A retry must preserve the original evidence." });
    expect(retry).toMatchObject({
      outcome: "evidence_attached",
      duplicate: true,
      evidence: { id: first.evidence.id, summary: input.summary }
    });

    const detail = store.getSessionDetail(finalized.session.id);
    expect(detail?.evidence).toEqual([expect.objectContaining({ id: first.evidence.id, kind: "test" })]);

    const report = store.getReport({ period: "day", date: finalized.session.completedAt.slice(0, 10) });
    expect(report).toMatchObject({ outcome: "report" });
    if (report.outcome !== "report") {
      throw new Error("Expected an evidence report");
    }
    expect(report.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "attached",
        sessionId: finalized.session.id,
        reference: input.reference,
        detail: input.summary
      })
    ]));

    store.updateProject(project.id, { status: "paused" });
    expect(store.attachEvidence({ ...input, reference: "paused-reference" })).toMatchObject({
      outcome: "skipped",
      sessionId: finalized.session.id,
      projectStatus: "paused"
    });
    expect(store.getSessionDetail(finalized.session.id)).toBeUndefined();
    store.updateProject(project.id, { status: "tracked" });
    expect(store.getSessionDetail(finalized.session.id)).toMatchObject({ evidence: [expect.any(Object)] });
  });

  it("records explicit knowledge with session provenance and policy-gated search", () => {
    const { store, root } = createStore();
    const project = store.addProject("Knowledge project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "knowledge-session-001",
      title: "Establish storage boundary",
      summary: "Confirmed the local SQLite boundary for the work record.",
      verification: { status: "passed" }
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized knowledge source session");
    }

    const input = {
      projectRoot: root,
      idempotencyKey: "knowledge-001",
      kind: "decision" as const,
      title: "Keep the registry in central SQLite",
      body: "Project tracking belongs to the central registry; repositories must not receive configuration files.",
      sessionId: finalized.session.id,
      tags: ["architecture", "registry", "architecture"],
      references: ["README.md#project-recording-policy"]
    };
    const first = store.recordKnowledge(input);
    expect(first).toMatchObject({
      outcome: "knowledge_recorded",
      duplicate: false,
      knowledge: {
        projectId: project.id,
        projectName: project.name,
        sessionId: finalized.session.id,
        kind: "decision",
        title: input.title,
        tags: ["architecture", "registry"],
        references: input.references,
        status: "active"
      }
    });
    if (first.outcome !== "knowledge_recorded") {
      throw new Error("Expected knowledge to be recorded");
    }

    const retry = store.recordKnowledge({ ...input, body: "A retry must preserve the first confirmed body." });
    expect(retry).toMatchObject({
      outcome: "knowledge_recorded",
      duplicate: true,
      knowledge: { id: first.knowledge.id, body: input.body }
    });

    const search = store.searchKnowledge({ projectRoot: root, query: "central SQLite" });
    expect(search).toMatchObject({ outcome: "knowledge", project: { id: project.id } });
    if (search.outcome !== "knowledge") {
      throw new Error("Expected tracked knowledge search results");
    }
    expect(search.items).toEqual([expect.objectContaining({ id: first.knowledge.id, sessionId: finalized.session.id })]);
    const allKnowledge = store.searchKnowledge({ projectId: project.id, pageSize: 0 });
    expect(allKnowledge).toMatchObject({ outcome: "knowledge", pageInfo: { page: 1, pageSize: 1, total: 1, totalPages: 1, from: 1, to: 1 } });
    if (allKnowledge.outcome !== "knowledge") {
      throw new Error("Expected all Knowledge results");
    }
    expect(allKnowledge.items).toHaveLength(1);
    expect(store.getContext(root)).toMatchObject({ recentKnowledge: [expect.objectContaining({ id: first.knowledge.id })] });
    expect(store.getSessionDetail(finalized.session.id)).toMatchObject({
      knowledge: [expect.objectContaining({ id: first.knowledge.id })]
    });

    store.updateProject(project.id, { status: "paused" });
    expect(store.recordKnowledge({ ...input, idempotencyKey: "knowledge-paused" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused"
    });
    expect(store.searchKnowledge({ projectId: project.id })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused"
    });
  });

  it("updates, archives, and restores explicit knowledge through the policy gate", () => {
    vi.useFakeTimers({ now: new Date("2026-09-21T00:00:00.000Z") });
    const { store, root } = createStore();
    const project = store.addProject("Knowledge maintenance project", root);
    store.updateProject(project.id, { status: "tracked" });
    const created = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "knowledge-maintenance-001",
      kind: "gotcha",
      title: "Original title",
      body: "Original body",
      tags: ["first"],
      references: ["notes.md"]
    });
    expect(created).toMatchObject({ outcome: "knowledge_recorded" });
    if (created.outcome !== "knowledge_recorded") {
      throw new Error("Expected Knowledge to be recorded");
    }

    const archived = store.updateKnowledge({
      projectRoot: root,
      knowledgeId: created.knowledge.id,
      title: "Updated title",
      body: "Updated body",
      tags: ["updated", "updated"],
      references: ["README.md"],
      status: "archived"
    });
    expect(archived).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: {
        id: created.knowledge.id,
        title: "Updated title",
        body: "Updated body",
        tags: ["updated"],
        references: ["README.md"],
        status: "archived"
      }
    });
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({ outcome: "knowledge", items: [] });
    expect(store.searchKnowledge({ projectRoot: root, status: "archived" })).toMatchObject({
      outcome: "knowledge",
      items: [expect.objectContaining({ id: created.knowledge.id, status: "archived" })]
    });

    const restored = store.updateKnowledge({
      projectRoot: root,
      knowledgeId: created.knowledge.id,
      status: "active"
    });
    expect(restored).toMatchObject({ outcome: "knowledge_updated", knowledge: { status: "active" } });

    const history = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: created.knowledge.id });
    expect(history).toMatchObject({
      outcome: "knowledge_history",
      knowledge: { id: created.knowledge.id, status: "active" },
      history: [
        { action: "restored", changedFields: ["status"] },
        { action: "archived", changedFields: ["title", "body", "tags", "references", "status"] },
        { action: "created", changedFields: ["kind", "title", "body", "tags", "references", "status"] }
      ]
    });
    if (history.outcome !== "knowledge_history") {
      throw new Error("Expected Knowledge audit history");
    }
    expect(history.history[1]?.before).toMatchObject({ title: "Original title", status: "active" });
    expect(history.history[1]?.after).toMatchObject({ title: "Updated title", status: "archived" });

    store.updateProject(project.id, { status: "paused" });
    expect(store.updateKnowledge({
      projectRoot: root,
      knowledgeId: created.knowledge.id,
      title: "Must not update while paused"
    })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(store.getKnowledgeHistory({ projectRoot: root, knowledgeId: created.knowledge.id })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused"
    });
  });

  it("safely merges explicitly reported metadata across stages and deduplicates provenance", () => {
    const { store, root } = createStore();
    const project = store.addProject("Metadata merge project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "metadata-merge-001",
      title: "Multi-stage metadata",
      summary: "Each independently verified stage should contribute its confirmed paths.",
      changedFiles: ["src/first.ts"],
      verification: { status: "passed" }
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized metadata merge session");
    }

    const firstStage = store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/first.ts", "src/second.ts"],
      changedFilesMode: "merge",
      changedFilesProvenance: [
        { path: "src/first.ts", sources: ["worktree"], references: ["stage 1 diff"] },
        { path: "src/second.ts", sources: ["git"], references: ["stage 2 commit"] }
      ]
    });
    expect(firstStage).toMatchObject({
      outcome: "updated",
      session: {
        changedFiles: ["src/first.ts", "src/second.ts"],
        changedFilesProvenance: [
          { path: "src/first.ts", sources: ["agent", "worktree"], references: ["stage 1 diff"] },
          { path: "src/second.ts", sources: ["git"], references: ["stage 2 commit"] }
        ]
      }
    });

    const secondStage = store.updateSessionMetadata({
      sessionId: finalized.session.id,
      changedFiles: ["src/second.ts", "src/third.ts"],
      changedFilesMode: "merge",
      changedFilesProvenance: [
        { path: "src/second.ts", sources: ["handoff"], references: ["stage 2 handoff"] },
        { path: "src/third.ts", sources: ["worktree"], references: ["stage 3 diff"] }
      ]
    });
    expect(secondStage).toMatchObject({
      outcome: "updated",
      session: {
        changedFiles: ["src/first.ts", "src/second.ts", "src/third.ts"],
        changedFilesProvenance: [
          { path: "src/first.ts", sources: ["agent", "worktree"], references: ["stage 1 diff"] },
          { path: "src/second.ts", sources: ["handoff", "git"], references: ["stage 2 commit", "stage 2 handoff"] },
          { path: "src/third.ts", sources: ["worktree"], references: ["stage 3 diff"] }
        ]
      }
    });
  });

  it("builds a tracked-only deterministic graph without reading project source", () => {
    const { store, root } = createStore();
    const project = store.addProject("Graph project", root);
    const hiddenProject = store.addProject("Hidden graph project", join(root, "hidden"));
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "graph-session-001",
      title: "Create graph source",
      summary: "Create graph nodes from structured work records.",
      changedFiles: ["src/graph.ts"],
      verification: { status: "passed" }
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a graph source session");
    }
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "graph-knowledge-001",
      kind: "pattern",
      title: "Graph uses structured metadata",
      body: "Graph edges are deterministic and trace back to stored records.",
      sessionId: finalized.session.id
    });
    const evidence = store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "pnpm test --filter storage",
      summary: "Graph storage test passed."
    });
    expect(knowledge).toMatchObject({ outcome: "knowledge_recorded" });
    expect(evidence).toMatchObject({ outcome: "evidence_attached" });

    const graph = store.getGraph({ projectRoot: root, limit: 10 });
    expect(graph).toMatchObject({ outcome: "graph", project: { id: project.id }, sourceProjectIds: [project.id] });
    if (graph.outcome !== "graph") {
      throw new Error("Expected a tracked project graph");
    }
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "project", projectId: project.id, label: project.name }),
      expect.objectContaining({ kind: "session", sessionId: finalized.session.id }),
      expect.objectContaining({ kind: "file", label: "src/graph.ts" }),
      expect.objectContaining({ kind: "knowledge", label: "Graph uses structured metadata" }),
      expect.objectContaining({ kind: "evidence", sessionId: finalized.session.id })
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains" }),
      expect.objectContaining({ kind: "changed_file" }),
      expect.objectContaining({ kind: "has_knowledge" }),
      expect.objectContaining({ kind: "has_evidence" })
    ]));
    expect(graph.nodes.some((node) => node.label === hiddenProject.name)).toBe(false);

    store.updateProject(project.id, { status: "paused" });
    expect(store.getGraph({ projectId: project.id })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });

  it("paginates sessions and bounds graph results with total counts", () => {
    const { store, root } = createStore();
    const project = store.addProject("Pagination project", root);
    store.updateProject(project.id, { status: "tracked" });
    for (let index = 0; index < 5; index += 1) {
      store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `pagination-${index}`,
        title: `Pagination session ${index}`,
        summary: "A session used to verify backend pagination.",
        completedAt: `2026-09-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
        changedFiles: [`src/pagination-${index}.ts`],
        verification: { status: "passed" }
      });
    }

    const page = store.listSessionsPage({ projectId: project.id, page: 2, pageSize: 2 });
    expect(page.pageInfo).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3, from: 3, to: 4, hasPrevious: true, hasNext: true });
    expect(page.items).toHaveLength(2);
    const all = store.listSessionsPage({ projectId: project.id, pageSize: 0 });
    expect(all.pageInfo).toMatchObject({ page: 1, pageSize: 5, total: 5, totalPages: 1, from: 1, to: 5, hasPrevious: false, hasNext: false });
    expect(all.items).toHaveLength(5);
    const graph = store.getGraph({ projectId: project.id, limit: 50, maxNodes: 2, maxEdges: 1 });
    expect(graph).toMatchObject({
      outcome: "graph",
      totalNodes: 11,
      totalEdges: 10,
      totalNodesByKind: { project: 1, session: 5, knowledge: 0, evidence: 0, file: 5 }
    });
    if (graph.outcome !== "graph") {
      throw new Error("Expected a graph result");
    }
    expect(graph.nodes.length).toBeLessThanOrEqual(2);
    expect(graph.edges.length).toBeLessThanOrEqual(1);
    expect(graph.truncation.nodesTruncated).toBe(true);
    expect(graph.truncation.edgesTruncated).toBe(true);
  });

  it("creates, bounds, and idempotently saves an Agent report synthesis", () => {
    const { store, root } = createStore();
    const project = store.addProject("Synthesis project", root);
    const pausedProject = store.addProject("Private paused project", join(root, "paused"));
    store.updateProject(project.id, { status: "tracked" });
    store.updateProject(pausedProject.id, { status: "paused" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "synthesis-session-001",
      title: "Build report synthesis contract",
      summary: "Create a deterministic report context for the Agent.",
      completedAt: "2026-09-17T12:00:00.000Z",
      handoffContent: "Closing: report context is ready. Verification passed.",
      changedFiles: ["packages/core/src/index.ts"],
      verification: { status: "passed", summary: "Storage tests passed." },
      events: [{ type: "note", summary: "Keep Agent summaries traceable." }]
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized synthesis source session");
    }

    const created = store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-17",
      projectId: project.id,
      idempotencyKey: "synthesis-request-001"
    });
    expect(created).toMatchObject({ outcome: "report_synthesis_request", duplicate: false, request: { status: "pending", sourceSessionIds: [finalized.session.id] } });
    if (created.outcome !== "report_synthesis_request") {
      throw new Error("Expected a synthesis request");
    }
    expect(store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-17",
      projectId: project.id,
      idempotencyKey: "synthesis-request-001"
    })).toMatchObject({ outcome: "report_synthesis_request", duplicate: true, request: { id: created.request.id } });

    const context = store.getReportSynthesisContext({ requestId: created.request.id, maxSessions: 1, maxEvidence: 2, maxHandoffCharacters: 1000 });
    expect(context).toMatchObject({ outcome: "report_context", request: { status: "processing" }, handoffSummaries: [{ sessionId: finalized.session.id }] });
    if (context.outcome !== "report_context") {
      throw new Error("Expected bounded synthesis context");
    }
    expect(context.report.outcome).toBe("report");
    expect(context.sourceSessionIds).toEqual([finalized.session.id]);

    const saved = store.saveReportSummary({
      requestId: created.request.id,
      title: "本週工作報告",
      executiveSummary: "完成報告提煉契約，資料不足部分已明確保留。",
      themes: [{ title: "報告治理", detail: "建立可重跑且可追溯的提煉流程。", sourceSessionIds: [finalized.session.id] }],
      highlights: [{ title: "完成 MCP contract", detail: "建立受控 context 與回寫流程。", sourceSessionIds: [finalized.session.id] }],
      verification: [{ title: "測試通過", detail: "Storage tests passed。", sourceSessionIds: [finalized.session.id] }],
      comparison: [{ title: "相較上一期", detail: "本期新增一個可回寫摘要的 Session。", sourceSessionIds: [finalized.session.id] }],
      risks: [],
      decisions: [],
      nextSteps: [{ title: "由 Agent 持續補充", detail: "若需要更多證據，回到來源 Session。", sourceSessionIds: [finalized.session.id] }],
      sourceSessionIds: [finalized.session.id],
      generatedByAgent: "codex",
      generatedByModel: "test-model",
      promptVersion: "report-synthesis-v1"
    });
    expect(saved).toMatchObject({
      outcome: "report_summary_saved",
      duplicate: false,
      summary: {
        isCurrent: true,
        requestId: created.request.id,
        themes: [{ title: "報告治理" }],
        verification: [{ title: "測試通過" }],
        comparison: [{ title: "相較上一期" }]
      }
    });
    if (saved.outcome !== "report_summary_saved") {
      throw new Error("Expected the first report summary to be saved");
    }
    expect(store.saveReportSummary({
      requestId: created.request.id,
      title: "Retry must be ignored",
      executiveSummary: "This retry must return the existing result.",
      highlights: [],
      risks: [],
      decisions: [],
      nextSteps: [],
      sourceSessionIds: [finalized.session.id],
      generatedByAgent: "claude",
      promptVersion: "report-synthesis-v2"
    })).toMatchObject({ outcome: "report_summary_saved", duplicate: true, summary: { title: "本週工作報告" } });
    expect(store.getReportSynthesisRequest(created.request.id)).toMatchObject({
      outcome: "report_synthesis_request_detail",
      request: { status: "completed" },
      summary: { title: "本週工作報告", sourceSessionIds: [finalized.session.id] }
    });
    const secondRequest = store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-17",
      projectId: project.id,
      idempotencyKey: "synthesis-request-002"
    });
    expect(secondRequest).toMatchObject({ outcome: "report_synthesis_request", duplicate: false });
    if (secondRequest.outcome !== "report_synthesis_request") {
      throw new Error("Expected a second synthesis request");
    }
    expect(store.getReportSynthesisContext({ requestId: secondRequest.request.id })).toMatchObject({ outcome: "report_context" });
    const secondSaved = store.saveReportSummary({
      requestId: secondRequest.request.id,
      title: "本週工作報告第二版",
      executiveSummary: "第二版補充了新的工作進度。",
      highlights: [{ title: "補充進度", detail: "保留相同來源 Session。", sourceSessionIds: [finalized.session.id] }],
      risks: [],
      decisions: [],
      nextSteps: [],
      sourceSessionIds: [finalized.session.id],
      generatedByAgent: "codex",
      promptVersion: "report-synthesis-v2"
    });
    expect(secondSaved).toMatchObject({ outcome: "report_summary_saved", duplicate: false, summary: { isCurrent: true } });
    if (secondSaved.outcome !== "report_summary_saved") {
      throw new Error("Expected the second report summary to be saved");
    }
    expect(store.listReportSummaries({ period: "week", date: "2026-09-17", projectId: project.id, currentOnly: false })).toMatchObject({
      outcome: "report_summaries",
      summaries: [expect.objectContaining({ id: secondSaved.summary.id }), expect.objectContaining({ id: saved.summary.id })]
    });
    expect(store.deleteReportSummary(saved.summary.id)).toMatchObject({
      outcome: "report_summary_deleted",
      summaryId: saved.summary.id,
      deleted: true
    });
    expect(store.deleteReportSummary(secondSaved.summary.id)).toMatchObject({
      outcome: "report_summary_delete_rejected",
      summaryId: secondSaved.summary.id
    });

    const cancellable = store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-17",
      projectId: project.id,
      idempotencyKey: "synthesis-request-cancel-001"
    });
    expect(cancellable).toMatchObject({ outcome: "report_synthesis_request", request: { status: "pending" } });
    if (cancellable.outcome !== "report_synthesis_request") {
      throw new Error("Expected a cancellable synthesis request");
    }
    expect(store.cancelReportSynthesisRequest(cancellable.request.id)).toMatchObject({
      outcome: "report_synthesis_request_cancelled",
      duplicate: false,
      request: { status: "cancelled" }
    });
    expect(store.cancelReportSynthesisRequest(cancellable.request.id)).toMatchObject({
      outcome: "report_synthesis_request_cancelled",
      duplicate: true
    });
    expect(store.getReportSynthesisContext({ requestId: cancellable.request.id })).toMatchObject({
      outcome: "report_synthesis_request_not_ready",
      request: { status: "cancelled" }
    });
    const interrupted = store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-17",
      projectId: project.id,
      idempotencyKey: "synthesis-request-interrupted-001"
    });
    expect(interrupted).toMatchObject({ outcome: "report_synthesis_request", request: { status: "pending" } });
    if (interrupted.outcome !== "report_synthesis_request") {
      throw new Error("Expected an interrupted synthesis request");
    }
    const interruptedContext = store.getReportSynthesisContext({ requestId: interrupted.request.id });
    expect(interruptedContext).toMatchObject({ outcome: "report_context", request: { status: "processing" } });
    const database = (store as unknown as { db: DatabaseSync }).db;
    database
      .prepare("UPDATE report_synthesis_requests SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), interrupted.request.id);
    expect(store.listReportSynthesisRequests({ requestId: interrupted.request.id })).toMatchObject({
      outcome: "report_synthesis_requests",
      requests: [{ status: "failed", failureReason: expect.stringContaining("30 分鐘") }]
    });

    const retried = store.retryReportSynthesisRequest(interrupted.request.id);
    expect(retried).toMatchObject({
      outcome: "report_synthesis_request_retried",
      previousRequestId: interrupted.request.id,
      request: { status: "pending", sourceSessionIds: [finalized.session.id] }
    });
    if (retried.outcome !== "report_synthesis_request_retried") {
      throw new Error("Expected a retry synthesis request");
    }
    expect(retried.request.id).not.toBe(interrupted.request.id);
    expect(store.getReportSynthesisRequest(interrupted.request.id)).toMatchObject({
      outcome: "report_synthesis_request_detail",
      request: { status: "cancelled" }
    });
    expect(store.saveReportSummary({
      requestId: interrupted.request.id,
      title: "Stale summary must be rejected",
      executiveSummary: "The interrupted attempt must not write after retry.",
      highlights: [],
      risks: [],
      decisions: [],
      nextSteps: [],
      sourceSessionIds: [finalized.session.id],
      generatedByAgent: "codex",
      promptVersion: "report-synthesis-v2"
    })).toMatchObject({ outcome: "report_summary_request_not_ready", status: "cancelled" });
    expect(store.getReportSynthesisContext({ requestId: retried.request.id })).toMatchObject({
      outcome: "report_context",
      request: { status: "processing" }
    });
    store.updateProject(project.id, { status: "paused" });
    expect(store.getReportSynthesisContext({ requestId: created.request.id })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });

  it("adds new session metadata columns when opening a legacy SQLite database", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-legacy-"));
    tempDirs.push(root);
    const databasePath = join(root, "legacy.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_ingested_at TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        external_session_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        commit_required INTEGER NOT NULL DEFAULT 0,
        commit_sha TEXT,
        git_branch TEXT,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT
      );
    `);
    legacyDatabase.prepare(
      `INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "legacy-project",
      "Legacy project",
      root,
      "tracked",
      "2026-09-17T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z"
    );
    legacyDatabase.prepare(
      `INSERT INTO sessions (
        id, project_id, idempotency_key, title, summary, status,
        completed_at, created_at, changed_files_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "legacy-session",
      "legacy-project",
      "legacy-key",
      "Legacy session",
      "Keep this historical summary unchanged.",
      "finalized",
      "2026-09-17T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z",
      JSON.stringify(["legacy/file.ts"])
    );
    legacyDatabase.close();

    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    expect(store.getSessionById("legacy-session")).toMatchObject({
      id: "legacy-session",
      summary: "Keep this historical summary unchanged.",
      executionStatus: "completed",
      changedFiles: ["legacy/file.ts"],
      changedFilesProvenance: []
    });
  });

  it("gates source reads and context by the same project policy", () => {
    const { store, root } = createStore();
    const project = store.addProject("Context project", root);
    const sourcePath = join(root, "notes.md");
    writeFileSync(sourcePath, "tracked source", "utf8");

    expect(store.readProjectSource(root, "notes.md")).toMatchObject({ outcome: "skipped" });
    expect(store.getContext(root)).toMatchObject({ outcome: "skipped", projectStatus: "unregistered" });

    store.updateProject(project.id, { status: "tracked" });
    expect(store.readProjectSource(root, "notes.md")).toBe("tracked source");
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "context-follow-up-001",
      title: "Context metadata follow-up",
      summary: "The Agent should see missing metadata when it asks for context."
    });
    expect(finalized).toMatchObject({ outcome: "finalized" });
    const context = store.getContext(root);
    expect(context).toMatchObject({
      outcome: "context",
      project: { status: "tracked" },
      metadataFollowUps: [
        expect.objectContaining({
          title: "Context metadata follow-up",
          gaps: ["changed_files", "verification"],
          changedFileChangesCount: 0
        })
      ]
    });
  });
});
