import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageSection } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(databasePath = ":memory:") {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-pages-"));
  tempDirs.push(root);
  const projectRoot = join(root, "apiary");
  const otherRoot = join(root, "orchard");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const store = new WorkIntelligenceStore(databasePath === ":memory:" ? databasePath : join(root, databasePath));
  stores.push(store);
  const project = store.addProject("Apiary", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const other = store.addProject("Orchard", otherRoot);
  store.updateProject(other.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  // Each write happens one minute after the previous one so "newer than" comparisons are strict.
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (key: string, rootPath = projectRoot) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: rootPath,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const sections = (sessionId: string, content = "Queen excluders go on first."): KnowledgePageSection[] => [
    { heading: "Hive layout", content, sourceSessionIds: [sessionId] },
    { heading: "Winter care", content: "資料不足", sourceSessionIds: [] },
  ];
  return { store, root, projectRoot, otherRoot, project, finalize, tick, sections };
}

describe("Knowledge pages", () => {
  it("creates a default page on request and asks for a title and question for a custom page", () => {
    const { store, projectRoot } = setup();
    const requested = store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    expect(requested).toMatchObject({
      outcome: "knowledge_page_update_requested",
      page: { slug: "architecture", title: "架構與慣例", version: 0, status: "empty" },
    });
    expect(requested.outcome === "knowledge_page_update_requested" && requested.page.updateRequestedAt).toBeTruthy();
    expect(store.requestKnowledgePageUpdate({ projectRoot, slug: "release-notes" })).toMatchObject({
      outcome: "invalid_page",
    });
    expect(
      store.requestKnowledgePageUpdate({
        projectRoot,
        slug: "release-notes",
        title: "發行紀錄",
        question: "每次發行包含哪些變更？",
      }),
    ).toMatchObject({ outcome: "knowledge_page_update_requested", page: { slug: "release-notes" } });
  });

  it("gives the Agent recent non-voided Sessions and saves a cited version idempotently", () => {
    const { store, projectRoot, otherRoot, finalize, sections } = setup();
    const first = finalize("first");
    const voided = finalize("voided");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });
    const foreign = finalize("foreign", otherRoot);
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });

    const context = store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" });
    expect(context.outcome).toBe("knowledge_page_context");
    if (context.outcome !== "knowledge_page_context") throw new Error("Expected context");
    expect(context.sessions.map((session) => session.id)).toEqual([first]);
    expect(context.instructions).toContain("資料不足");
    expect(store.getKnowledgePageContext({ projectRoot, slug: "missing" })).toMatchObject({ outcome: "not_found" });

    for (const invalid of [voided, foreign, "no-such-session"]) {
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "pitfalls",
          idempotencyKey: `bad-${invalid}`,
          sections: sections(invalid),
        }),
      ).toMatchObject({ outcome: "invalid_sources", sessionIds: [invalid] });
    }

    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "save-1",
      sections: sections(first),
    });
    expect(saved).toMatchObject({
      outcome: "knowledge_page_saved",
      duplicate: false,
      page: { version: 1, status: "fresh", lastAuthor: "agent", newSessionCount: 0 },
    });
    expect(saved.outcome === "knowledge_page_saved" && saved.page.updateRequestedAt).toBeFalsy();
    const retried = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "save-1",
      sections: sections(first),
    });
    expect(retried).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true, page: { version: 1 } });
  });

  it("marks each page stale from its own write time and counts only later non-voided Sessions", () => {
    const { store, projectRoot, finalize, sections } = setup();
    const source = finalize("source");
    for (const slug of ["architecture", "pitfalls"]) store.requestKnowledgePageUpdate({ projectRoot, slug });
    store.saveKnowledgePage({ projectRoot, slug: "architecture", idempotencyKey: "a-1", sections: sections(source) });
    finalize("between");
    store.saveKnowledgePage({ projectRoot, slug: "pitfalls", idempotencyKey: "p-1", sections: sections(source) });
    finalize("after");
    const voided = finalize("after-voided");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });

    const list = store.listKnowledgePages({ projectRoot });
    const bySlug = new Map(list.outcome === "knowledge_pages" ? list.items.map((page) => [page.slug, page]) : []);
    expect(bySlug.get("architecture")).toMatchObject({ status: "needs_update", newSessionCount: 2 });
    expect(bySlug.get("pitfalls")).toMatchObject({ status: "needs_update", newSessionCount: 1 });

    const context = store.getContext(projectRoot);
    expect(context.outcome === "context" && context.pendingRequests.knowledgePages).toEqual([
      { slug: "architecture", title: "架構與慣例", status: "needs_update", updateRequested: false },
      { slug: "pitfalls", title: "常見陷阱", status: "needs_update", updateRequested: false },
    ]);
    expect(context.outcome === "context" && context.knowledgePages.map((page) => page.slug)).toEqual([
      "architecture",
      "pitfalls",
    ]);
  });

  it("keeps manual Web edits as versions, redacts secrets, and bounds pages in the Agent context", () => {
    const { store, projectRoot, finalize, sections } = setup();
    const source = finalize("source");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: "a-1",
      sections: sections(source, `Deploy with ghp_${"B".repeat(36)} ${"x".repeat(3_000)}`),
    });
    expect(saved).toMatchObject({ outcome: "knowledge_page_saved", redactions: { total: 1 } });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected a saved page");
    expect(saved.page.sections[0]?.content).toContain("[REDACTED:github_token]");

    const edited = store.updateKnowledgePage({
      pageId: saved.page.id,
      title: "架構與慣例（人工修訂）",
      sections: [{ heading: "Hive layout", content: "Edited by hand.", sourceSessionIds: [source] }],
    });
    expect(edited).toMatchObject({ outcome: "knowledge_page_updated", page: { version: 2, lastAuthor: "web" } });

    const versions = store.listKnowledgePageVersions(saved.page.id);
    expect(
      versions.outcome === "knowledge_page_versions" &&
        versions.versions.map((version) => [version.version, version.author]),
    ).toEqual([
      [2, "web"],
      [1, "agent"],
    ]);

    const context = store.getContext(projectRoot);
    const digest = context.outcome === "context" ? context.knowledgePages[0] : undefined;
    expect(digest).toMatchObject({ slug: "architecture", status: "fresh", truncated: false });
    expect(digest?.content).toContain("Edited by hand.");
  });

  it("skips projects that are not tracked", () => {
    const { store, projectRoot, project } = setup();
    store.updateProject(project.id, { status: "paused" });
    expect(store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" })).toMatchObject({
      outcome: "skipped",
    });
    expect(store.listKnowledgePages({ projectRoot })).toMatchObject({ outcome: "skipped" });
  });

  it("travels with portable exports and is removed with its project", () => {
    const { store, projectRoot, project, finalize, sections, root } = setup("source.sqlite");
    const source = finalize("source");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    store.saveKnowledgePage({ projectRoot, slug: "architecture", idempotencyKey: "a-1", sections: sections(source) });

    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.knowledge_pages).toHaveLength(1);
    expect(bundle.tables.knowledge_page_versions).toHaveLength(1);
    const destination = new WorkIntelligenceStore(join(root, "destination.sqlite"));
    stores.push(destination);
    const imported = destination.importProjectData({ bundle, remap: [] });
    expect(imported.additions.knowledge_pages).toBe(1);
    expect(imported.additions.knowledge_page_versions).toBe(1);

    const deleted = store.deleteProject(project.id, "Apiary");
    expect(deleted.deletedCounts).toMatchObject({ knowledgePages: 1, knowledgePageVersions: 1 });
    expect(store.listKnowledgePages({})).toMatchObject({ outcome: "knowledge_pages", items: [] });
  });
});
