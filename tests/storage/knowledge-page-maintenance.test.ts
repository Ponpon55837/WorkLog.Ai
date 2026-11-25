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
  if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
    throw new Error(`Expected a default knowledge page context, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}
const workSummary = (outcome: string) => ({
  outcomes: [outcome],
  scope: [],
  decisions: [],
  verification: [],
  nextSteps: [],
});

describe("Knowledge page maintenance", () => {
  /** A page written once, citing one Session. */
  function writtenPage(slug = "pitfalls") {
    const context = setup();
    const { store, projectRoot, finalize, sections } = context;
    const cited = finalize("maintenance-cited");
    store.requestKnowledgePageUpdate({ projectRoot, slug });
    const saved = store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: "maintenance-save",
      sections: sections(cited),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");
    return { ...context, cited, page: saved.page, slug };
  }
  const pageOf = (store: WorkIntelligenceStore, projectRoot: string, slug: string) => {
    const listed = store.listKnowledgePages({ projectRoot });
    if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
    return listed.items.find((page) => page.slug === slug)!;
  };
  const versionsOf = (store: WorkIntelligenceStore, pageId: string) => {
    const listed = store.listKnowledgePageVersions(pageId);
    if (listed.outcome !== "knowledge_page_versions") throw new Error("Expected versions");
    return listed.versions;
  };
  const citedIds = (sections: KnowledgePageSection[]) => [...new Set(sections.flatMap((s) => s.sourceSessionIds))];

  it("K01: a check through a middle Session leaves the page untouched and later Sessions new", () => {
    const { store, projectRoot, slug, page, finalize } = writtenPage();
    const [one, two, three] = ["k01-one", "k01-two", "k01-three"].map((key) => finalize(key));
    const before = pageOf(store, projectRoot, slug);
    expect(before).toMatchObject({ status: "has_new_data", newSessionCount: 3 });

    const checked = store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: two! });
    if (checked.outcome !== "knowledge_page_checked") throw new Error("Expected a check");
    expect(checked.page).toMatchObject({ version: 1, newSessionCount: 1, checkedThrough: { sessionId: two } });
    expect(checked.page.sections).toEqual(before.sections);
    expect(versionsOf(store, page.id)).toHaveLength(1);
    const review = fullContext(store.getKnowledgePageContext({ projectRoot, slug }));
    expect(review.sessions.map((session) => [session.id, session.reasons])).toEqual([[three, ["new"]]]);

    const four = finalize("k01-four");
    expect(pageOf(store, projectRoot, slug).newSessionCount).toBe(2);
    expect(
      fullContext(store.getKnowledgePageContext({ projectRoot, slug })).sessions.map((session) => session.id),
    ).toEqual([three, four]);

    // The cursor never moves back, and a refused move changes nothing.
    expect(store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: one! })).toMatchObject({
      outcome: "invalid_cursor",
    });
    expect(pageOf(store, projectRoot, slug)).toMatchObject({ checkedThrough: { sessionId: two }, newSessionCount: 2 });
  });

  describe("K03: a cited Session changed by a path other than a summary edit", () => {
    const changes = {
      "a later Session continuing it": ({ store, projectRoot, cited, tick }: ReturnType<typeof writtenPage>) => {
        tick();
        const result = store.finalizeSession({
          projectRoot,
          idempotencyKey: "k03-child",
          title: "Session k03-child",
          summary: "A later Session that continues the cited one.",
          workSummary: workSummary("k03-child outcome"),
          changedFiles: [],
          verification: { status: "passed" },
          parentSessionId: cited,
        });
        if (result.outcome !== "finalized") throw new Error("Expected finalize");
        return result.session.id;
      },
      "a new related-Session link": ({ store, finalize, cited, tick }: ReturnType<typeof writtenPage>) => {
        const other = finalize("k03-other");
        tick();
        const linked = store.linkSessions({
          sessionId: cited,
          relatedSessionId: other,
          relation: "related",
          linked: true,
        });
        expect(linked.outcome).toBe("session_link_updated");
        return other;
      },
      "a work summary patch": ({ store, finalize, cited, tick }: ReturnType<typeof writtenPage>) => {
        const latest = finalize("k03-latest");
        tick();
        const updated = store.updateSessionWorkSummary({
          sessionId: cited,
          idempotencyKey: "k03-patch",
          mode: "patch",
          workSummary: { outcomes: ["Corrected outcome."] },
        });
        expect(updated.outcome).toBe("work_summary_updated");
        return latest;
      },
    };

    it.each(Object.entries(changes))("flags review for %s until a new version is saved", (_name, change) => {
      const context = writtenPage();
      const { store, projectRoot, slug, page, cited, sections, tick } = context;
      expect(pageOf(store, projectRoot, slug)).not.toHaveProperty("needsReview");
      const newest = change(context);

      const flagged = pageOf(store, projectRoot, slug);
      expect(flagged.needsReview).toBe(true);
      expect(flagged.reviewSections).toEqual([
        {
          heading: "Hive layout",
          sources: [expect.objectContaining({ sourceSessionId: cited, reasons: ["source_updated_after_save"] })],
        },
      ]);
      expect(fullContext(store.getKnowledgePageContext({ projectRoot, slug })).sessions[0]).toMatchObject({
        id: cited,
        reasons: ["source_changed"],
      });

      const checked = store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: newest });
      expect(checked).toMatchObject({ outcome: "knowledge_page_checked", page: { needsReview: true, version: 1 } });
      expect(versionsOf(store, page.id)).toHaveLength(1);

      tick();
      const resaved = store.saveKnowledgePage({
        projectRoot,
        slug,
        idempotencyKey: "k03-resave",
        sections: sections(cited, "Rechecked."),
      });
      expect(resaved).toMatchObject({ outcome: "knowledge_page_saved", duplicate: false, page: { version: 2 } });
      expect(pageOf(store, projectRoot, slug)).not.toHaveProperty("needsReview");
    });
  });

  it("K04: a check after void and restore keeps the source review warning", () => {
    const { store, projectRoot, slug, cited, finalize, tick } = writtenPage();
    tick();
    store.setSessionVoid({ sessionId: cited, voided: true, reason: "Fixture source review." });
    tick();
    store.setSessionVoid({ sessionId: cited, voided: false });
    const latest = finalize("k04-latest");
    expect(store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: latest })).toMatchObject({
      outcome: "knowledge_page_checked",
      page: { needsReview: true, newSessionCount: 0 },
    });
    expect(pageOf(store, projectRoot, slug).reviewSections?.[0]?.sources[0]?.reasons).toContain(
      "source_restored_after_save",
    );
  });

  it("K07: a read cut by the character budget leaves unshown Sessions new, in order", () => {
    const { store, projectRoot, slug, tick } = writtenPage();
    const total = 30;
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      tick();
      const filler = (label: string) => `${label} ${index}: ${"fictional hive inspection detail ".repeat(8)}`;
      const result = store.finalizeSession({
        projectRoot,
        idempotencyKey: `k07-${index}`,
        title: `Budget Session ${index}`,
        summary: "Summary left to work_get_session.",
        workSummary: {
          outcomes: [filler("Outcome 1"), filler("Outcome 2")],
          scope: [],
          decisions: [filler("Decision 1"), filler("Decision 2")],
          verification: [],
          nextSteps: [filler("Open item")],
        },
        changedFiles: [],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") throw new Error("Expected finalize");
      ids.push(result.session.id);
    }

    const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug }));
    expect(read.mode).toBe("review");
    // Fewer than the 60-Session cap, so the budget alone caused the cut.
    expect(read.sessions.length).toBeGreaterThan(0);
    expect(read.sessions.length).toBeLessThan(total);
    expect(read.truncated).toBe(true);
    const shown = read.sessions.map((session) => session.id);
    expect(shown).toEqual(ids.slice(0, shown.length));

    const checked = store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: shown.at(-1)! });
    expect(checked).toMatchObject({
      outcome: "knowledge_page_checked",
      page: { newSessionCount: total - shown.length },
    });
    const next = fullContext(store.getKnowledgePageContext({ projectRoot, slug }));
    expect(next.sessions[0]?.id).toBe(ids[shown.length]);
    expect(next.sessions.map((session) => session.id)).toEqual(
      ids.slice(shown.length, shown.length + next.sessions.length),
    );
  });

  describe("K09: retrying a save with the same idempotency key", () => {
    it("returns the stored page without writing anything", () => {
      const { store, projectRoot, slug, page, cited, finalize, tick, sections } = writtenPage();
      const later = finalize("k09-later");
      store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: later });
      finalize("k09-unchecked");
      const before = pageOf(store, projectRoot, slug);
      const versionsBefore = versionsOf(store, page.id);
      tick();

      const retried = store.saveKnowledgePage({
        projectRoot,
        slug,
        idempotencyKey: "maintenance-save",
        sections: sections(cited),
      });
      expect(retried).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true, page: { version: 1 } });
      expect(retried.outcome === "knowledge_page_saved" && retried.page).toEqual(before);
      expect(pageOf(store, projectRoot, slug)).toEqual(before);
      expect(before).toMatchObject({ newSessionCount: 1, checkedThrough: { sessionId: later } });
      expect(versionsOf(store, page.id)).toEqual(versionsBefore);
    });

    it("rejects a reused idempotencyKey with different sections and writes nothing", () => {
      const { store, projectRoot, slug, page, cited, tick, sections } = writtenPage();
      const before = pageOf(store, projectRoot, slug);
      const versionsBefore = versionsOf(store, page.id);
      tick();
      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug,
          idempotencyKey: "maintenance-save",
          sections: sections(cited, "Different content under the same key."),
        }),
      ).toEqual({ outcome: "idempotency_conflict", reason: expect.any(String) });
      expect(pageOf(store, projectRoot, slug)).toEqual(before);
      expect(versionsOf(store, page.id)).toEqual(versionsBefore);
    });

    it("never reports a reused key with other content as saved, even with an invalid token or source", () => {
      const { store, projectRoot, slug, page, cited, tick, sections } = writtenPage();
      tick();
      for (const attempt of [
        { sections: sections(cited, "Other content."), reviewToken: "not-a-token" },
        { sections: sections("missing-session", "Other content.") },
      ]) {
        expect(
          store.saveKnowledgePage({ projectRoot, slug, idempotencyKey: "maintenance-save", ...attempt }),
        ).toMatchObject({ outcome: "idempotency_conflict" });
      }
      expect(versionsOf(store, page.id)).toHaveLength(1);
    });

    it("still treats a retry with masked secrets in its sections as a duplicate", () => {
      const { store, projectRoot, finalize, tick, sections } = setup();
      const cited = finalize("k09-secret-cited");
      store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
      const withSecret = sections(cited, `Deploy with ghp_${"C".repeat(36)} only from CI.`);
      const first = store.saveKnowledgePage({
        projectRoot,
        slug: "pitfalls",
        idempotencyKey: "k09-secret",
        sections: withSecret,
      });
      expect(first).toMatchObject({ outcome: "knowledge_page_saved", duplicate: false });
      tick();
      expect(
        store.saveKnowledgePage({ projectRoot, slug: "pitfalls", idempotencyKey: "k09-secret", sections: withSecret }),
      ).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true, page: { version: 1 } });
    });
  });

  describe("K10: a cited Session changes between the read and the save", () => {
    it("refuses a save citing a Session voided after the read and writes nothing", () => {
      const { store, projectRoot, slug, page, cited, finalize, tick, sections } = writtenPage();
      const fresh = finalize("k10-fresh");
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug }));
      tick();
      store.setSessionVoid({ sessionId: fresh, voided: true, reason: "Recorded by mistake." });
      const before = pageOf(store, projectRoot, slug);
      const versionsBefore = versionsOf(store, page.id);
      tick();

      expect(
        store.saveKnowledgePage({
          projectRoot,
          slug,
          idempotencyKey: "k10-void-save",
          sections: sections(fresh),
          reviewToken: read.reviewToken,
        }),
      ).toMatchObject({ outcome: "invalid_sources", sessionIds: [fresh] });
      expect(pageOf(store, projectRoot, slug)).toEqual(before);
      expect(before.version).toBe(1);
      expect(versionsOf(store, page.id)).toEqual(versionsBefore);
      expect(citedIds(before.sections)).toEqual([cited]);
    });

    it("records current behavior: a summary edit after the read is not flagged for review", () => {
      const { store, projectRoot, slug, cited, tick, sections } = writtenPage();
      const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug }));
      tick();
      store.updateSessionSummary({
        sessionId: cited,
        idempotencyKey: "k10-edit",
        summary: "The cited Session changed after the Agent read the page.",
      });
      tick();
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug,
        idempotencyKey: "k10-edit-save",
        sections: sections(cited, "Written from the stale read."),
        reviewToken: read.reviewToken,
      });
      expect(saved).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 2 } });
      // Known limitation: sourced_through is the save time, so a change between the read and the save is not
      // marked for review. This test records current behavior only.
      expect(pageOf(store, projectRoot, slug)).not.toHaveProperty("needsReview");
    });
  });

  it("K18: the listed page and the latest version match what was saved", () => {
    const { store, projectRoot, finalize, tick, sections } = setup();
    const cited = finalize("k18-cited");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const read = fullContext(store.getKnowledgePageContext({ projectRoot, slug: "architecture" }));
    tick();
    const saved = sections(cited, "Brood boxes sit under the supers.");
    const result = store.saveKnowledgePage({
      projectRoot,
      slug: "architecture",
      idempotencyKey: "k18-save",
      sections: saved,
      reviewToken: read.reviewToken,
    });
    if (result.outcome !== "knowledge_page_saved") throw new Error("Expected the page to save.");
    finalize("k18-after-1");
    finalize("k18-after-2");

    const page = pageOf(store, projectRoot, "architecture");
    expect(page.sections).toEqual(saved);
    expect(citedIds(page.sections)).toEqual([cited]);
    expect(page).not.toHaveProperty("needsReview");
    expect(page).toMatchObject({ version: 1, status: "has_new_data", newSessionCount: 2, lastAuthor: "agent" });

    const latest = versionsOf(store, page.id)[0]!;
    expect(latest).toMatchObject({ version: page.version, author: "agent", title: page.title });
    expect(latest.sections).toEqual(page.sections);
    expect(citedIds(latest.sections)).toEqual(citedIds(page.sections));
  });
});
