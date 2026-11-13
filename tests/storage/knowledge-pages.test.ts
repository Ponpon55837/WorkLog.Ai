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


/** Narrows a default (non-focused) read for assertions. */
function fullContext(result: ReturnType<WorkIntelligenceStore["getKnowledgePageContext"]>) {
  if (result.outcome !== "knowledge_page_context" || "focused" in result) {
    throw new Error(`Expected a default knowledge page context, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
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
    // Another project's page id is never resolved or revealed.
    expect(lookup(foreign.page.id)).toEqual({
      outcome: "not_found",
      slug: foreign.page.id,
      reasonCode: "slug_looks_like_id",
      reason: expect.any(String),
      ...listed,
    });
    expect(lookup("pitfall")).toMatchObject({ reasonCode: "slug_near_match", suggestedSlug: "pitfalls", ...listed });
    expect(lookup("hive-logs")).toMatchObject({ reasonCode: "slug_near_match", suggestedSlug: "hive-log" });
    // A typo of a default page that was never requested points to the request tool.
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
    // Newest first, without gaps, until the Session budget is spent; the rest are flagged, never cut silently.
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
    store.saveKnowledgePage({ projectRoot, slug: "architecture", idempotencyKey: "a-1", sections: sections(source) });
    finalize("between");
    store.saveKnowledgePage({ projectRoot, slug: "pitfalls", idempotencyKey: "p-1", sections: sections(source) });
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
    expect(review.sessions.map((session) => [session.id, session.reason])).toEqual([
      [cited, "source_changed"],
      [firstNew, "new"],
      [secondNew, "new"],
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

    // The work that saved both pages is recorded right after the saves.
    const maintaining = finalizeMaintaining("maintained-update-pages", ["architecture", "pitfalls", "missing"]);
    expect(maintaining.knowledgePagesAcknowledged).toEqual(["architecture", "pitfalls"]);
    const unrelated = finalize("maintained-unrelated-pr");
    const listed = store.listKnowledgePages({ projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
    for (const page of listed.items) {
      expect(page).toMatchObject({ status: "has_new_data", newSessionCount: 1 });
      expect(page.needsReview).toBeFalsy();
    }

    // A later maintaining Session does not hide the unrelated one before it.
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
          { heading: "Winter care", content: "Insulate the lid before frost; check the mite-sweep rota.", sourceSessionIds: [b, a] },
          { heading: "winter care", content: "Second winter note about wrapping.", sourceSessionIds: [a] },
          { heading: "蜂箱管理", content: "每週檢查一次蜂王狀態。", sourceSessionIds: [b] },
        ],
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
          { heading: "Rights", content: "Granted rights stay with the owners of the ts config.", sourceSessionIds: [source] },
        ],
      });
      const names = (input: { query?: string; headings?: string[] }) => {
        const result = store.getKnowledgePageContext({ projectRoot, slug: "architecture", ...input });
        if (!("focused" in result)) throw new Error("Expected a focused read");
        return result.sections.map((section) => section.heading);
      };
      // Three sections share "ledger"; only the one with most of the terms is returned.
      expect(names({ query: "ledger rotation window schedule" })).toEqual(["Rotation"]);
      // Chinese bigrams: several sections share one bigram, only the one with most bigrams remains.
      expect(names({ query: "簽章輪替排程" })).toEqual(["輪替"]);
      // A short Latin term matches whole tokens only: "ts" is a token of Rights' content; "gh" is inside "rights".
      expect(names({ query: "ts" })).toEqual(["Rights"]);
      expect(names({ query: "gh" })).toEqual([]);
      // A 4+ character Latin term also matches as a token prefix.
      expect(names({ query: "rotat" })).toEqual(["Rotation"]);
      // Headings are always included, in addition to the best query matches.
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
      if (page.outcome !== "knowledge_page_context" || "focused" in page) throw new Error("Expected a page");
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
});
