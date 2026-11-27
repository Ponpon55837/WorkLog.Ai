import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageSection, VerificationStatus } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const SLUG = "architecture";
const SOURCE_LIMIT = 20;

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-knowledge-save-flow-"));
  tempDirs.push(root);
  const projectRoot = join(root, "apiary");
  const otherRoot = join(root, "orchard");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  store.updateProject(store.addProject("Apiary", projectRoot).id, { status: "tracked" });
  store.updateProject(store.addProject("Orchard", otherRoot).id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (
    key: string,
    options: { status?: VerificationStatus; rootPath?: string; completedAt?: string } = {},
  ) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: options.rootPath ?? projectRoot,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: options.status ?? "passed" },
      ...(options.completedAt ? { completedAt: options.completedAt } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const section = (heading: string, sourceSessionIds: string[], content = `${heading} stays small.`) => ({
    heading,
    content,
    sourceSessionIds,
  });
  const readToken = () => {
    const result = store.getKnowledgePageContext({ projectRoot, slug: SLUG });
    if (result.outcome !== "knowledge_page_context") throw new Error("Expected a knowledge page context");
    return result.reviewToken;
  };
  let saves = 0;
  const fullSave = (sections: KnowledgePageSection[], reviewToken = readToken()) => {
    saves += 1;
    return store.saveKnowledgePage({ projectRoot, slug: SLUG, idempotencyKey: `full-${saves}`, sections, reviewToken });
  };
  const sectionSave = (
    reviewToken: string,
    extra: { upsertSections?: KnowledgePageSection[]; removeHeadings?: string[]; checkedThroughSessionId?: string },
  ) => {
    saves += 1;
    return store.saveKnowledgePage({
      projectRoot,
      slug: SLUG,
      idempotencyKey: `section-${saves}`,
      reviewToken,
      ...extra,
    });
  };
  const page = () => {
    const result = store.listKnowledgePages({ projectRoot });
    if (result.outcome !== "knowledge_pages") throw new Error("Expected pages");
    return result.items.find((item) => item.slug === SLUG)!;
  };
  const writtenPage = () => {
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const first = finalize("first");
    const saved = fullSave([section("Hive layout", [first]), section("Winter care", [first])]);
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    return first;
  };
  return {
    store,
    projectRoot,
    otherRoot,
    tick,
    finalize,
    section,
    readToken,
    fullSave,
    sectionSave,
    page,
    writtenPage,
  };
}

describe("checkedThroughSessionId on a section update", () => {
  it("advances the cursor with the write and reports the state after checking", () => {
    const { finalize, section, readToken, sectionSave, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const third = finalize("third");
    const token = readToken();
    const saved = sectionSave(token, {
      upsertSections: [section("Hive layout", [first, second])],
      checkedThroughSessionId: third,
    });
    expect(saved).toMatchObject({
      outcome: "knowledge_page_saved",
      sectionChanges: { replaced: ["Hive layout"] },
      page: { version: 2, status: "fresh", newSessionCount: 0, checkedThrough: { sessionId: third } },
    });
    expect(saved).not.toHaveProperty("warnings");
  });

  it("counts only Sessions after the cursor once it moved", () => {
    const { finalize, section, readToken, sectionSave, page, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    finalize("third");
    const saved = sectionSave(readToken(), {
      upsertSections: [section("Hive layout", [first])],
      checkedThroughSessionId: second,
    });
    expect(saved).toMatchObject({ page: { status: "has_new_data", newSessionCount: 1 } });
    expect(page()).toMatchObject({ newSessionCount: 1, checkedThrough: { sessionId: second } });
  });

  it("writes nothing and returns invalid_cursor for a Session that cannot be a cursor", () => {
    const { store, otherRoot, finalize, section, readToken, sectionSave, page, writtenPage } = setup();
    const first = writtenPage();
    const voided = finalize("voided");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Fictional mistake." });
    const foreign = finalize("foreign", { rootPath: otherRoot });
    const inProgress = finalize("working", { status: "in_progress" });
    const before = page();
    for (const cursor of [voided, foreign, inProgress, "missing-session"]) {
      const result = sectionSave(readToken(), {
        upsertSections: [section("Hive layout", [first], "Changed text.")],
        checkedThroughSessionId: cursor,
      });
      expect(result).toMatchObject({ outcome: "invalid_cursor" });
    }
    expect(page()).toEqual(before);
  });

  it("does not move the cursor backwards", () => {
    const { store, projectRoot, finalize, section, readToken, sectionSave, page, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const third = finalize("third");
    store.markKnowledgePageChecked({ projectRoot, slug: SLUG, throughSessionId: third });
    const result = sectionSave(readToken(), {
      upsertSections: [section("Hive layout", [first], "Changed text.")],
      checkedThroughSessionId: second,
    });
    expect(result).toMatchObject({ outcome: "invalid_cursor", reason: "The review cursor cannot move backwards." });
    expect(page()).toMatchObject({ version: 1, checkedThrough: { sessionId: third } });
  });

  it("keeps the cursor when the field is absent and hints that coverage did not advance", () => {
    const { finalize, section, readToken, sectionSave, page, writtenPage } = setup();
    const first = writtenPage();
    const quiet = sectionSave(readToken(), { upsertSections: [section("Hive layout", [first], "Text one.")] });
    expect(quiet).not.toHaveProperty("warnings");
    finalize("second");
    const saved = sectionSave(readToken(), { upsertSections: [section("Hive layout", [first], "Text two.")] });
    expect(saved).toMatchObject({ page: { status: "has_new_data", newSessionCount: 1 } });
    expect(saved).toHaveProperty("warnings");
    if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected a save");
    expect(saved.warnings).toHaveLength(1);
    expect(saved.warnings![0]!.length).toBeLessThan(160);
    expect(page().checkedThrough).toBeUndefined();
  });

  it("also rejects an in-progress Session in markChecked", () => {
    const { store, projectRoot, finalize, writtenPage } = setup();
    writtenPage();
    const inProgress = finalize("working", { status: "in_progress" });
    expect(store.markKnowledgePageChecked({ projectRoot, slug: SLUG, throughSessionId: inProgress })).toMatchObject({
      outcome: "invalid_cursor",
    });
  });
});

describe("more than 20 sourceSessionIds", () => {
  const manySessions = (finalize: ReturnType<typeof setup>["finalize"], count: number) =>
    Array.from({ length: count }, (_, index) => finalize(`source-${index}`));

  it("keeps the newest 20 in a full save and reports the dropped ones by heading", () => {
    const { store, projectRoot, finalize, section, readToken, fullSave } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const ids = manySessions(finalize, 25);
    const token = readToken();
    const saved = fullSave([section("Hive layout", [...ids].reverse()), section("Winter care", [ids[0]!])], token);
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    expect(saved.page.sections[0]!.sourceSessionIds).toHaveLength(SOURCE_LIMIT);
    expect(new Set(saved.page.sections[0]!.sourceSessionIds)).toEqual(new Set(ids.slice(5)));
    expect(saved.droppedSourceSessionIds).toEqual([{ heading: "Hive layout", sessionIds: ids.slice(0, 5).reverse() }]);
    expect(saved.warnings).toHaveLength(1);
    expect(saved.page.sections[1]!.sourceSessionIds).toEqual([ids[0]]);
  });

  it("breaks a completedAt tie by id", () => {
    const { store, projectRoot, finalize, section, readToken, fullSave } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const ids = Array.from({ length: 23 }, (_, index) =>
      finalize(`tie-${index}`, { completedAt: "2029-12-31T00:00:00.000Z" }),
    );
    const saved = fullSave([section("Hive layout", ids)], readToken());
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    const expected = [...ids].sort((left, right) => right.localeCompare(left)).slice(0, SOURCE_LIMIT);
    expect(new Set(saved.page.sections[0]!.sourceSessionIds)).toEqual(new Set(expected));
    expect(saved.droppedSourceSessionIds![0]!.sessionIds).toHaveLength(3);
  });

  it("applies to upsertSections and keeps the retry of the same save a duplicate", () => {
    const { store, projectRoot, finalize, section, readToken, sectionSave, writtenPage } = setup();
    writtenPage();
    const ids = manySessions(finalize, 22);
    const token = readToken();
    const saved = sectionSave(token, { upsertSections: [section("Winter care", ids)] });
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    expect(saved.droppedSourceSessionIds).toEqual([{ heading: "Winter care", sessionIds: ids.slice(0, 2) }]);
    expect(saved.warnings!.some((warning) => warning.includes("droppedSourceSessionIds"))).toBe(true);
    const retried = store.saveKnowledgePage({
      projectRoot,
      slug: SLUG,
      idempotencyKey: `section-${2}`,
      reviewToken: token,
      upsertSections: [section("Winter care", ids)],
    });
    expect(retried).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true });
  });

  it("still rejects a cited Session that does not exist before trimming", () => {
    const { store, projectRoot, finalize, section, readToken, fullSave } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const ids = manySessions(finalize, 21);
    const result = fullSave([section("Hive layout", [...ids, "unknown-source"])], readToken());
    expect(result).toMatchObject({ outcome: "invalid_sources", sessionIds: ["unknown-source"] });
  });
});

describe("retry material on a refused agent save", () => {
  it("returns a fresh reviewToken and the headings changed since the stale version", () => {
    const { finalize, section, readToken, sectionSave, writtenPage, page } = setup();
    const first = writtenPage();
    const stale = readToken();
    const second = finalize("second");
    const other = sectionSave(stale, {
      upsertSections: [section("Winter care", [second], "Winter care changed."), section("Feeding", [second])],
    });
    expect(other).toMatchObject({ outcome: "knowledge_page_saved" });
    sectionSave(readToken(), { removeHeadings: ["Hive layout"] });
    const conflict = sectionSave(stale, { upsertSections: [section("Hive layout", [first], "My edit.")] });
    expect(conflict).toMatchObject({ outcome: "version_conflict", baseVersion: 1, currentVersion: 3 });
    if (conflict.outcome !== "version_conflict") throw new Error("Expected a conflict");
    expect(conflict.changedHeadings).toEqual(["Winter care", "Feeding", "Hive layout"]);
    const retried = sectionSave(conflict.reviewToken!, {
      upsertSections: [section("Hive layout", [first], "My edit.")],
    });
    expect(retried).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 4 } });
    expect(page().sections.map((item) => item.heading)).toEqual(["Winter care", "Feeding", "Hive layout"]);
  });

  it("returns retry material for a full save with a stale token and leaves optimistic locking in place", () => {
    const { section, readToken, fullSave, sectionSave, writtenPage, page } = setup();
    const first = writtenPage();
    const stale = readToken();
    sectionSave(stale, { upsertSections: [section("Winter care", [first], "Changed.")] });
    const conflict = fullSave([section("Hive layout", [first])], stale);
    expect(conflict).toMatchObject({ outcome: "version_conflict", changedHeadings: ["Winter care"] });
    expect(page().version).toBe(2);
  });

  it("hands no token to a token that is not from this page", () => {
    const { store, projectRoot, section, writtenPage } = setup();
    const first = writtenPage();
    const result = store.saveKnowledgePage({
      projectRoot,
      slug: SLUG,
      idempotencyKey: "bad-token",
      reviewToken: "kpr1.not-a-token",
      upsertSections: [section("Hive layout", [first])],
    });
    expect(result).toMatchObject({ outcome: "invalid_review_token" });
    expect(result).not.toHaveProperty("reviewToken");
  });

  it("hands no token when the coverage position was not a read position", () => {
    const { section, readToken, sectionSave, writtenPage } = setup();
    const first = writtenPage();
    const payload = JSON.parse(Buffer.from(readToken().slice(5), "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const forged = `kpr1.${Buffer.from(JSON.stringify({ ...payload, at: "2031-01-01T00:00:00.000Z", id: "nope" })).toString("base64url")}`;
    const refused = sectionSave(forged, { upsertSections: [section("Hive layout", [first], "Changed.")] });
    expect(refused).toMatchObject({ outcome: "invalid_review_token" });
    expect(refused).not.toHaveProperty("reviewToken");
  });

  it("keeps only the coverage the page had in the retry token", () => {
    const { finalize, section, readToken, sectionSave, writtenPage, page } = setup();
    const first = writtenPage();
    const stale = readToken();
    finalize("second");
    sectionSave(stale, { upsertSections: [section("Winter care", [first], "Changed.")] });
    const conflict = sectionSave(stale, { upsertSections: [section("Hive layout", [first], "Mine.")] });
    if (conflict.outcome !== "version_conflict") throw new Error("Expected a conflict");
    const retried = sectionSave(conflict.reviewToken!, { upsertSections: [section("Hive layout", [first], "Mine.")] });
    expect(retried).toMatchObject({ outcome: "knowledge_page_saved" });
    expect(page().newSessionCount).toBe(1);
  });

  it("gives the Web editor's version_conflict no retry material", () => {
    const { store, section, readToken, sectionSave, page, writtenPage } = setup();
    const first = writtenPage();
    sectionSave(readToken(), { upsertSections: [section("Winter care", [first], "Changed.")] });
    const conflict = store.updateKnowledgePage({
      pageId: page().id,
      sections: [section("Hive layout", [first])],
      baseVersion: 1,
    });
    expect(conflict).toMatchObject({ outcome: "version_conflict" });
    expect(conflict).not.toHaveProperty("reviewToken");
  });
});

describe("in-progress start records are not new Sessions", () => {
  it("leaves counts, the pending queue and the review context alone until the Session completes", () => {
    const { store, projectRoot, finalize, readToken, tick, writtenPage, page } = setup();
    writtenPage();
    for (const key of ["working-1", "working-2", "working-3"]) finalize(key, { status: "in_progress" });
    expect(page()).toMatchObject({ status: "fresh", newSessionCount: 0 });
    const attention = store.getAttention({});
    expect(
      attention.outcome === "attention" && attention.items.filter((item) => item.kind === "knowledge_page"),
    ).toEqual([]);
    const queue = store.getContext(projectRoot);
    expect(queue.outcome === "context" && queue.pendingRequests.knowledgePages).toEqual([]);
    expect(store.getKnowledgePageContext({ projectRoot, slug: SLUG })).toMatchObject({ mode: "review", sessions: [] });
    expect(readToken()).toBeTruthy();

    tick();
    const completed = store.finalizeSession({
      projectRoot,
      idempotencyKey: "working-1",
      title: "Session working-1",
      summary: "working-1 finished.",
      workSummary: { outcomes: ["working-1 outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    expect(completed.outcome).toBe("finalized");
    expect(page()).toMatchObject({ status: "has_new_data", newSessionCount: 1 });
    const context = store.getKnowledgePageContext({ projectRoot, slug: SLUG });
    expect(context).toMatchObject({ mode: "review", sessions: [{ title: "Session working-1" }] });
  });

  it("leaves in-progress Sessions out of the full-rewrite session list", () => {
    const { store, projectRoot, finalize } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const done = finalize("done");
    finalize("working", { status: "in_progress" });
    const context = store.getKnowledgePageContext({ projectRoot, slug: SLUG });
    expect(context).toMatchObject({ mode: "full", sessions: [{ id: done }] });
  });

  it("does not let an earlier start record hide the maintaining Session from acknowledgement", () => {
    const { store, projectRoot, tick, finalize, writtenPage, page } = setup();
    writtenPage();
    finalize("working", { status: "in_progress" });
    tick();
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: "maintaining",
      title: "Session maintaining",
      summary: "maintaining summary.",
      workSummary: { outcomes: ["maintaining outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      maintainedKnowledgePages: [SLUG],
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    expect(result.knowledgePagesAcknowledged).toEqual([SLUG]);
    expect(page()).toMatchObject({ status: "fresh", newSessionCount: 0 });
  });
});

describe("replaying a section save", () => {
  const upsert = (section: ReturnType<typeof setup>["section"], first: string) => ({
    upsertSections: [section("Hive layout", [first], "Changed.")],
  });

  it("applies checkedThroughSessionId that a first call without it left out", () => {
    const { store, projectRoot, finalize, section, readToken, page, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const token = readToken();
    const base = { projectRoot, slug: SLUG, idempotencyKey: "same-key", reviewToken: token, ...upsert(section, first) };
    const initial = store.saveKnowledgePage(base);
    expect(initial).toMatchObject({ duplicate: false, warnings: [expect.stringContaining("checkedThroughSessionId")] });
    const replay = store.saveKnowledgePage({ ...base, checkedThroughSessionId: second });
    expect(replay).toMatchObject({
      outcome: "knowledge_page_saved",
      duplicate: true,
      page: { status: "fresh", newSessionCount: 0, checkedThrough: { sessionId: second } },
    });
    expect(replay).not.toHaveProperty("warnings");
    expect(page().version).toBe(2);
  });

  it("repeats the coverage hint on a plain replay", () => {
    const { store, projectRoot, finalize, section, readToken, writtenPage } = setup();
    const first = writtenPage();
    finalize("second");
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      ...upsert(section, first),
    };
    store.saveKnowledgePage(base);
    expect(store.saveKnowledgePage(base)).toMatchObject({
      duplicate: true,
      warnings: [expect.stringContaining("checkedThroughSessionId")],
    });
  });

  it("repeats warnings and droppedSourceSessionIds for trimmed sources, in full and section saves", () => {
    const { store, projectRoot, finalize, section, readToken, writtenPage } = setup();
    writtenPage();
    const ids = Array.from({ length: 23 }, (_, index) => finalize(`source-${index}`));
    const sectionBase = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      checkedThroughSessionId: ids.at(-1)!,
      upsertSections: [section("Winter care", ids)],
    };
    store.saveKnowledgePage(sectionBase);
    const replay = store.saveKnowledgePage(sectionBase);
    expect(replay).toMatchObject({
      duplicate: true,
      droppedSourceSessionIds: [{ heading: "Winter care", sessionIds: ids.slice(0, 3) }],
      warnings: [expect.stringContaining("droppedSourceSessionIds")],
    });
    const fullBase = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "full-key",
      reviewToken: readToken(),
      sections: [section("Winter care", ids)],
    };
    store.saveKnowledgePage(fullBase);
    expect(store.saveKnowledgePage(fullBase)).toMatchObject({
      duplicate: true,
      droppedSourceSessionIds: [{ heading: "Winter care", sessionIds: ids.slice(0, 3) }],
    });
  });

  it("stays a duplicate when a dropped in-progress source completes after the save", () => {
    const { store, projectRoot, tick, finalize, section, readToken, writtenPage } = setup();
    writtenPage();
    const early = finalize("early", { status: "in_progress" });
    const ids = [early, ...Array.from({ length: 20 }, (_, index) => finalize(`source-${index}`))];
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: [section("Winter care", ids)],
    };
    const saved = store.saveKnowledgePage(base);
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    expect(saved.droppedSourceSessionIds).toEqual([{ heading: "Winter care", sessionIds: [early] }]);
    tick();
    store.finalizeSession({
      projectRoot,
      idempotencyKey: "early",
      title: "Session early",
      summary: "early finished.",
      workSummary: { outcomes: ["early outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    expect(store.saveKnowledgePage(base)).toMatchObject({
      duplicate: true,
      droppedSourceSessionIds: [{ heading: "Winter care", sessionIds: [early] }],
    });
  });
});

describe("replaying a save whose cursor has moved on", () => {
  const sectionOf = (section: ReturnType<typeof setup>["section"], first: string) => [
    section("Hive layout", [first], "Changed."),
  ];

  it("stays a duplicate when the cursor is already past the replayed one", () => {
    const { store, projectRoot, finalize, section, readToken, page, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const third = finalize("third");
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: sectionOf(section, first),
      checkedThroughSessionId: second,
    };
    expect(store.saveKnowledgePage(base)).toMatchObject({ duplicate: false });
    store.markKnowledgePageChecked({ projectRoot, slug: SLUG, throughSessionId: third });
    const replay = store.saveKnowledgePage(base);
    expect(replay).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true });
    expect(replay).not.toHaveProperty("warnings");
    expect(page().checkedThrough?.sessionId).toBe(third);
  });

  it("stays a duplicate when the replayed cursor was voided after the cursor had passed it", () => {
    const { store, projectRoot, finalize, section, readToken, page, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: sectionOf(section, first),
      checkedThroughSessionId: second,
    };
    store.saveKnowledgePage(base);
    store.setSessionVoid({ sessionId: second, voided: true, reason: "Fictional mistake." });
    const replay = store.saveKnowledgePage(base);
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay).not.toHaveProperty("warnings");
    expect(page()).toMatchObject({ version: 2 });
  });

  it("keeps the saved receipt with a warning when a behind cursor is no longer valid", () => {
    const { store, projectRoot, finalize, section, readToken, writtenPage } = setup();
    const first = writtenPage();
    const second = finalize("second");
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: sectionOf(section, first),
    };
    store.saveKnowledgePage(base);
    store.setSessionVoid({ sessionId: second, voided: true, reason: "Fictional mistake." });
    const replay = store.saveKnowledgePage({ ...base, checkedThroughSessionId: second });
    expect(replay).toMatchObject({
      outcome: "knowledge_page_saved",
      duplicate: true,
      warnings: [expect.stringContaining("not advanced")],
    });
  });
});

describe("replaying a save with a changed source list", () => {
  const exactlyTwenty = (finalize: ReturnType<typeof setup>["finalize"]) =>
    Array.from({ length: 20 }, (_, index) => finalize(`source-${index}`));

  it("refuses a retry that adds a newer source the first save would have kept", () => {
    const { store, projectRoot, finalize, section, readToken, writtenPage } = setup();
    writtenPage();
    const ids = exactlyTwenty(finalize);
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: [section("Winter care", ids)],
    };
    expect(store.saveKnowledgePage(base)).toMatchObject({ duplicate: false });
    const newer = finalize("newer");
    const retry = store.saveKnowledgePage({ ...base, upsertSections: [section("Winter care", [...ids, newer])] });
    expect(retry).toMatchObject({ outcome: "idempotency_conflict" });
  });

  it("accepts a retry whose extra source is older than every stored one", () => {
    const { store, projectRoot, finalize, section, readToken, writtenPage } = setup();
    const oldest = writtenPage();
    const ids = exactlyTwenty(finalize);
    const base = {
      projectRoot,
      slug: SLUG,
      idempotencyKey: "same-key",
      reviewToken: readToken(),
      upsertSections: [section("Winter care", ids)],
    };
    store.saveKnowledgePage(base);
    const retry = store.saveKnowledgePage({ ...base, upsertSections: [section("Winter care", [oldest, ...ids])] });
    expect(retry).toMatchObject({
      duplicate: true,
      droppedSourceSessionIds: [{ heading: "Winter care", sessionIds: [oldest] }],
    });
  });
});

describe("ranking trimmed sources", () => {
  it("drops in-progress start records first", () => {
    const { store, projectRoot, finalize, section, readToken, fullSave } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SLUG });
    const ids = Array.from({ length: 20 }, (_, index) => finalize(`done-${index}`));
    const working = finalize("working", { status: "in_progress" });
    const saved = fullSave([section("Hive layout", [working, ...ids])], readToken());
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    expect(saved.droppedSourceSessionIds).toEqual([{ heading: "Hive layout", sessionIds: [working] }]);
  });
});
