import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageContextResult, KnowledgePageSection } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { RELEASE_FILES, sectionFile, seedSectionedPage } from "../helpers/knowledge-page-fixture.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const slug = "architecture";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-review-only-"));
  tempDirs.push(root);
  const projectRoot = join(root, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (key: string, options: { changedFiles?: string[]; relatedSessionIds?: string[] } = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: options.changedFiles ?? [],
      ...(options.relatedSessionIds ? { relatedSessionIds: options.relatedSessionIds } : {}),
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const read = (extra: { reviewOnly?: boolean } = {}) => store.getKnowledgePageContext({ projectRoot, slug, ...extra });
  const save = (key: string, sections: KnowledgePageSection[], reviewToken: string) => {
    const saved = store.saveKnowledgePage({ projectRoot, slug, idempotencyKey: key, sections, reviewToken });
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    tick();
  };
  return { store, projectRoot, finalize, tick, read, save };
}

function reviewOnly(result: KnowledgePageContextResult) {
  if (result.outcome !== "knowledge_page_context" || !("reviewOnly" in result)) {
    throw new Error(`Expected a review-only read, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}

function fullContext(result: KnowledgePageContextResult) {
  if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
    throw new Error(`Expected a default read, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}

const QUIET_SECTIONS = ["Swarming", "Honey harvest", "Pests"];

function writtenPage() {
  const context = setup();
  const { store, projectRoot, finalize, read, save } = context;
  const hive = finalize("hive", { changedFiles: ["src/hive.ts", "CHANGELOG.md"] });
  const winter = finalize("winter", { changedFiles: ["src/winter.ts", "CHANGELOG.md"] });
  const quiet = QUIET_SECTIONS.map((heading) => finalize(heading, { changedFiles: ["CHANGELOG.md"] }));
  store.requestKnowledgePageUpdate({ projectRoot, slug });
  save(
    "initial",
    [
      { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [hive] },
      { heading: "Winter care", content: "Insulate the lid before frost.", sourceSessionIds: [winter] },
      { heading: "Feeding", content: "資料不足", sourceSessionIds: [] },
      ...QUIET_SECTIONS.map((heading, index) => ({
        heading,
        content: `${heading} notes.`,
        sourceSessionIds: [quiet[index]!],
      })),
    ],
    fullContext(read()).reviewToken,
  );
  return { ...context, hive, winter };
}

function sectionedPage(count: number, sectionOf: (index: number) => number) {
  const context = setup();
  const finalize = (key: string, changedFiles: string[]) => context.finalize(key, { changedFiles });
  seedSectionedPage(context.store, context.projectRoot, finalize, slug);
  const newIds = Array.from({ length: count }, (_, index) =>
    finalize(`new-${index}`, [...RELEASE_FILES, sectionFile(sectionOf(index))]),
  );
  return { ...context, newIds };
}

const size = (value: unknown) => JSON.stringify(value).length;

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("review-only Knowledge page reads", () => {
  it("returns only the sections new Sessions map to, by link or shared file, and lists the rest by title", () => {
    const { store, projectRoot, finalize, read, hive, winter } = writtenPage();
    const linked = finalize("linked", { relatedSessionIds: [winter] });
    const unrelated = finalize("unrelated", { changedFiles: ["docs/notes.md"] });
    const sharedFile = finalize("shared-file", { changedFiles: ["src/hive.ts"] });

    const result = reviewOnly(read({ reviewOnly: true }));

    expect(result).toMatchObject({
      review: "sections",
      page: { slug, version: 1, status: "has_new_data", newSessionCount: 3 },
      size: { sectionCount: 6, maxSections: 12, maxContentChars: 8_000 },
      truncated: false,
      checkedThroughCandidate: sharedFile,
    });
    expect(result.size.contentChars).toBe(
      "Queen excluders go on first.".length +
        "Insulate the lid before frost.".length +
        "資料不足".length +
        QUIET_SECTIONS.reduce((total, heading) => total + `${heading} notes.`.length, 0),
    );
    expect(result.sections).toEqual([
      {
        heading: "Hive layout",
        content: "Queen excluders go on first.",
        sourceSessionIds: [hive],
        reasons: ["new_session_shared_files"],
        newSessionIds: [sharedFile],
      },
      {
        heading: "Winter care",
        content: "Insulate the lid before frost.",
        sourceSessionIds: [winter],
        reasons: ["new_session_linked"],
        newSessionIds: [linked],
      },
    ]);
    expect(result.otherSections).toEqual([
      { heading: "Feeding", chars: "資料不足".length },
      ...QUIET_SECTIONS.map((heading) => ({ heading, chars: `${heading} notes.`.length })),
    ]);
    expect(size(result)).toBeLessThan(size(fullContext(read())));
    expect(result.sessions.map((session) => [session.id, session.reasons])).toEqual([
      [linked, ["new"]],
      [sharedFile, ["new"]],
    ]);
    expect(result.unmappedSessions).toEqual([
      { id: unrelated, title: "Session unrelated", completedAt: expect.any(String) },
    ]);

    const updated = store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: "review-only-update",
      upsertSections: [
        { heading: "Winter care", content: "Insulate and reduce the entrance.", sourceSessionIds: [linked] },
      ],
      reviewToken: result.reviewToken,
    });
    expect(updated).toMatchObject({ outcome: "knowledge_page_saved", page: { newSessionCount: 3 } });
    expect(
      store.markKnowledgePageChecked({ projectRoot, slug, throughSessionId: result.checkedThroughCandidate! }),
    ).toMatchObject({
      outcome: "knowledge_page_checked",
      page: { newSessionCount: 0 },
    });
  });

  it("ignores a file cited Sessions of more than three sections changed and does not map a new cited Session to its own section", () => {
    const { store, projectRoot, finalize, read, hive } = writtenPage();
    const releaseOnly = finalize("release-only", { changedFiles: ["CHANGELOG.md"] });

    const result = reviewOnly(read({ reviewOnly: true }));
    expect(result.review).toBe("new_sessions");
    expect(result.sections).toEqual([]);
    expect(result.unmappedSessions.map((session) => session.id)).toEqual([releaseOnly]);

    const followUp = finalize("hive-follow-up", { changedFiles: ["src/hive.ts"] });
    const token = reviewOnly(read({ reviewOnly: true })).reviewToken;
    store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: "cite-follow-up",
      upsertSections: [{ heading: "Feeding", content: "Feed syrup in autumn.", sourceSessionIds: [followUp] }],
      reviewToken: token,
    });
    const afterCite = reviewOnly(read({ reviewOnly: true }));
    expect(afterCite.sections.map((section) => [section.heading, section.newSessionIds])).toEqual([
      ["Hive layout", [followUp]],
    ]);
    expect(afterCite.sections[0]?.sourceSessionIds).toEqual([hive]);
  });

  it("lists a changed source that is also new once, with both reasons, in the review and review-only reads", () => {
    const { store, projectRoot, finalize, tick, read, winter } = writtenPage();
    const lateSource = finalize("late-source", { changedFiles: ["docs/late.md"] });
    store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: "cite-late-source",
      upsertSections: [{ heading: "Feeding", content: "Feed syrup in autumn.", sourceSessionIds: [lateSource] }],
      reviewToken: reviewOnly(read({ reviewOnly: true })).reviewToken,
    });
    const later = finalize("later");
    tick();
    store.updateSessionSummary({ sessionId: lateSource, idempotencyKey: "late-fix", summary: "Corrected later." });
    tick();
    store.updateSessionSummary({ sessionId: winter, idempotencyKey: "winter-fix", summary: "Corrected winter." });

    const review = fullContext(read());
    expect(review.mode).toBe("review");
    expect(review.sessions.map((session) => [session.id, session.reasons])).toEqual([
      [winter, ["source_changed"]],
      [lateSource, ["new", "source_changed"]],
      [later, ["new"]],
    ]);

    const result = reviewOnly(read({ reviewOnly: true }));
    expect(result.sessions.map((session) => [session.id, session.reasons])).toEqual([
      [winter, ["source_changed"]],
      [lateSource, ["new", "source_changed"]],
    ]);
    expect(result.sections.map((section) => [section.heading, section.reasons, section.changedSources])).toEqual([
      [
        "Winter care",
        ["source_updated_after_save"],
        [{ sourceSessionId: winter, reasons: ["source_updated_after_save"] }],
      ],
      [
        "Feeding",
        ["source_updated_after_save"],
        [{ sourceSessionId: lateSource, reasons: ["source_updated_after_save"] }],
      ],
    ]);
    expect(result.unmappedSessions.map((session) => session.id)).toEqual([later]);
    expect(result.checkedThroughCandidate).toBe(later);
  });

  it("says when nothing needs review and sends an empty or requested page to the full read", () => {
    const { store, projectRoot, read } = writtenPage();
    const idle = reviewOnly(read({ reviewOnly: true }));
    expect(idle).toMatchObject({ review: "none", sections: [], sessions: [], unmappedSessions: [], truncated: false });
    expect(idle).not.toHaveProperty("checkedThroughCandidate");
    expect(idle.otherSections.map((section) => section.heading)).toEqual([
      "Hive layout",
      "Winter care",
      "Feeding",
      ...QUIET_SECTIONS,
    ]);
    expect(JSON.stringify(idle).length).toBeLessThan(1_200);

    store.requestKnowledgePageUpdate({ projectRoot, slug });
    expect(reviewOnly(read({ reviewOnly: true }))).toMatchObject({ review: "full_rewrite", sections: [] });
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    expect(
      reviewOnly(store.getKnowledgePageContext({ projectRoot, slug: "pitfalls", reviewOnly: true })),
    ).toMatchObject({ review: "full_rewrite", otherSections: [], size: { sectionCount: 0, contentChars: 0 } });
  });

  it("accounts for new Sessions oldest first and stops the check candidate where the read was cut", () => {
    const { finalize, read } = writtenPage();
    const ids = Array.from({ length: 61 }, (_, index) => finalize(`bulk-${index}`));

    const result = reviewOnly(read({ reviewOnly: true }));
    expect(result.truncated).toBe(true);
    const listed = result.unmappedSessions.map((session) => session.id);
    expect(listed).toEqual(ids.slice(0, listed.length));
    expect(listed.length).toBeLessThan(61);
    expect(result.checkedThroughCandidate).toBe(listed.at(-1));
    expect(JSON.stringify(result.unmappedSessions).length).toBeLessThanOrEqual(3_000);
  });

  it("maps each new Session to the section owning its own file, not to every section a release file touches", () => {
    for (const count of [3, 8]) {
      const { read, newIds } = sectionedPage(count, (index) => index % 3);
      const result = reviewOnly(read({ reviewOnly: true }));
      const full = fullContext(read());
      expect(result.review).toBe("sections");
      expect(result.sections.map((section) => section.heading)).toEqual(["Topic 0", "Topic 1", "Topic 2"]);
      for (const [index, id] of newIds.entries()) {
        const mappedTo = result.sections.filter((section) => section.newSessionIds?.includes(id));
        expect(mappedTo.length).toBeLessThanOrEqual(3);
        expect(mappedTo.map((section) => section.heading)).toContain(`Topic ${index % 3}`);
      }
      expect(result.unmappedSessions).toEqual([]);
      expect(result.checkedThroughCandidate).toBe(newIds.at(-1));
      expect(size(result)).toBeLessThan(size(full) / 2);
    }
  });

  it("sends the Agent to the full read when most sections need review", () => {
    const { read, newIds } = sectionedPage(8, (index) => index);
    const result = reviewOnly(read({ reviewOnly: true }));
    expect(result).toMatchObject({
      review: "use_full_read",
      sections: [],
      sessions: [],
      unmappedSessions: [],
      truncated: false,
    });
    expect(result).not.toHaveProperty("checkedThroughCandidate");
    expect(result.otherSections).toHaveLength(12);
    expect(newIds).toHaveLength(8);
    expect(size(result)).toBeLessThan(size(fullContext(read())));
  });
});
