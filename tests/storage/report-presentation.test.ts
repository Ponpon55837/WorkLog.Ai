import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emptyReportPresentation, projectReportSummary } from "../../packages/core/src/index.js";
import { projectDataExportSchema } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { ReportPresentationError } from "../../packages/storage/src/report-presentation-service.js";
import { applySchemaMigrations } from "../../packages/storage/src/schema-migrations.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";
import { seedReportPresentation } from "../helpers/report-presentation-fixture.js";

const resources: Array<{ root: string; store: WorkIntelligenceStore }> = [];
function fixture(global = false) {
  const root = mkdtempSync(join(tmpdir(), "wi-presentation-"));
  const store = new WorkIntelligenceStore(join(root, "fixture.sqlite"));
  resources.push({ root, store });
  return { root, store, ...seedReportPresentation(store, root, global) };
}
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
describe("report presentation revisions", () => {
  it("keeps original content and citations, pins in order, hides and restores, and rejects stale writers", () => {
    const { store, summary } = fixture();
    expect(store.getReportPresentation(summary.id)).toMatchObject({ revision: 0, state: emptyReportPresentation() });
    const state = {
      pinned: ["risks" as const],
      hidden: ["themes" as const],
      overrides: [{ section: "highlights" as const, ordinal: 0, title: "User title", detail: "User claim" }],
    };
    const first = store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 0, state });
    expect(first.revision).toBe(1);
    expect(() =>
      store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 0, state: emptyReportPresentation() }),
    ).toThrowError(ReportPresentationError);
    expect(store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 1, state }).revision).toBe(1);
    const projection = projectReportSummary(summary, first.state);
    expect(projection.map((s) => s.key)).toEqual(["risks", "highlights", "verification"]);
    expect(projection[1]!.blocks[0]).toMatchObject({
      title: "User title",
      edited: true,
      sourceSessionIds: summary.sourceSessionIds,
    });
    expect(summary.highlights[0]!.title).toBe("Fictional outcome");
    expect(
      store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 1, state: emptyReportPresentation() }),
    ).toMatchObject({ revision: 2, history: [{ revision: 2 }, { revision: 1 }] });
  });
  it("validates block identity, duplicate keys, arbitrary fields, limits and redacts credentials", () => {
    const { store, summary } = fixture();
    for (const state of [
      { pinned: ["decisions"], hidden: [], overrides: [] },
      { pinned: ["risks", "risks"], hidden: [], overrides: [] },
      { pinned: [], hidden: [], overrides: [{ section: "risks", ordinal: 1, title: "Invalid", detail: "Invalid" }] },
      {
        pinned: [],
        hidden: [],
        overrides: [
          { section: "risks", ordinal: 0, title: "Invalid", detail: "Invalid", sourceSessionIds: ["foreign"] },
        ],
      },
    ]) {
      expect(() =>
        store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 0, state: state as never }),
      ).toThrowError(ReportPresentationError);
    }
    const result = store.updateReportPresentation({
      summaryId: summary.id,
      expectedRevision: 0,
      state: {
        pinned: [],
        hidden: [],
        overrides: [{ section: "risks", ordinal: 0, title: "Manual", detail: `fixture sk-${"X".repeat(24)}` }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("X".repeat(24));
  });
  it("gates paused projects, voided sources and foreign/global citations for both reads and writes", () => {
    const { store, summary, sourceId, project } = fixture(true);
    store.updateProject(project.id, { status: "paused" });
    expect(() => store.getReportPresentation(summary.id)).toThrowError(ReportPresentationError);
    expect(() =>
      store.updateReportPresentation({ summaryId: summary.id, expectedRevision: 0, state: emptyReportPresentation() }),
    ).toThrowError(ReportPresentationError);
    store.updateProject(project.id, { status: "tracked" });
    store.setSessionVoid({ sessionId: sourceId, voided: true, reason: "Fictional invalidation" });
    expect(() => store.getReportPresentation(summary.id)).toThrowError(ReportPresentationError);
  });
  it("rejects foreign project sources and block references outside the base source list", () => {
    const { store, summary, root } = fixture();
    const foreignRoot = join(root, "foreign");
    mkdirSync(foreignRoot);
    const project = store.addProject("Foreign fictional project", foreignRoot);
    store.updateProject(project.id, { status: "tracked" });
    const source = store.finalizeSession({
      projectRoot: foreignRoot,
      idempotencyKey: "foreign-source",
      title: "Foreign source",
      summary: "Private foreign evidence",
      changedFiles: [],
    });
    if (source.outcome !== "finalized") throw new Error("Missing foreign source");
    const db = new DatabaseSync(store.databasePath);
    try {
      db.prepare("UPDATE report_summaries SET source_session_ids_json=? WHERE id=?").run(
        JSON.stringify([source.session.id]),
        summary.id,
      );
      expect(() => store.getReportPresentation(summary.id)).toThrowError(ReportPresentationError);
      db.prepare("UPDATE report_summaries SET source_session_ids_json=?,highlights_json=? WHERE id=?").run(
        JSON.stringify(summary.sourceSessionIds),
        JSON.stringify([{ ...summary.highlights[0], sourceSessionIds: [source.session.id] }]),
        summary.id,
      );
      expect(() => store.getReportPresentation(summary.id)).toThrowError(ReportPresentationError);
    } finally {
      db.close();
    }
  });
  it("round trips all revisions, accepts older bundles, and cascades permanent project deletion", () => {
    const { store, summary, project, root } = fixture();
    store.updateReportPresentation({
      summaryId: summary.id,
      expectedRevision: 0,
      state: { pinned: [], hidden: ["risks"], overrides: [] },
    });
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.report_presentations).toHaveLength(1);
    const destination = new WorkIntelligenceStore(join(root, "destination.sqlite"));
    resources.push({ store: destination, root: mkdtempSync(join(tmpdir(), "wi-cleanup-")) });
    destination.importProjectData({ bundle });
    destination.updateProject(project.id, { status: "tracked" });
    expect(destination.getReportPresentation(summary.id)).toMatchObject({ revision: 1, state: { hidden: ["risks"] } });
    const legacy = structuredClone(bundle);
    delete (legacy.tables as Partial<typeof legacy.tables>).report_presentations;
    expect(projectDataExportSchema.safeParse(legacy).success).toBe(true);
    store.deleteProject(project.id, project.name);
    const db = new DatabaseSync(store.databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM report_presentations").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
  it("keeps new base versions independent and cascades only a deleted old version", () => {
    const { store, summary, project } = fixture();
    store.updateReportPresentation({
      summaryId: summary.id,
      expectedRevision: 0,
      state: { pinned: ["risks"], hidden: [], overrides: [] },
    });
    const requested = store.createReportSynthesisRequest({
      period: "week",
      date: "2026-09-10",
      projectId: project.id,
      idempotencyKey: "second-base",
    });
    if (requested.outcome !== "report_synthesis_request") throw new Error("Missing second base request");
    store.getReportSynthesisContext({ requestId: requested.request.id });
    const saved = store.saveReportSummary({
      ...summary,
      requestId: requested.request.id,
      title: "Second fictional version",
      promptVersion: "fixture-v2",
    });
    if (saved.outcome !== "report_summary_saved") throw new Error("Missing second base");
    expect(saved.summary.id).not.toBe(summary.id);
    expect(store.getReportPresentation(saved.summary.id)).toMatchObject({
      revision: 0,
      state: emptyReportPresentation(),
    });
    expect(store.getReportPresentation(summary.id)).toMatchObject({ revision: 1, state: { pinned: ["risks"] } });
    expect(store.deleteReportSummary(summary.id)).toMatchObject({ outcome: "report_summary_deleted" });
    expect(() => store.getReportPresentation(summary.id)).toThrowError(ReportPresentationError);
    expect(store.getReportPresentation(saved.summary.id).revision).toBe(0);
    const db = new DatabaseSync(store.databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM report_presentations WHERE summary_id=?").get(summary.id)).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });
  it("upgrades schema 28 without changing the immutable base", () => {
    const { store, summary } = fixture();
    const db = new DatabaseSync(store.databasePath);
    try {
      undoMigrationsAfter(db, 28);
      applySchemaMigrations(db);
      expect(db.prepare("SELECT title FROM report_summaries WHERE id=?").get(summary.id)).toEqual({
        title: summary.title,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM report_presentations").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
