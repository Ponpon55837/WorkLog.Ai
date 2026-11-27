import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, KnowledgePageSection } from "../../packages/core/src/index.js";
import { KnowledgePageDeletionError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

const CUSTOM_PAGE = { slug: "hive-inspections", title: "Hive inspections", question: "How are hives inspected?" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-page-deletion-"));
  tempDirs.push(root);
  const projectRoot = join(root, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(join(root, "work-intelligence.sqlite"));
  stores.push(store);
  const project = store.addProject("Apiary", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  let finalized = 0;
  const finalize = () => {
    finalized += 1;
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `inspection-${finalized}`,
      title: `Inspection ${finalized}`,
      summary: `Inspection ${finalized} summary.`,
      workSummary: { outcomes: ["Frames checked."], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      completedAt: `2026-10-0${finalized}T09:00:00.000Z`,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, root, projectRoot, project, finalize };
}

function writtenCustomPage(fixture: ReturnType<typeof setup>) {
  const { store, projectRoot, project, finalize } = fixture;
  const sessionId = finalize();
  const sections: KnowledgePageSection[] = [
    { heading: "Frames", content: "Check brood frames first.", sourceSessionIds: [sessionId] },
  ];
  const requested = store.requestKnowledgePageUpdate({ projectRoot, ...CUSTOM_PAGE });
  if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected request");
  for (const version of [1, 2]) {
    const read = store.getKnowledgePageContext({ projectRoot, slug: CUSTOM_PAGE.slug });
    if (read.outcome !== "knowledge_page_context") throw new Error("Expected context");
    store.saveKnowledgePage({
      projectRoot,
      slug: CUSTOM_PAGE.slug,
      idempotencyKey: `save-${version}`,
      reviewToken: read.reviewToken,
      sections: version === 1 ? sections : [{ ...sections[0]!, content: "Check brood frames, then honey." }],
    });
  }
  store.requestKnowledgePageUpdate({ projectRoot, slug: CUSTOM_PAGE.slug });
  const pointer = attentionPage(store, project.id, requested.page.id);
  if (!pointer?.preference) throw new Error("Expected an attention pointer for the page");
  store.updateAttentionPreference({
    projectId: project.id,
    kind: "knowledge_page",
    sourceId: pointer.sourceId,
    sourceRevision: pointer.sourceRevision,
    expectedRevision: pointer.preference.revision,
    action: "hide",
  });
  return requested.page.id;
}

function attentionPage(store: WorkIntelligenceStore, projectId: string, pageId: string, view?: "suppressed") {
  const result = store.getAttention({ projectId, kind: "knowledge_page", view, pageSize: 50 });
  if (result.outcome !== "attention") throw new Error("Expected attention");
  return result.items.find((item: AttentionItem) => item.sourceId === pageId);
}

function slugs(store: WorkIntelligenceStore, projectRoot: string): string[] {
  const listed = store.listKnowledgePages({ projectRoot });
  if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
  return listed.items.map((page) => page.slug).sort();
}

function countRows(store: WorkIntelligenceStore, sql: string, ...parameters: string[]): number {
  const db = new DatabaseSync(store.databasePath, { readOnly: true });
  try {
    return (db.prepare(sql).get(...parameters) as { count: number }).count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("deleting a custom Knowledge page", () => {
  it("removes the page, its versions, its update request and its attention preference in one write", () => {
    const fixture = setup();
    const { store, projectRoot, project } = fixture;
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const pageId = writtenCustomPage(fixture);
    expect(attentionPage(store, project.id, pageId, "suppressed")).toBeDefined();
    const versions = store.listKnowledgePageVersions(pageId);
    expect(versions.outcome === "knowledge_page_versions" && versions.versionCount).toBe(2);
    const before = store.getChangeToken();

    const deleted = store.deleteKnowledgePage(pageId);

    expect(deleted).toMatchObject({
      outcome: "knowledge_page_deleted",
      pageId,
      projectId: project.id,
      slug: CUSTOM_PAGE.slug,
      deletedCounts: { knowledgePageVersions: 2, attentionPreferences: 1 },
    });
    expect(slugs(store, projectRoot)).toEqual(["architecture"]);
    expect(countRows(store, "SELECT COUNT(*) AS count FROM knowledge_page_versions WHERE page_id = ?", pageId)).toBe(0);
    expect(countRows(store, "SELECT COUNT(*) AS count FROM attention_preferences WHERE source_id = ?", pageId)).toBe(0);
    expect(store.getChangeToken()).not.toEqual(before);
    expect(store.listKnowledgePageVersions(pageId)).toMatchObject({ outcome: "not_found" });
    expect(attentionPage(store, project.id, pageId)).toBeUndefined();
    expect(attentionPage(store, project.id, pageId, "suppressed")).toBeUndefined();
    expect(store.getKnowledgePageContext({ projectRoot, slug: CUSTOM_PAGE.slug })).toMatchObject({
      outcome: "not_found",
    });
    const context = store.getContext(projectRoot, { task: "hive inspections brood frames" });
    expect(JSON.stringify(context)).not.toContain(CUSTOM_PAGE.slug);
    expect(JSON.stringify(context)).not.toContain(pageId);
  });

  it("keeps a content-free audit row with ids, time and counts only", () => {
    const fixture = setup();
    const pageId = writtenCustomPage(fixture);

    fixture.store.deleteKnowledgePage(pageId);

    const db = new DatabaseSync(fixture.store.databasePath, { readOnly: true });
    try {
      const audit = db.prepare("SELECT * FROM knowledge_page_deletion_audit").all() as Array<Record<string, unknown>>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ page_id: pageId, project_id: fixture.project.id });
      expect(JSON.parse(String(audit[0]!.deleted_counts_json))).toEqual({
        knowledgePageVersions: 2,
        attentionPreferences: 1,
      });
      expect(JSON.stringify(audit)).not.toContain(CUSTOM_PAGE.slug);
      expect(JSON.stringify(audit)).not.toContain("brood");
    } finally {
      db.close();
    }
  });

  it("refuses the default pages and an unknown page with typed errors, changing nothing", () => {
    const { store, projectRoot } = setup();
    for (const slug of ["architecture", "in-progress", "pitfalls"]) {
      const requested = store.requestKnowledgePageUpdate({ projectRoot, slug });
      if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected request");
      expect(() => store.deleteKnowledgePage(requested.page.id)).toThrow(
        expect.objectContaining({ name: "KnowledgePageDeletionError", code: "knowledge_page_default" }),
      );
    }
    expect(() => store.deleteKnowledgePage("no-such-page")).toThrow(KnowledgePageDeletionError);
    expect(() => store.deleteKnowledgePage("no-such-page")).toThrow(
      expect.objectContaining({ code: "knowledge_page_not_found" }),
    );
    expect(slugs(store, projectRoot)).toEqual(["architecture", "in-progress", "pitfalls"]);
    expect(countRows(store, "SELECT COUNT(*) AS count FROM knowledge_page_deletion_audit")).toBe(0);
  });

  it("skips a page whose project is not tracked", () => {
    const fixture = setup();
    const pageId = writtenCustomPage(fixture);
    fixture.store.updateProject(fixture.project.id, { status: "paused" });

    expect(fixture.store.deleteKnowledgePage(pageId)).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(countRows(fixture.store, "SELECT COUNT(*) AS count FROM knowledge_pages WHERE id = ?", pageId)).toBe(1);
  });

  it("frees the slug, so the same page can be requested again as a new, empty page", () => {
    const fixture = setup();
    const { store, projectRoot } = fixture;
    const pageId = writtenCustomPage(fixture);
    store.deleteKnowledgePage(pageId);

    const recreated = store.requestKnowledgePageUpdate({ projectRoot, ...CUSTOM_PAGE });

    expect(recreated).toMatchObject({
      outcome: "knowledge_page_update_requested",
      page: { slug: CUSTOM_PAGE.slug, version: 0, status: "empty", sections: [] },
    });
    expect(recreated.outcome === "knowledge_page_update_requested" && recreated.page.id).not.toBe(pageId);
  });
});

describe("importing an export made before the page was deleted", () => {
  it("reports the deleted page and its dependants instead of adding them back", () => {
    const fixture = setup();
    const { store, projectRoot, project } = fixture;
    const pageId = writtenCustomPage(fixture);
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    store.deleteKnowledgePage(pageId);

    for (const strategy of ["merge", "newer-wins"] as const) {
      const preview = store.previewProjectDataImport({ bundle, strategy });
      expect(preview.additions).toMatchObject({
        knowledge_pages: 0,
        knowledge_page_versions: 0,
        attention_preferences: 0,
      });
      expect(preview.conflicts).toMatchObject({
        knowledge_pages: 1,
        knowledge_page_versions: 2,
        attention_preferences: 1,
      });
      expect(preview.conflictGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "knowledge_pages", category: "deleted", count: 1, sampleIds: [pageId] }),
          expect.objectContaining({ table: "attention_preferences", category: "deleted", count: 1 }),
        ]),
      );
    }

    const imported = store.importProjectData({ bundle });

    expect(imported.outcome).toBe("project_data_imported");
    expect(slugs(store, projectRoot)).toEqual([]);
    expect(countRows(store, "SELECT COUNT(*) AS count FROM knowledge_page_versions WHERE page_id = ?", pageId)).toBe(0);
    expect(countRows(store, "SELECT COUNT(*) AS count FROM attention_preferences WHERE source_id = ?", pageId)).toBe(0);
  });

  it("still imports a page another computer created later under the same slug", () => {
    const fixture = setup();
    const { store, projectRoot, project } = fixture;
    const pageId = writtenCustomPage(fixture);
    store.deleteKnowledgePage(pageId);
    const other = new WorkIntelligenceStore(":memory:");
    stores.push(other);
    other.importProjectData({ bundle: store.exportProjectData({ type: "project", projectId: project.id }) });
    other.updateProject(project.id, { status: "tracked" });
    const otherRoot = other.listProjects().find((item) => item.id === project.id)?.rootPath;
    if (!otherRoot) throw new Error("Expected the project on the other store");
    const recreated = other.requestKnowledgePageUpdate({ projectRoot: otherRoot, ...CUSTOM_PAGE });
    if (recreated.outcome !== "knowledge_page_update_requested") throw new Error("Expected request");

    const preview = store.previewProjectDataImport({
      bundle: other.exportProjectData({ type: "project", projectId: project.id }),
    });

    expect(preview.additions).toMatchObject({ knowledge_pages: 1 });
    expect(preview.conflictGroups.filter((group) => group.category === "deleted")).toEqual([]);
    store.importProjectData({ bundle: other.exportProjectData({ type: "project", projectId: project.id }) });
    expect(slugs(store, projectRoot)).toEqual([CUSTOM_PAGE.slug]);
  });
});

describe("the empty custom page hint", () => {
  it("tells the Agent an emptied custom page can be deleted in the Web UI, but never on a default page", () => {
    const fixture = setup();
    const { store, projectRoot } = fixture;
    writtenCustomPage(fixture);
    const pending = store.getKnowledgePageContext({ projectRoot, slug: CUSTOM_PAGE.slug });
    expect(pending.outcome === "knowledge_page_context" && pending.emptyPageHint).toBeUndefined();
    const read = store.getKnowledgePageContext({ projectRoot, slug: CUSTOM_PAGE.slug });
    if (read.outcome !== "knowledge_page_context") throw new Error("Expected context");
    store.saveKnowledgePage({
      projectRoot,
      slug: CUSTOM_PAGE.slug,
      idempotencyKey: "save-empty",
      reviewToken: read.reviewToken,
      sections: [{ heading: "Frames", content: "資料不足", sourceSessionIds: [] }],
    });

    const emptied = store.getKnowledgePageContext({ projectRoot, slug: CUSTOM_PAGE.slug });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const pitfalls = store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" });
    if (pitfalls.outcome !== "knowledge_page_context") throw new Error("Expected context");
    const builtIn = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "save-empty-default",
      reviewToken: pitfalls.reviewToken,
      sections: [{ heading: "Known traps", content: "資料不足", sourceSessionIds: [] }],
    });
    const defaultRead = store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" });

    expect(emptied).toMatchObject({ outcome: "knowledge_page_context" });
    expect(emptied.outcome === "knowledge_page_context" && emptied.emptyPageHint).toContain("delete it in the Web UI");
    expect(builtIn.outcome).toBe("knowledge_page_saved");
    expect(defaultRead.outcome === "knowledge_page_context" && defaultRead.emptyPageHint).toBeUndefined();
  });
});
