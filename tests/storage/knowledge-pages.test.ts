import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageContextSession, KnowledgePageSection } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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

function fullContext(result: ReturnType<WorkIntelligenceStore["getKnowledgePageContext"]>) {
  if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
    throw new Error(`Expected a default knowledge page context, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return { ...result, sessions: result.sessions as KnowledgePageContextSession[] };
}

function reviewTokenOf(store: WorkIntelligenceStore, projectRoot: string, slug: string): string {
  const result = store.getKnowledgePageContext({ projectRoot, slug });
  if (result.outcome !== "knowledge_page_context") throw new Error("Expected a knowledge page context");
  return result.reviewToken;
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

  it("explains a missed page lookup with the project's slugs, an id passed as slug, or the nearest slug", () => {
    const { store, projectRoot, otherRoot } = setup();
    const requested = store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected a page");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "hive-log", title: "蜂箱紀錄", question: "蜂箱狀態？" });
    const foreign = store.requestKnowledgePageUpdate({
      projectRoot: otherRoot,
      slug: "orchard-notes",
      title: "果園",
      question: "果園狀態？",
    });
    if (foreign.outcome !== "knowledge_page_update_requested") throw new Error("Expected a foreign page");
    const lookup = (slug: string) => store.getKnowledgePageContext({ projectRoot, slug });
    const listed = { existingSlugs: ["hive-log", "pitfalls"] };

    expect(lookup(requested.page.id)).toEqual({
      outcome: "not_found",
      slug: requested.page.id,
      reasonCode: "page_id_as_slug",
      reason: expect.stringContaining('slug "pitfalls"'),
      suggestedSlug: "pitfalls",
      ...listed,
    });
    expect(lookup(foreign.page.id)).toEqual({
      outcome: "not_found",
      slug: foreign.page.id,
      reasonCode: "slug_looks_like_id",
      reason: expect.any(String),
      ...listed,
    });
    expect(lookup("pitfall")).toMatchObject({ reasonCode: "slug_near_match", suggestedSlug: "pitfalls", ...listed });
    expect(lookup("hive-logs")).toMatchObject({ reasonCode: "slug_near_match", suggestedSlug: "hive-log" });
    expect(lookup("architectur")).toMatchObject({
      reasonCode: "slug_near_match",
      suggestedSlug: "architecture",
      reason: expect.stringContaining("work_request_knowledge_page_update"),
    });
    expect(lookup("architecture")).toMatchObject({
      reasonCode: "page_not_requested",
      reason: expect.stringContaining("work_request_knowledge_page_update"),
    });
    const unknown = lookup("orchard-notes");
    expect(unknown).toMatchObject({ reasonCode: "page_unknown", ...listed });
    expect(unknown).not.toHaveProperty("suggestedSlug");
    expect(JSON.stringify(unknown)).not.toContain(foreign.page.id);
  });

  it("bounds the slugs a missed page lookup lists", () => {
    const { store, projectRoot } = setup();
    for (let index = 0; index < 23; index += 1) {
      const slug = `page-${index.toString().padStart(2, "0")}`;
      store.requestKnowledgePageUpdate({ projectRoot, slug, title: `Page ${index}`, question: `Question ${index}?` });
    }
    const missed = store.getKnowledgePageContext({ projectRoot, slug: "unrelated-topic" });
    if (missed.outcome !== "not_found") throw new Error("Expected not_found");
    expect(missed.existingSlugs).toHaveLength(20);
    expect(missed.existingSlugs[0]).toBe("page-00");
    expect(missed.existingSlugsOmittedCount).toBe(3);
    expect(missed.reasonCode).toBe("page_unknown");
  });

  it("shortens context Session previews without splitting a surrogate pair", () => {
    const { store, projectRoot } = setup();
    // 98 ASCII characters, then an emoji whose two code units straddle the 99-unit cut before the ellipsis.
    const outcome = `${"a".repeat(98)}🐝 hive notes`;
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: "surrogate-preview",
      title: "Session surrogate preview",
      summary: "Synthetic emoji preview.",
      workSummary: { outcomes: [outcome], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const context = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" }));
    const [preview] = context.sessions[0]!.workSummary.outcomes;
    expect(preview).toBe(`${"a".repeat(98)}…`);
  });

  it("gives the Agent recent non-voided Sessions and saves a cited version idempotently", () => {
    const { store, projectRoot, otherRoot, finalize, sections } = setup();
    const first = finalize("first");
    const voided = finalize("voided");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });
    const foreign = finalize("foreign", otherRoot);
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });

    const context = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" }));
    expect(context.outcome).toBe("knowledge_page_context");
    expect(context.sessions.map((session) => session.id)).toEqual([first]);
    expect(context).toMatchObject({
      omittedSessionFields: ["summary", "workSummary.scope", "workSummary.verification"],
      sessionReadWith: "work_get_session",
    });
    expect(context).not.toHaveProperty("instructions");
    expect(context.sessions[0]).toEqual({
      id: first,
      title: expect.any(String),
      completedAt: expect.any(String),
      workSummary: { outcomes: ["first outcome"], decisions: [], nextSteps: [] },
    });
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
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
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

  it("bounds each context Session to its first outcomes, decisions and open items within the Session budget", () => {
    const { store, projectRoot, tick } = setup();
    const long = (label: string, index: number) => `${label} ${index}: ${"fictional hive detail ".repeat(12)}`;
    const ids: string[] = [];
    for (let index = 0; index < 60; index++) {
      tick();
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `bounded-${index}`,
        title: `Bounded Session ${index}`,
        summary: "A summary the page context leaves to work_get_session.",
        workSummary: {
          outcomes: [long("Outcome", 1), long("Outcome", 2), long("Outcome", 3)],
          scope: [long("Scope", 1)],
          decisions: ["Short decision.", long("Decision", 2), long("Decision", 3)],
          verification: [long("Verification", 1)],
          nextSteps: [long("Open item", 1)],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") throw new Error("Expected finalize");
      ids.push(result.session.id);
    }
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });

    const context = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
    expect(context.mode).toBe("full");
    expect(context.sessions.length).toBeGreaterThan(8);
    expect(context.sessions.length).toBeLessThan(60);
    expect(context.truncated).toBe(true);
    expect(context.sessions.map((session) => session.id)).toEqual(ids.reverse().slice(0, context.sessions.length));
    expect(JSON.stringify(context.sessions).length).toBeLessThanOrEqual(12_000);
    for (const session of context.sessions) {
      expect(session.truncated).toBe(true);
      expect(Object.keys(session.workSummary).sort()).toEqual(["decisions", "nextSteps", "outcomes"]);
      expect(session.workSummary.outcomes).toHaveLength(2);
      expect(session.workSummary.decisions[0]).toBe("Short decision.");
      for (const item of [...session.workSummary.outcomes, ...session.workSummary.nextSteps]) {
        expect(item.length).toBeLessThanOrEqual(100);
        expect(item.endsWith("…")).toBe(true);
      }
      expect(session).not.toHaveProperty("summary");
    }
  });

  it("marks later non-voided Sessions as new data from each page's own write time", () => {
    const { store, projectRoot, finalize, sections } = setup();
    const source = finalize("source");
    for (const slug of ["architecture", "pitfalls"]) store.requestKnowledgePageUpdate({ projectRoot, slug });
    store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: "a-1",
      sections: sections(source),
      reviewToken: reviewTokenOf(store, projectRoot, "architecture"),
    });
    finalize("between");
    store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "p-1",
      sections: sections(source),
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });
    finalize("after");
    const voided = finalize("after-voided");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });

    const list = store.listKnowledgePages({ projectRoot });
    const bySlug = new Map(list.outcome === "knowledge_pages" ? list.items.map((page) => [page.slug, page]) : []);
    expect(bySlug.get("architecture")).toMatchObject({ status: "has_new_data", newSessionCount: 2 });
    expect(bySlug.get("pitfalls")).toMatchObject({ status: "has_new_data", newSessionCount: 1 });

    const context = store.getContext(projectRoot);
    expect(context.outcome === "context" && context.pendingRequests.knowledgePages).toEqual([]);
    expect(context.outcome === "context" && context.knowledgePages.map((page) => page.slug)).toEqual([
      "architecture",
      "pitfalls",
    ]);
  });

  it("prompts after three new Sessions and orders source review before requests and new data", () => {
    const { store, projectRoot, finalize, tick, sections } = setup();
    const source = finalize("maintenance-source");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "maintenance-pitfalls",
      sections: sections(source),
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });

    const finalizeWithResult = (key: string) => {
      tick();
      return store.finalizeSession({
        projectRoot,
        idempotencyKey: key,
        title: `Session ${key}`,
        summary: `${key} summary.`,
        workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
      });
    };

    expect(finalizeWithResult("maintenance-new-1")).not.toHaveProperty("knowledgePageMaintenanceHint");
    expect(finalizeWithResult("maintenance-new-2")).not.toHaveProperty("knowledgePageMaintenanceHint");
    const third = finalizeWithResult("maintenance-new-3");
    expect(third).toMatchObject({
      outcome: "finalized",
      knowledgePageMaintenanceHint: expect.stringContaining("常見陷阱（3 筆新 Session）"),
    });
    expect(store.getContext(projectRoot)).toMatchObject({
      pendingRequests: {
        knowledgePages: [{ slug: "pitfalls", newSessionCount: 3, updateRequested: false }],
      },
    });

    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: "maintenance-architecture",
      sections: sections(third.outcome === "finalized" ? third.session.id : ""),
      reviewToken: reviewTokenOf(store, projectRoot, "architecture"),
    });
    expect(saved).toMatchObject({ outcome: "knowledge_page_saved", page: { newSessionCount: 0 } });
    if (third.outcome !== "finalized") throw new Error("Expected the third Session to finalize.");

    tick();
    store.setSessionVoid({ sessionId: third.session.id, voided: true, reason: "Review reminder fixture." });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "in-progress" });
    expect(store.getContext(projectRoot)).toMatchObject({
      pendingRequests: {
        knowledgePages: [
          { slug: "architecture", needsReview: true, newSessionCount: 0 },
          { slug: "in-progress", updateRequested: true, newSessionCount: 0 },
        ],
      },
    });
    const fourth = finalizeWithResult("maintenance-new-4");
    expect(fourth).toMatchObject({ outcome: "finalized" });
    if (fourth.outcome !== "finalized") throw new Error("Expected the fourth Session to finalize.");

    const hint = fourth.knowledgePageMaintenanceHint ?? "";
    expect(hint.indexOf("架構與慣例（來源需要核對）")).toBeLessThan(
      hint.indexOf("進行中的工作與未結項（已有更新請求）"),
    );
    expect(hint.indexOf("進行中的工作與未結項（已有更新請求）")).toBeLessThan(
      hint.indexOf("常見陷阱（3 筆新 Session）"),
    );
    expect(store.getContext(projectRoot)).toMatchObject({
      pendingRequests: {
        knowledgePages: [
          { slug: "architecture", needsReview: true, newSessionCount: 1 },
          { slug: "in-progress", updateRequested: true, newSessionCount: 0 },
          { slug: "pitfalls", newSessionCount: 3 },
        ],
      },
    });
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

  it("keeps cited-source review warnings through void and restore until a new page version is saved", () => {
    const { store, projectRoot, finalize, tick } = setup();
    const cited = finalize("cited-source");
    const uncited = finalize("uncited-source");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "source-lifecycle-save",
      sections: [
        { heading: "Cited rule", content: "Keep the cited rule current.", sourceSessionIds: [cited] },
        { heading: "Unrelated", content: "資料不足", sourceSessionIds: [] },
      ],
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");

    tick();
    store.updateSessionSummary({
      sessionId: uncited,
      idempotencyKey: "uncited-session-correction",
      summary: "An unrelated Session changed after the page was saved.",
    });
    expect(store.listKnowledgePages({ projectRoot })).toMatchObject({
      outcome: "knowledge_pages",
      items: [expect.objectContaining({ slug: "pitfalls", status: "fresh" })],
    });
    const unchanged = store.listKnowledgePages({ projectRoot });
    expect(unchanged.outcome === "knowledge_pages" && unchanged.items[0]).not.toHaveProperty("needsReview");

    tick();
    store.setSessionVoid({ sessionId: cited, voided: true, reason: "Fixture source review." });
    let page = store.listKnowledgePages({ projectRoot });
    expect(page).toMatchObject({
      outcome: "knowledge_pages",
      items: [
        expect.objectContaining({
          slug: "pitfalls",
          needsReview: true,
          reviewSections: [
            {
              heading: "Cited rule",
              sources: [
                expect.objectContaining({
                  sourceSessionId: cited,
                  reasons: ["source_updated_after_save", "source_voided_after_save"],
                }),
              ],
            },
          ],
        }),
      ],
    });

    tick();
    store.setSessionVoid({ sessionId: cited, voided: false });
    page = store.listKnowledgePages({ projectRoot });
    expect(page).toMatchObject({
      outcome: "knowledge_pages",
      items: [
        expect.objectContaining({
          needsReview: true,
          reviewSections: [
            {
              heading: "Cited rule",
              sources: [
                expect.objectContaining({
                  sourceSessionId: cited,
                  reasons: ["source_updated_after_save", "source_voided_after_save", "source_restored_after_save"],
                }),
              ],
            },
          ],
        }),
      ],
    });
    const context = store.getContext(projectRoot);
    expect(context.outcome === "context" && context.pendingRequests.knowledgePages).toContainEqual(
      expect.objectContaining({ slug: "pitfalls", needsReview: true }),
    );

    tick();
    const updated = store.updateKnowledgePage({
      pageId: saved.page.id,
      sections: [
        { heading: "Cited rule", content: "Rechecked and retained the cited rule.", sourceSessionIds: [cited] },
        { heading: "Unrelated", content: "資料不足", sourceSessionIds: [] },
      ],
    });
    expect(updated).toMatchObject({ outcome: "knowledge_page_updated", page: { version: 2 } });
    expect(updated.outcome === "knowledge_page_updated" && updated.page).not.toHaveProperty("needsReview");
  });

  it("checks irrelevant Sessions without changing page versions or clearing a C1 source warning", () => {
    const { store, projectRoot, otherRoot, finalize, sections, tick } = setup();
    const cited = finalize("checked-cited-source");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "checked-page-save",
      sections: sections(cited),
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");

    const afterSave = finalize("unrelated-after-save");
    expect(store.listKnowledgePages({ projectRoot })).toMatchObject({
      outcome: "knowledge_pages",
      items: [expect.objectContaining({ slug: "pitfalls", status: "has_new_data", newSessionCount: 1 })],
    });

    tick();
    store.updateSessionSummary({
      sessionId: cited,
      idempotencyKey: "checked-source-correction",
      summary: "The cited source has changed and requires a page check.",
    });
    const beforeCheck = store.listKnowledgePages({ projectRoot });
    if (beforeCheck.outcome !== "knowledge_pages") throw new Error("Expected the page list.");
    const original = beforeCheck.items.find((page) => page.slug === "pitfalls");
    if (!original) throw new Error("Expected the saved page.");
    expect(original.needsReview).toBe(true);

    const checked = store.markKnowledgePageChecked({
      projectRoot,
      slug: "pitfalls",
      throughSessionId: afterSave,
    });
    expect(checked).toMatchObject({
      outcome: "knowledge_page_checked",
      page: {
        version: 1,
        status: "fresh",
        newSessionCount: 0,
        checkedThrough: { sessionId: afterSave },
        needsReview: true,
      },
    });
    if (checked.outcome !== "knowledge_page_checked") throw new Error("Expected the page check to be saved.");
    expect(checked.page.updatedAt).toBe(original.updatedAt);
    expect(store.listKnowledgePageVersions(checked.page.id)).toMatchObject({
      outcome: "knowledge_page_versions",
      versions: [{ version: 1 }],
    });
    expect(store.markKnowledgePageChecked({ projectRoot, slug: "pitfalls", throughSessionId: cited })).toMatchObject({
      outcome: "invalid_cursor",
    });
    expect(
      store.markKnowledgePageChecked({
        projectRoot,
        slug: "pitfalls",
        throughSessionId: finalize("foreign-cursor", otherRoot),
      }),
    ).toMatchObject({ outcome: "invalid_cursor" });

    const later = finalize("later-after-check");
    expect(store.markKnowledgePageChecked({ projectRoot, slug: "pitfalls", throughSessionId: later })).toMatchObject({
      outcome: "knowledge_page_checked",
      page: { version: 1, status: "fresh", newSessionCount: 0, needsReview: true },
    });
    const finalVersions = store.listKnowledgePageVersions(checked.page.id);
    expect(finalVersions.outcome === "knowledge_page_versions" && finalVersions.versions).toHaveLength(1);
  });

  it("reviews a written page with only its new Sessions and changed sources, oldest first", () => {
    const { store, projectRoot, finalize, sections, tick } = setup();
    const cited = finalize("review-cited");
    const older = finalize("review-older-than-page");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const full = store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" });
    expect(full).toMatchObject({ outcome: "knowledge_page_context", mode: "full" });
    tick();
    store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "review-save",
      sections: sections(cited),
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });

    const firstNew = finalize("review-first-new");
    const secondNew = finalize("review-second-new");
    tick();
    store.updateSessionSummary({
      sessionId: cited,
      idempotencyKey: "review-source-correction",
      summary: "The cited source was corrected after the page was saved.",
    });

    const review = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" }));
    expect(review.outcome).toBe("knowledge_page_context");
    expect(review.mode).toBe("review");
    expect(review.sessions.map((session) => [session.id, session.reasons])).toEqual([
      [cited, ["source_changed"]],
      [firstNew, ["new"]],
      [secondNew, ["new"]],
    ]);
    expect(review.sessions.some((session) => session.id === older)).toBe(false);

    store.markKnowledgePageChecked({ projectRoot, slug: "pitfalls", throughSessionId: firstNew });
    const afterCheck = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" }));
    expect(afterCheck.sessions.map((session) => session.id)).toEqual([cited, secondNew]);
  });

  it("does not count the Session that maintained a page as that page's new data", () => {
    const { store, projectRoot, finalize, sections, tick } = setup();
    const cited = finalize("maintained-cited");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    tick();
    for (const slug of ["architecture", "pitfalls"]) {
      store.saveKnowledgePage({
        projectRoot,
        slug,
        idempotencyKey: `maintained-save-${slug}`,
        sections: sections(cited),
        reviewToken: reviewTokenOf(store, projectRoot, slug),
      });
    }
    const finalizeMaintaining = (key: string, maintainedKnowledgePages: string[]) => {
      tick();
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: key,
        title: `Session ${key}`,
        summary: `${key} summary.`,
        workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        maintainedKnowledgePages,
      });
      if (result.outcome !== "finalized") throw new Error("Expected finalize");
      return result;
    };

    const maintaining = finalizeMaintaining("maintained-update-pages", ["architecture", "pitfalls", "missing"]);
    expect(maintaining.knowledgePagesAcknowledged).toEqual(["architecture", "pitfalls"]);
    const unrelated = finalize("maintained-unrelated-pr");
    const listed = store.listKnowledgePages({ projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
    for (const page of listed.items) {
      expect(page).toMatchObject({ status: "has_new_data", newSessionCount: 1 });
      expect(page.needsReview).toBeFalsy();
    }

    const late = finalizeMaintaining("maintained-late", ["architecture"]);
    expect(late.knowledgePagesAcknowledged).toBeUndefined();
    const context = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
    expect(context.sessions.map((session) => session.id)).toEqual([unrelated, late.session.id]);
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
    expect(
      store.markKnowledgePageChecked({ projectRoot, slug: "architecture", throughSessionId: source }),
    ).toMatchObject({ outcome: "knowledge_page_checked" });

    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.knowledge_pages).toHaveLength(1);
    expect(bundle.tables.knowledge_page_versions).toHaveLength(1);
    const destination = new WorkIntelligenceStore(join(root, "destination.sqlite"));
    stores.push(destination);
    const imported = destination.importProjectData({ bundle, remap: [] });
    expect(imported.additions.knowledge_pages).toBe(1);
    expect(imported.additions.knowledge_page_versions).toBe(1);
    const importedBundle = destination.exportProjectData({ type: "project", projectId: project.id });
    expect(importedBundle.tables.knowledge_pages).toContainEqual(
      expect.objectContaining({ checked_through_session_id: source }),
    );

    const deleted = store.deleteProject(project.id, "Apiary");
    expect(deleted.deletedCounts).toMatchObject({ knowledgePages: 1, knowledgePageVersions: 1 });
    expect(store.listKnowledgePages({})).toMatchObject({ outcome: "knowledge_pages", items: [] });
  });
  describe("focused reads", () => {
    function writtenPage() {
      const ctx = setup();
      const a = ctx.finalize("a");
      const b = ctx.finalize("b");
      ctx.store.requestKnowledgePageUpdate({ projectRoot: ctx.projectRoot, slug: "architecture" });
      ctx.store.saveKnowledgePage({
        projectRoot: ctx.projectRoot,
        slug: "architecture",
        idempotencyKey: "focused-v1",
        sections: [
          { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [a] },
          {
            heading: "Winter care",
            content: "Insulate the lid before frost; check the mite-sweep rota.",
            sourceSessionIds: [b, a],
          },
          { heading: "winter care", content: "Second winter note about wrapping.", sourceSessionIds: [a] },
          { heading: "蜂箱管理", content: "每週檢查一次蜂王狀態。", sourceSessionIds: [b] },
        ],
        reviewToken: reviewTokenOf(ctx.store, ctx.projectRoot, "architecture"),
      });
      ctx.finalize("c");
      return ctx;
    }

    it("returns the default read unchanged when neither query nor headings is given", () => {
      const { store, projectRoot } = writtenPage();
      const plain = store.getKnowledgePageContext({ projectRoot, slug: "architecture" });
      expect(plain).toMatchObject({ outcome: "knowledge_page_context", mode: "review" });
      expect(plain).not.toHaveProperty("focused");
      expect(plain).not.toHaveProperty("otherSections");
      expect(Object.keys(plain)).toEqual([
        "outcome",
        "page",
        "mode",
        "sessions",
        "omittedSessionFields",
        "sessionReadWith",
        "truncated",
        "reviewToken",
      ]);
      expect(JSON.stringify(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }))).toBe(
        JSON.stringify(plain),
      );
    });

    it("returns only the sections matching a query, in page order, without Sessions or review detail", () => {
      const { store, projectRoot } = writtenPage();
      const result = store.getKnowledgePageContext({ projectRoot, slug: "architecture", query: "mite sweep frost" });
      expect(result).toMatchObject({
        outcome: "knowledge_page_context",
        focused: true,
        match: "sections",
        sessionsOmitted: true,
        page: { slug: "architecture", version: 1, status: "has_new_data", newSessionCount: 1 },
      });
      if (!("focused" in result)) throw new Error("Expected a focused read");
      expect(result.sections.map((section) => section.heading)).toEqual(["Winter care"]);
      expect(result.sections[0]!.content).toContain("Insulate");
      expect(result.sections[0]!.sourceSessionIds).toHaveLength(2);
      expect(result.otherSections).toEqual([
        { heading: "Hive layout", chars: "Queen excluders go on first.".length },
        { heading: "winter care", chars: "Second winter note about wrapping.".length },
        { heading: "蜂箱管理", chars: "每週檢查一次蜂王狀態。".length },
      ]);
      expect(result).not.toHaveProperty("sessions");
      expect(result.page).not.toHaveProperty("sections");
      expect(result.page).not.toHaveProperty("reviewSections");
    });

    it("matches CJK query terms and returns every section sharing a heading by headings", () => {
      const { store, projectRoot } = writtenPage();
      const cjk = store.getKnowledgePageContext({ projectRoot, slug: "architecture", query: "蜂王" });
      if (!("focused" in cjk)) throw new Error("Expected a focused read");
      expect(cjk.sections.map((section) => section.heading)).toEqual(["蜂箱管理"]);

      const byHeading = store.getKnowledgePageContext({
        projectRoot,
        slug: "architecture",
        headings: ["  WINTER CARE ", "no such heading"],
      });
      if (!("focused" in byHeading)) throw new Error("Expected a focused read");
      expect(byHeading.match).toBe("sections");
      expect(byHeading.sections.map((section) => section.heading)).toEqual(["Winter care", "winter care"]);
      expect(byHeading.otherSections.map((section) => section.heading)).toEqual(["Hive layout", "蜂箱管理"]);
    });

    it("ranks sections by distinct matched query terms and keeps only the best half, not every shared term", () => {
      const { store, projectRoot, finalize } = setup();
      const source = finalize("rank");
      store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
      store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "rank-v1",
        sections: [
          { heading: "Intro", content: "The ledger is described here.", sourceSessionIds: [source] },
          { heading: "Audit", content: "The ledger audit runs weekly.", sourceSessionIds: [source] },
          { heading: "Rotation", content: "Ledger rotation window schedule: nightly.", sourceSessionIds: [source] },
          { heading: "簽章", content: "簽章流程由維護者負責。", sourceSessionIds: [source] },
          { heading: "排程", content: "排程每晚執行。", sourceSessionIds: [source] },
          { heading: "輪替", content: "簽章輪替排程在每晚執行。", sourceSessionIds: [source] },
          {
            heading: "Rights",
            content: "Granted rights stay with the owners of the ts config.",
            sourceSessionIds: [source],
          },
        ],
      });
      const names = (input: { query?: string; headings?: string[] }) => {
        const result = store.getKnowledgePageContext({ projectRoot, slug: "architecture", ...input });
        if (!("focused" in result)) throw new Error("Expected a focused read");
        return result.sections.map((section) => section.heading);
      };
      expect(names({ query: "ledger rotation window schedule" })).toEqual(["Rotation"]);
      expect(names({ query: "簽章輪替排程" })).toEqual(["輪替"]);
      // A short Latin term matches whole tokens only: "ts" is a token of Rights' content; "gh" is inside "rights".
      expect(names({ query: "ts" })).toEqual(["Rights"]);
      expect(names({ query: "gh" })).toEqual([]);
      expect(names({ query: "rotat" })).toEqual(["Rotation"]);
      expect(names({ query: "ledger rotation window schedule", headings: ["intro"] })).toEqual(["Intro", "Rotation"]);
    });

    it("reports match none with every section listed when nothing matches", () => {
      const { store, projectRoot } = writtenPage();
      for (const input of [{ query: "zeppelin" }, { query: "the of" }, { headings: ["Missing"] }]) {
        const result = store.getKnowledgePageContext({ projectRoot, slug: "architecture", ...input });
        if (!("focused" in result)) throw new Error("Expected a focused read");
        expect(result.match).toBe("none");
        expect(result.sections).toEqual([]);
        expect(result.otherSections).toHaveLength(4);
      }
    });

    it("flags matched sections that need a source review and keeps not_found and skipped results", () => {
      const { store, projectRoot, tick } = writtenPage();
      const page = store.getKnowledgePageContext({ projectRoot, slug: "architecture" });
      if (page.outcome !== "knowledge_page_context" || "focused" in page || "reviewOnly" in page)
        throw new Error("Expected a page");
      const sourceId = page.page.sections[1]!.sourceSessionIds[0]!;
      tick();
      store.setSessionVoid({ sessionId: sourceId, voided: true, reason: "Fixture source review." });
      const focused = store.getKnowledgePageContext({ projectRoot, slug: "architecture", headings: ["Winter care"] });
      if (!("focused" in focused)) throw new Error("Expected a focused read");
      expect(focused.page.needsReview).toBe(true);
      expect(focused.sections[0]!.needsReview).toBe(true);
      expect(store.getKnowledgePageContext({ projectRoot, slug: "missing", query: "x" })).toMatchObject({
        outcome: "not_found",
      });
    });
  });

  describe("review token: coverage and version checks", () => {
    function tokenPage() {
      const context = setup();
      const { store, projectRoot, finalize, tick, sections } = context;
      store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
      const first = finalize("token-first");
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      tick();
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "token-initial",
        sections: sections(first),
        reviewToken: read.reviewToken,
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
      expect(saved).not.toHaveProperty("warnings");
      return { ...context, first };
    }
    const pageOf = (store: WorkIntelligenceStore, projectRoot: string) => {
      const listed = store.listKnowledgePages({ projectRoot });
      if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
      return listed.items.find((page) => page.slug === "architecture")!;
    };

    it("keeps a Session that finished after the read new instead of marking it covered", () => {
      const { store, projectRoot, finalize, tick, sections, first } = tokenPage();
      const reviewed = finalize("token-reviewed");
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(read.sessions.map((session) => session.id)).toEqual([reviewed]);
      const late = finalize("token-late");
      tick();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "token-review-save",
          sections: sections(first, "Reviewed."),
          reviewToken: read.reviewToken,
        }),
      ).toMatchObject({ outcome: "knowledge_page_saved", page: { status: "has_new_data", newSessionCount: 1 } });
      const next = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(next.sessions.map((session) => [session.id, session.reasons])).toEqual([[late, ["new"]]]);
    });

    it("leaves Sessions a truncated read did not show for the next review, in order", () => {
      const { store, projectRoot, finalize, tick, sections, first } = tokenPage();
      const pending = Array.from({ length: 62 }, (_, index) => finalize(`token-bulk-${index}`));
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(read.truncated).toBe(true);
      const shown = read.sessions.map((session) => session.id);
      expect(shown).toEqual(pending.slice(0, shown.length));
      tick();
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "token-truncated-save",
        sections: sections(first, "First batch reviewed."),
        reviewToken: read.reviewToken,
      });
      expect(saved).toMatchObject({ page: { newSessionCount: pending.length - shown.length } });
      const next = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(next.sessions[0]?.id).toBe(pending[shown.length]);
    });

    it("covers only the Sessions a full rewrite was shown", () => {
      const { store, projectRoot, finalize, tick, sections } = setup();
      store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
      const shown = finalize("full-shown");
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(read.mode).toBe("full");
      const late = finalize("full-late");
      tick();
      store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "full-save",
        sections: sections(shown),
        reviewToken: read.reviewToken,
      });
      expect(pageOf(store, projectRoot)).toMatchObject({ newSessionCount: 1, version: 1 });
      expect(
        fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" })).sessions.map(
          (session) => session.id,
        ),
      ).toEqual([late]);
    });

    it("refuses a save from a read older than the current version and keeps the newer one", () => {
      const { store, projectRoot, tick, sections, first } = tokenPage();
      const left = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      const right = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      tick();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "token-left",
          sections: sections(first, "Left wins."),
          reviewToken: left.reviewToken,
        }),
      ).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 2 } });
      tick();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "token-right",
          sections: sections(first, "Right loses."),
          reviewToken: right.reviewToken,
        }),
      ).toEqual({
        outcome: "version_conflict",
        reason: expect.any(String),
        baseVersion: 1,
        currentVersion: 2,
        reviewToken: expect.stringMatching(/^kpr1\./),
        changedHeadings: ["Hive layout"],
      });
      expect(pageOf(store, projectRoot)).toMatchObject({ version: 2, sections: [{ content: "Left wins." }, {}] });
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "token-left",
          sections: sections(first, "Left wins."),
          reviewToken: left.reviewToken,
        }),
      ).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true, page: { version: 2 } });
    });

    it("refuses a Web edit started from an older version, and an Agent save after a Web edit", () => {
      const { store, projectRoot, tick, sections, first } = tokenPage();
      const page = pageOf(store, projectRoot);
      const agentRead = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      tick();
      expect(
        store.updateKnowledgePage({ pageId: page.id, sections: sections(first, "Web edit."), baseVersion: 1 }),
      ).toMatchObject({ outcome: "knowledge_page_updated", page: { version: 2 } });
      expect(
        store.updateKnowledgePage({ pageId: page.id, sections: sections(first, "Stale tab."), baseVersion: 1 }),
      ).toMatchObject({ outcome: "version_conflict", baseVersion: 1, currentVersion: 2 });
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "token-after-web",
          sections: sections(first, "Agent overwrite."),
          reviewToken: agentRead.reviewToken,
        }),
      ).toMatchObject({ outcome: "version_conflict", baseVersion: 1, currentVersion: 2 });
      expect(pageOf(store, projectRoot).sections[0]?.content).toBe("Web edit.");
      expect(store.updateKnowledgePage({ pageId: page.id, sections: sections(first, "Unchecked.") })).toMatchObject({
        outcome: "knowledge_page_updated",
        page: { version: 3 },
      });
    });

    it("rejects a token that is malformed or belongs to another page, writing nothing", () => {
      const { store, projectRoot, sections, first } = tokenPage();
      store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
      const otherToken = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls" })).reviewToken;
      for (const reviewToken of [
        "not-a-token",
        "kpr1.%%%",
        "kpr1." + Buffer.from("[]").toString("base64url"),
        otherToken,
      ]) {
        expect(
          store.saveKnowledgePage({
            projectRoot,
            slug: "architecture",
            idempotencyKey: `token-invalid-${reviewToken.length}`,
            sections: sections(first, "Never saved."),
            reviewToken,
          }),
        ).toEqual({ outcome: "invalid_review_token", reason: expect.any(String) });
      }
      expect(pageOf(store, projectRoot).version).toBe(1);
    });

    it("keeps the reviewed point and warns when the save has no token", () => {
      const { store, projectRoot, finalize, tick, sections, first } = tokenPage();
      const unseen = finalize("legacy-unseen");
      tick();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "legacy-save",
          sections: sections(first, "Legacy."),
        }),
      ).toMatchObject({
        outcome: "knowledge_page_saved",
        warnings: [expect.stringContaining("no check for a newer page version")],
        page: { version: 2, newSessionCount: 1, status: "has_new_data" },
      });
      expect(
        fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" })).sessions.map(
          (session) => session.id,
        ),
      ).toEqual([unseen]);
    });

    it("acknowledges the maintaining Session only when no unseen Session comes before it", () => {
      const { store, projectRoot, finalize, tick, sections, first } = tokenPage();
      const finalizeMaintaining = (key: string) => {
        tick();
        const result = store.finalizeSession({
          projectRoot,
          idempotencyKey: key,
          title: `Session ${key}`,
          summary: `${key} summary.`,
          workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
          changedFiles: [],
          verification: { status: "passed" },
          maintainedKnowledgePages: ["architecture"],
        });
        if (result.outcome !== "finalized") throw new Error("Expected finalize");
        return result;
      };
      expect(finalizeMaintaining("token-maintained").knowledgePagesAcknowledged).toEqual(["architecture"]);
      expect(pageOf(store, projectRoot)).toMatchObject({ status: "fresh", newSessionCount: 0 });

      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      const unseen = finalize("token-unseen");
      tick();
      store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "token-second-save",
        sections: sections(first, "Second."),
        reviewToken: read.reviewToken,
      });
      expect(finalizeMaintaining("token-maintained-again")).not.toHaveProperty("knowledgePagesAcknowledged");
      const next = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      expect(next.sessions[0]?.id).toBe(unseen);
      expect(pageOf(store, projectRoot).newSessionCount).toBe(2);
    });
  });

  describe("section updates", () => {
    type RawPage = {
      version: number;
      sections_json: string;
      sourced_through: string | null;
      checked_through_session_id: string | null;
      update_requested_at: string | null;
      covered_through_completed_at: string | null;
      covered_through_session_id: string | null;
    };
    const hasSectionBaseline = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return false;
      if ("heading" in value && "sourcedThrough" in value) return true;
      return Object.values(value).some(hasSectionBaseline);
    };
    type SectionChange = {
      upsertSections?: KnowledgePageSection[];
      removeHeadings?: string[];
      checkedThroughSessionId?: string;
    };

    function sectionPage() {
      const context = setup();
      const { store, projectRoot, finalize, tick } = context;
      const db = (store as unknown as { db: DatabaseSync }).db;
      const a = finalize("section-a");
      const b = finalize("section-b");
      store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "section-initial",
        sections: [
          { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [a] },
          { heading: "Winter care", content: "Insulate the lid before frost.", sourceSessionIds: [b] },
          { heading: "Feeding", content: "Feed syrup in autumn.", sourceSessionIds: [a] },
        ],
        reviewToken: read.reviewToken,
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
      tick();
      const rawPage = () => db.prepare("SELECT * FROM knowledge_pages").get() as RawPage;
      const versionCount = () =>
        (db.prepare("SELECT COUNT(*) AS count FROM knowledge_page_versions").get() as { count: number }).count;
      const currentToken = () => {
        const focused = store.getKnowledgePageContext({ projectRoot, slug: "architecture", headings: ["Feeding"] });
        if (focused.outcome !== "knowledge_page_context" || !("focused" in focused)) {
          throw new Error("Expected a focused read");
        }
        return focused.reviewToken;
      };
      const sectionUpdate = (key: string, change: SectionChange, reviewToken = currentToken()) =>
        store.saveKnowledgePage({ projectRoot, slug: "architecture", idempotencyKey: key, ...change, reviewToken });
      const page = () => {
        const listed = store.listKnowledgePages({ projectRoot });
        if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
        return listed.items[0]!;
      };
      const headings = () => page().sections.map((section) => section.heading);
      const reviewHeadings = () => (page().reviewSections ?? []).map((section) => section.heading).sort();
      const touch = (sessionId: string, key: string) => {
        tick();
        store.updateSessionSummary({ sessionId, idempotencyKey: key, summary: `${key} changed the summary.` });
        tick();
      };
      return {
        ...context,
        a,
        b,
        db,
        rawPage,
        versionCount,
        currentToken,
        sectionUpdate,
        page,
        headings,
        reviewHeadings,
        touch,
      };
    }

    it("replaces a section in place, appends a new one, removes another, and reports each change", () => {
      const { a, b, sectionUpdate, headings, versionCount, page } = sectionPage();
      const result = sectionUpdate("merge-1", {
        upsertSections: [
          { heading: "FEEDING", content: "Feed syrup until the first frost.", sourceSessionIds: [a] },
          { heading: "Swarm control", content: "Split strong hives in spring.", sourceSessionIds: [b] },
        ],
        removeHeadings: ["  winter CARE "],
      });
      expect(result).toMatchObject({
        outcome: "knowledge_page_saved",
        duplicate: false,
        sectionChanges: { replaced: ["FEEDING"], added: ["Swarm control"], removed: ["Winter care"] },
        page: { version: 2, lastAuthor: "agent", title: "架構與慣例" },
      });
      expect(result).not.toHaveProperty("warnings");
      expect(headings()).toEqual(["Hive layout", "FEEDING", "Swarm control"]);
      expect(page().sections[1]!.content).toBe("Feed syrup until the first frost.");
      expect(versionCount()).toBe(2);
    });

    it("creates a version for a removal alone", () => {
      const { sectionUpdate, headings, versionCount } = sectionPage();
      expect(sectionUpdate("remove-only", { removeHeadings: ["Feeding"] })).toMatchObject({
        outcome: "knowledge_page_saved",
        sectionChanges: { replaced: [], added: [], removed: ["Feeding"] },
        page: { version: 2 },
      });
      expect(headings()).toEqual(["Hive layout", "Winter care"]);
      expect(versionCount()).toBe(2);
    });

    it("matches only the first section when a heading is duplicated", () => {
      const { store, projectRoot, a, sectionUpdate, headings, page } = sectionPage();
      store.saveKnowledgePage({
        projectRoot,
        slug: "architecture",
        idempotencyKey: "duplicated-headings",
        sections: [
          { heading: "Notes", content: "First note.", sourceSessionIds: [a] },
          { heading: "notes", content: "Second note.", sourceSessionIds: [a] },
        ],
      });
      sectionUpdate("duplicate-replace", {
        upsertSections: [{ heading: "NOTES", content: "Replaced note.", sourceSessionIds: [a] }],
      });
      expect(page().sections.map((section) => section.content)).toEqual(["Replaced note.", "Second note."]);
      sectionUpdate("duplicate-remove", { removeHeadings: ["notes"] });
      expect(headings()).toEqual(["notes"]);
    });

    it("refuses removeHeadings the page lacks and writes nothing", () => {
      const { a, sectionUpdate, rawPage, versionCount } = sectionPage();
      const before = rawPage();
      expect(
        sectionUpdate("missing-1", {
          upsertSections: [{ heading: "Swarm control", content: "Split in spring.", sourceSessionIds: [a] }],
          removeHeadings: ["Feeding", " Pests ", "Roof"],
        }),
      ).toMatchObject({ outcome: "section_not_found", headings: [" Pests ", "Roof"] });
      expect(rawPage()).toEqual(before);
      expect(versionCount()).toBe(1);
    });

    it("refuses a merged page that is too large or empty, writing nothing", () => {
      const { a, sectionUpdate, rawPage, versionCount } = sectionPage();
      const before = rawPage();
      const extra = (count: number, content = "A short note.") =>
        Array.from({ length: count }, (_, index) => ({
          heading: `Extra ${index}`,
          content,
          sourceSessionIds: [a],
        }));
      expect(sectionUpdate("limit-count", { upsertSections: extra(10) })).toMatchObject({
        outcome: "page_limit_exceeded",
        sectionCount: 13,
        maxSections: 12,
        maxContentChars: 8_000,
        reason: expect.stringContaining("nothing was written"),
      });
      expect(sectionUpdate("limit-chars", { upsertSections: extra(2, "x".repeat(4_000)) })).toMatchObject({
        outcome: "page_limit_exceeded",
        sectionCount: 5,
        contentChars: expect.any(Number),
      });
      expect(sectionUpdate("limit-empty", { removeHeadings: ["Hive layout", "Winter care", "Feeding"] })).toMatchObject(
        { outcome: "page_limit_exceeded", sectionCount: 0, contentChars: 0 },
      );
      expect(rawPage()).toEqual(before);
      expect(versionCount()).toBe(1);
    });

    it("refuses a stale token and writes nothing", () => {
      const { a, sectionUpdate, currentToken, rawPage, versionCount } = sectionPage();
      const stale = currentToken();
      sectionUpdate("fresh", { removeHeadings: ["Feeding"] });
      const before = rawPage();
      expect(
        sectionUpdate(
          "stale",
          { upsertSections: [{ heading: "Pests", content: "Check for mites.", sourceSessionIds: [a] }] },
          stale,
        ),
      ).toMatchObject({ outcome: "version_conflict", baseVersion: 1, currentVersion: 2 });
      expect(rawPage()).toEqual(before);
      expect(versionCount()).toBe(2);
    });

    it("refuses a section update without a usable reviewToken", () => {
      const { store, projectRoot, versionCount } = sectionPage();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "no-token",
          removeHeadings: ["Feeding"],
        }),
      ).toMatchObject({ outcome: "invalid_review_token" });
      expect(versionCount()).toBe(1);
    });

    it("refuses an uncitable section before merging, like a full save", () => {
      const { sectionUpdate, versionCount } = sectionPage();
      expect(
        sectionUpdate("bad-source", {
          upsertSections: [{ heading: "Pests", content: "Check for mites.", sourceSessionIds: ["missing-session"] }],
        }),
      ).toMatchObject({ outcome: "invalid_sources", sessionIds: ["missing-session"] });
      expect(versionCount()).toBe(1);
    });

    describe("idempotent replays", () => {
      it("answers the same request with the same changes and no new version, also after later saves", () => {
        const { a, sectionUpdate, versionCount, headings } = sectionPage();
        const change = {
          upsertSections: [{ heading: "Pests", content: "Check for mites.", sourceSessionIds: [a] }],
          removeHeadings: ["Feeding"],
        };
        sectionUpdate("replay-1", change);
        sectionUpdate("replay-2", { removeHeadings: ["Pests"] });
        expect(versionCount()).toBe(3);
        expect(sectionUpdate("replay-1", change)).toMatchObject({
          outcome: "knowledge_page_saved",
          duplicate: true,
          sectionChanges: { replaced: [], added: ["Pests"], removed: ["Feeding"] },
        });
        expect(versionCount()).toBe(3);
        expect(headings()).toEqual(["Hive layout", "Winter care"]);
      });

      it("replays the first version of an empty page", () => {
        const { store, projectRoot, finalize } = setup();
        const source = finalize("first-version");
        const requested = store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
        if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected a page");
        const focused = store.getKnowledgePageContext({ projectRoot, slug: "architecture", query: "hive" });
        if (focused.outcome !== "knowledge_page_context" || !("focused" in focused)) throw new Error("Expected a read");
        const request = {
          projectRoot,
          slug: "architecture",
          idempotencyKey: "first-section-update",
          upsertSections: [
            { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [source] },
          ],
          reviewToken: focused.reviewToken,
        };
        expect(store.saveKnowledgePage(request)).toMatchObject({
          outcome: "knowledge_page_saved",
          duplicate: false,
          sectionChanges: { replaced: [], added: ["Hive layout"], removed: [] },
          page: { version: 1 },
        });
        expect(store.saveKnowledgePage(request)).toMatchObject({
          outcome: "knowledge_page_saved",
          duplicate: true,
          sectionChanges: { replaced: [], added: ["Hive layout"], removed: [] },
          page: { version: 1 },
        });
        const versions = store.listKnowledgePageVersions(requested.page.id);
        expect(versions.outcome === "knowledge_page_versions" && versions.versions).toHaveLength(1);
      });

      it("treats a key reused with different content, or across a full save and a section update, as a conflict", () => {
        const { store, projectRoot, a, sectionUpdate, sections, versionCount } = sectionPage();
        sectionUpdate("reused", { removeHeadings: ["Feeding"] });
        expect(sectionUpdate("reused", { removeHeadings: ["Winter care"] })).toMatchObject({
          outcome: "idempotency_conflict",
        });
        expect(
          sectionUpdate("reused", {
            upsertSections: [{ heading: "Pests", content: "Check for mites.", sourceSessionIds: [a] }],
          }),
        ).toMatchObject({ outcome: "idempotency_conflict" });
        expect(
          store.saveKnowledgePage({
            projectRoot,
            slug: "architecture",
            idempotencyKey: "reused",
            sections: sections(a),
          }),
        ).toMatchObject({ outcome: "idempotency_conflict" });
        expect(sectionUpdate("section-initial", { removeHeadings: ["Feeding"] })).toMatchObject({
          outcome: "idempotency_conflict",
        });
        expect(versionCount()).toBe(2);
      });
    });

    describe("coverage", () => {
      it("returns a reviewToken from focused reads that a section update and a full save keep new Sessions with", () => {
        const { store, projectRoot, a, finalize, sectionUpdate, currentToken, page, sections } = sectionPage();
        finalize("section-new-1");
        finalize("section-new-2");
        expect(page().newSessionCount).toBe(2);

        expect(sectionUpdate("coverage-section", { removeHeadings: ["Feeding"] })).toMatchObject({
          outcome: "knowledge_page_saved",
        });
        expect(page().newSessionCount).toBe(2);

        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "coverage-full",
          sections: sections(a),
          reviewToken: currentToken(),
        });
        expect(page()).toMatchObject({ version: 3, newSessionCount: 2 });
      });

      it("keeps the checked cursor and an open update request through a section update", () => {
        const { store, projectRoot, finalize, sectionUpdate, rawPage, page } = sectionPage();
        const checked = finalize("section-checked");
        finalize("section-after-checked");
        store.markKnowledgePageChecked({ projectRoot, slug: "architecture", throughSessionId: checked });
        store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
        const before = rawPage();
        expect(before.update_requested_at).not.toBeNull();
        expect(page().newSessionCount).toBe(1);

        sectionUpdate("keeps-cursor", { removeHeadings: ["Feeding"] });
        expect(rawPage()).toMatchObject({
          checked_through_session_id: checked,
          update_requested_at: before.update_requested_at,
          covered_through_completed_at: before.covered_through_completed_at,
          covered_through_session_id: before.covered_through_session_id,
        });
        expect(page().newSessionCount).toBe(1);
      });

      it("keeps the new Session count of a page saved before coverage was recorded, without inventing a Session", () => {
        const { db, finalize, sectionUpdate, rawPage, page } = sectionPage();
        db.prepare(
          "UPDATE knowledge_pages SET covered_through_completed_at = NULL, covered_through_session_id = NULL",
        ).run();
        finalize("legacy-new-1");
        finalize("legacy-new-2");
        const sourcedThrough = rawPage().sourced_through;
        expect(page().newSessionCount).toBe(2);

        sectionUpdate("legacy-coverage", { removeHeadings: ["Feeding"] });
        expect(page().newSessionCount).toBe(2);
        expect(rawPage()).toMatchObject({
          covered_through_completed_at: sourcedThrough,
          covered_through_session_id: null,
        });
      });
    });

    describe("source review", () => {
      it("keeps an untouched section's review reasons while a replaced section's clear", () => {
        const { a, b, sectionUpdate, touch, reviewHeadings } = sectionPage();
        touch(a, "touch-a");
        touch(b, "touch-b");
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout", "Winter care"]);

        sectionUpdate("review-replace", {
          upsertSections: [{ heading: "Winter care", content: "Wrap the hive in frost.", sourceSessionIds: [b] }],
        });
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout"]);
      });

      it("clears the reasons of a section added by a section update", () => {
        const { a, sectionUpdate, touch, reviewHeadings } = sectionPage();
        touch(a, "touch-a");
        sectionUpdate("review-add", {
          upsertSections: [{ heading: "Pests", content: "Check for mites.", sourceSessionIds: [a] }],
          removeHeadings: ["Winter care"],
        });
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout"]);
      });

      it("keeps the earliest baseline of a section untouched by two successive updates", () => {
        const { a, b, sectionUpdate, touch, reviewHeadings } = sectionPage();
        touch(a, "touch-a");
        sectionUpdate("successive-1", {
          upsertSections: [{ heading: "Winter care", content: "Wrap the hive in frost.", sourceSessionIds: [b] }],
        });
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout"]);

        touch(b, "touch-b");
        sectionUpdate("successive-2", {
          upsertSections: [{ heading: "Feeding", content: "Feed fondant in winter.", sourceSessionIds: [a] }],
        });
        expect(reviewHeadings()).toEqual(["Hive layout", "Winter care"]);
      });

      it("keeps a page of unknown source state unknown for untouched sections only", () => {
        const { db, b, sectionUpdate, rawPage, page } = sectionPage();
        db.prepare("UPDATE knowledge_pages SET sourced_through = NULL, covered_through_completed_at = NULL").run();
        expect(page().reviewSections?.map((section) => section.sources[0]!.reasons)).toEqual([
          ["source_state_unknown"],
          ["source_state_unknown"],
          ["source_state_unknown"],
        ]);

        sectionUpdate("unknown-baseline", {
          upsertSections: [{ heading: "Winter care", content: "Wrap the hive in frost.", sourceSessionIds: [b] }],
        });
        expect(page().reviewSections?.map((section) => section.heading)).toEqual(["Hive layout", "Feeding"]);
        const stored = JSON.parse(rawPage().sections_json) as Array<Record<string, unknown>>;
        expect(stored.map((section) => section.sourcedThrough)).toEqual([null, undefined, null]);
        expect(stored.map((section) => "sourcedThrough" in section)).toEqual([true, false, true]);
      });

      it("clears every stored baseline with a later full save", () => {
        const { store, projectRoot, a, sectionUpdate, touch, currentToken, rawPage, reviewHeadings } = sectionPage();
        touch(a, "touch-a");
        sectionUpdate("stamp", { removeHeadings: ["Winter care"] });
        expect(rawPage().sections_json).toContain("sourcedThrough");

        store.saveKnowledgePage({
          projectRoot,
          slug: "architecture",
          idempotencyKey: "clean-save",
          sections: [{ heading: "Hive layout", content: "Rewritten.", sourceSessionIds: [a] }],
          reviewToken: currentToken(),
        });
        expect(rawPage().sections_json).not.toContain("sourcedThrough");
        expect(reviewHeadings()).toEqual([]);
      });

      it("keeps the same sections needing review after an export and import", () => {
        const { store, project, a, b, sectionUpdate, touch, reviewHeadings, root } = sectionPage();
        touch(a, "touch-a");
        sectionUpdate("export-update", {
          upsertSections: [{ heading: "Winter care", content: "Wrap the hive in frost.", sourceSessionIds: [b] }],
        });
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout"]);

        const bundle = store.exportProjectData({ type: "project", projectId: project.id });
        const destination = new WorkIntelligenceStore(join(root, "section-destination.sqlite"));
        stores.push(destination);
        destination.importProjectData({ bundle, remap: [] });
        destination.updateProject(project.id, { status: "tracked" });
        const imported = destination.listKnowledgePages({ projectId: project.id });
        expect(imported.outcome).toBe("knowledge_pages");
        expect(
          imported.outcome === "knowledge_pages" &&
            (imported.items[0]!.reviewSections ?? []).map((section) => section.heading).sort(),
        ).toEqual(["Feeding", "Hive layout"]);
      });
    });

    describe("identical sections", () => {
      it("reports an identical section as unchanged and creates no version", () => {
        const { a, sectionUpdate, versionCount, rawPage } = sectionPage();
        const updatedAt = rawPage().sourced_through;
        const result = sectionUpdate("identical-1", {
          upsertSections: [{ heading: "Feeding", content: "Feed syrup in autumn.", sourceSessionIds: [a] }],
        });
        expect(result).toMatchObject({
          outcome: "knowledge_page_saved",
          duplicate: false,
          sectionChanges: { replaced: [], added: [], removed: [], unchanged: ["Feeding"] },
          page: { version: 1 },
        });
        expect(versionCount()).toBe(1);
        expect(rawPage().version).toBe(1);
        expect(rawPage().sourced_through).not.toBe(updatedAt);
      });

      it("treats other content, sources or headings as a replacement", () => {
        const { a, b, sectionUpdate, versionCount } = sectionPage();
        expect(
          sectionUpdate("differs-content", {
            upsertSections: [{ heading: "Feeding", content: "Feed syrup in autumn!", sourceSessionIds: [a] }],
          }),
        ).toMatchObject({ sectionChanges: { replaced: ["Feeding"] }, page: { version: 2 } });
        expect(
          sectionUpdate("differs-sources", {
            upsertSections: [{ heading: "Feeding", content: "Feed syrup in autumn!", sourceSessionIds: [a, b] }],
          }),
        ).toMatchObject({ sectionChanges: { replaced: ["Feeding"] }, page: { version: 3 } });
        expect(
          sectionUpdate("differs-heading", {
            upsertSections: [{ heading: "feeding", content: "Feed syrup in autumn!", sourceSessionIds: [a, b] }],
          }),
        ).toMatchObject({ sectionChanges: { replaced: ["feeding"] }, page: { version: 4 } });
        expect(versionCount()).toBe(4);
      });

      it("lists unchanged beside replaced, added and removed in one new version", () => {
        const { a, b, sectionUpdate, versionCount, headings } = sectionPage();
        const result = sectionUpdate("identical-mixed", {
          upsertSections: [
            { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [a] },
            { heading: "Feeding", content: "Feed syrup until frost.", sourceSessionIds: [a] },
            { heading: "Pests", content: "Check for mites.", sourceSessionIds: [b] },
          ],
          removeHeadings: ["Winter care"],
        });
        expect(result).toMatchObject({
          sectionChanges: {
            replaced: ["Feeding"],
            added: ["Pests"],
            removed: ["Winter care"],
            unchanged: ["Hive layout"],
          },
          page: { version: 2 },
        });
        expect(versionCount()).toBe(2);
        expect(headings()).toEqual(["Hive layout", "Feeding", "Pests"]);
      });

      it("still advances the review cursor and clears review without a new version", () => {
        const { store, project, a, b, sectionUpdate, touch, versionCount, rawPage, reviewHeadings, root } =
          sectionPage();
        touch(a, "touch-a");
        expect(reviewHeadings()).toEqual(["Feeding", "Hive layout"]);
        expect(rawPage().checked_through_session_id).toBeNull();

        const result = sectionUpdate("identical-state", {
          upsertSections: [
            { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [a] },
            { heading: "Feeding", content: "Feed syrup in autumn.", sourceSessionIds: [a] },
          ],
          checkedThroughSessionId: b,
        });
        expect(result).toMatchObject({
          sectionChanges: { replaced: [], added: [], removed: [], unchanged: ["Hive layout", "Feeding"] },
          page: { version: 1 },
        });
        expect(rawPage().version).toBe(1);
        expect(rawPage().checked_through_session_id).toBe(b);
        expect(reviewHeadings()).toEqual([]);
        expect(versionCount()).toBe(1);

        const bundle = store.exportProjectData({ type: "project", projectId: project.id });
        const destination = new WorkIntelligenceStore(join(root, "identical-destination.sqlite"));
        stores.push(destination);
        destination.importProjectData({ bundle, remap: [] });
        const destinationDb = (destination as unknown as { db: DatabaseSync }).db;
        expect(destinationDb.prepare("SELECT COUNT(*) AS count FROM knowledge_page_versions").get()).toEqual({
          count: 1,
        });
        expect(destinationDb.prepare("SELECT version, checked_through_session_id FROM knowledge_pages").get()).toEqual({
          version: 1,
          checked_through_session_id: b,
        });
      });
    });

    it("never exposes a stored baseline in reads, versions or digests", () => {
      const { store, projectRoot, db, a, sectionUpdate, touch, page } = sectionPage();
      touch(a, "touch-a");
      sectionUpdate("leak-check", { removeHeadings: ["Winter care"] });
      expect(db.prepare("SELECT sections_json FROM knowledge_pages").get()).toMatchObject({
        sections_json: expect.stringContaining("sourcedThrough"),
      });

      const versions = db.prepare("SELECT sections_json FROM knowledge_page_versions").all() as Array<{
        sections_json: string;
      }>;
      expect(versions).toHaveLength(2);
      for (const version of versions) expect(version.sections_json).not.toContain("sourcedThrough");

      const exposed = [
        store.getKnowledgePageContext({ projectRoot, slug: "architecture" }),
        store.getKnowledgePageContext({ projectRoot, slug: "architecture", headings: ["Hive layout"] }),
        store.getKnowledgePageContext({ projectRoot, slug: "architecture", query: "syrup" }),
        store.listKnowledgePages({ projectRoot }),
        store.listKnowledgePageVersions(page().id),
        store.getContext(projectRoot),
      ];
      for (const result of exposed) expect(hasSectionBaseline(result)).toBe(false);
    });
  });
});

describe("cited-source content changes", () => {
  function savedPage(env: ReturnType<typeof setup>, cited: string) {
    const { store, projectRoot } = env;
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: "pitfalls",
      idempotencyKey: "content-save",
      sections: [
        { heading: "Cited rule", content: "Keep the cited rule current.", sourceSessionIds: [cited] },
        { heading: "Unrelated", content: "資料不足", sourceSessionIds: [] },
      ],
      reviewToken: reviewTokenOf(store, projectRoot, "pitfalls"),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");
    env.tick();
  }
  function reasons(env: ReturnType<typeof setup>): string[] | undefined {
    const listed = env.store.listKnowledgePages({ projectRoot: env.projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
    return listed.items[0]?.reviewSections?.flatMap((section) => section.sources.flatMap((source) => source.reasons));
  }
  function sessionTimes(store: WorkIntelligenceStore, id: string) {
    return (
      store as unknown as {
        db: DatabaseSync;
      }
    ).db
      .prepare("SELECT updated_at, content_updated_at FROM sessions WHERE id = ?")
      .get(id) as { updated_at: string; content_updated_at: string };
  }

  it("does not flag a cited parent when a later Session links to it", () => {
    const env = setup();
    const parent = env.finalize("parent");
    const related = env.finalize("related-peer");
    savedPage(env, parent);
    const before = sessionTimes(env.store, parent);

    env.tick();
    const child = env.store.finalizeSession({
      projectRoot: env.projectRoot,
      idempotencyKey: "child",
      title: "Follow-up",
      summary: "Follow-up summary.",
      workSummary: { outcomes: ["Follow-up outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      parentSessionId: parent,
      relatedSessionIds: [related],
    });
    expect(child).toMatchObject({ outcome: "finalized" });

    const after = sessionTimes(env.store, parent);
    expect(after.updated_at > before.updated_at).toBe(true);
    expect(after.content_updated_at).toBe(before.content_updated_at);
    expect(reasons(env)).toBeUndefined();
  });

  it("does not flag a cited Session for link edits, evidence or diagram void and restore", () => {
    const env = setup();
    const cited = env.finalize("cited");
    const other = env.finalize("other");
    const diagram = env.store.attachDiagram({
      sessionId: cited,
      idempotencyKey: "diagram",
      title: "Flow",
      kind: "architecture",
      formatVersion: 1,
      source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }] }),
    });
    if (diagram.outcome !== "diagram_attached") throw new Error("Expected a diagram");
    savedPage(env, cited);

    const link = (linked: boolean) =>
      env.store.linkSessions({ sessionId: cited, relatedSessionId: other, relation: "related", linked });
    expect(link(true)).toMatchObject({ outcome: "session_link_updated" });
    env.tick();
    expect(link(false)).toMatchObject({ outcome: "session_link_updated" });
    env.tick();
    const evidence = env.store.attachEvidence({
      sessionId: cited,
      kind: "test",
      reference: "pnpm test",
      summary: "ok",
    });
    if (evidence.outcome !== "evidence_attached") throw new Error("Expected evidence");
    env.tick();
    env.store.setEvidenceVoid({ evidenceId: evidence.evidence.id, voided: true, reason: "Fixture." });
    env.tick();
    env.store.setEvidenceVoid({ evidenceId: evidence.evidence.id, voided: false });
    env.tick();
    env.store.setDiagramVoid({ diagramId: diagram.diagram.id, voided: true, reason: "Fixture." });
    env.tick();
    env.store.setDiagramVoid({ diagramId: diagram.diagram.id, voided: false });

    const times = sessionTimes(env.store, cited);
    expect(times.updated_at > times.content_updated_at).toBe(true);
    expect(reasons(env)).toBeUndefined();
  });

  it.each([
    [
      "summary",
      (env: ReturnType<typeof setup>, id: string) =>
        env.store.updateSessionSummary({ sessionId: id, idempotencyKey: "s", summary: "Corrected summary." }),
    ],
    [
      "work summary",
      (env: ReturnType<typeof setup>, id: string) =>
        env.store.updateSessionWorkSummary({
          sessionId: id,
          idempotencyKey: "w",
          mode: "patch",
          workSummary: { outcomes: ["Corrected outcome."] },
        }),
    ],
    [
      "title",
      (env: ReturnType<typeof setup>, id: string) =>
        env.store.updateSessionTitle({ sessionId: id, title: "Corrected title" }),
    ],
    [
      "verification",
      (env: ReturnType<typeof setup>, id: string) =>
        env.store.updateSessionVerification(id, { status: "failed" }, "agent"),
    ],
    [
      "changed files",
      (env: ReturnType<typeof setup>, id: string) =>
        env.store.updateSessionMetadata({ sessionId: id, changedFiles: ["src/new.ts"], changedFilesMode: "merge" }),
    ],
  ])("still flags a cited Session after a %s change", (_name, change) => {
    const env = setup();
    const cited = env.finalize("cited");
    savedPage(env, cited);
    change(env, cited);
    expect(reasons(env)).toEqual(["source_updated_after_save"]);
  });

  it("does not flag a cited Session with no content_updated_at after a diagram void and restore", () => {
    const env = setup();
    const cited = env.finalize("cited");
    const diagram = env.store.attachDiagram({
      sessionId: cited,
      idempotencyKey: "diagram",
      title: "Flow",
      kind: "architecture",
      formatVersion: 1,
      source: JSON.stringify({ version: 1, nodes: [{ id: "entry", label: "Entry" }] }),
    });
    if (diagram.outcome !== "diagram_attached") throw new Error("Expected a diagram");
    savedPage(env, cited);
    (env.store as unknown as { db: DatabaseSync }).db
      .prepare("UPDATE sessions SET content_updated_at = NULL WHERE id = ?")
      .run(cited);

    env.store.setDiagramVoid({ diagramId: diagram.diagram.id, voided: true, reason: "Fixture." });
    env.tick();
    env.store.setDiagramVoid({ diagramId: diagram.diagram.id, voided: false });

    expect(reasons(env)).toBeUndefined();
  });

  it("does not flag a cited Session for a metadata backfill that changes nothing", () => {
    const env = setup();
    const cited = env.finalize("cited");
    savedPage(env, cited);
    const result = env.store.updateSessionMetadata({ sessionId: cited, changedFiles: [], changedFilesMode: "merge" });
    expect(result.outcome).toBe("updated");
    const times = sessionTimes(env.store, cited);
    expect(times.updated_at > times.content_updated_at).toBe(true);
    expect(reasons(env)).toBeUndefined();
  });
});
