import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageSection } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const SEED = 4401;
const SEQUENCE_STEPS = 400;
const INVALID_FIX = "work_get_knowledge_page_context";

interface RawCoverage {
  version: number;
  covered_through_completed_at: string | null;
  covered_through_session_id: string | null;
}

interface TokenPayload {
  p: string;
  v: number;
  at: string;
  id?: string;
}

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function decodeToken(token: string): TokenPayload {
  return JSON.parse(Buffer.from(token.slice("kpr1.".length), "base64url").toString("utf8")) as TokenPayload;
}

function encodeToken(payload: TokenPayload): string {
  return `kpr1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function withoutId(payload: TokenPayload): TokenPayload {
  const { id: _id, ...rest } = payload;
  return rest;
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-review-token-"));
  tempDirs.push(root);
  const projectRoot = join(root, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  store.updateProject(store.addProject("Apiary", projectRoot).id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const db = (store as unknown as { db: DatabaseSync }).db;
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  let counter = 0;
  const finalize = (label = "session") => {
    tick();
    counter += 1;
    const key = `${label}-${counter}`;
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [`${key} outcome`], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return { id: result.session.id, completedAt: result.session.completedAt };
  };
  const readToken = (slug = "architecture") => {
    const result = store.getKnowledgePageContext({ projectRoot, slug });
    if (result.outcome !== "knowledge_page_context") throw new Error("Expected a knowledge page context");
    return result.reviewToken;
  };
  const sections = (sessionId: string, content = "Queen excluders go on first."): KnowledgePageSection[] => [
    { heading: "Hive layout", content, sourceSessionIds: [sessionId] },
    { heading: "Winter care", content: "資料不足", sourceSessionIds: [] },
  ];
  let saves = 0;
  const fullSave = (sessionId: string, reviewToken?: string, slug = "architecture") => {
    saves += 1;
    return store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: `full-${saves}`,
      sections: sections(sessionId, `Version ${saves}.`),
      ...(reviewToken === undefined ? {} : { reviewToken }),
    });
  };
  const sectionSave = (reviewToken: string, slug = "architecture") => {
    saves += 1;
    return store.saveKnowledgePage({
      projectRoot,
      slug,
      idempotencyKey: `section-${saves}`,
      upsertSections: [{ heading: "Feeding", content: `Feed syrup ${saves}.`, sourceSessionIds: [] }],
      reviewToken,
    });
  };
  const raw = (slug = "architecture") =>
    db
      .prepare(
        `SELECT version, covered_through_completed_at, covered_through_session_id
         FROM knowledge_pages WHERE slug = ?`,
      )
      .get(slug) as unknown as RawCoverage;
  const newIds = (slug = "architecture") => {
    const result = store.getKnowledgePageContext({ projectRoot, slug });
    if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
      throw new Error("Expected a default context");
    }
    return result.sessions.map((session) => session.id);
  };
  const versionCount = () =>
    (db.prepare("SELECT COUNT(*) AS count FROM knowledge_page_versions").get() as { count: number }).count;
  const writtenPage = () => {
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const first = finalize("first");
    const saved = fullSave(first.id, readToken());
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    return { first, saved };
  };
  return {
    store,
    db,
    projectRoot,
    tick,
    finalize,
    readToken,
    fullSave,
    sectionSave,
    raw,
    newIds,
    versionCount,
    writtenPage,
    sections,
  };
}

describe("reviewToken coverage point", () => {
  it("saves with a legal token and covers exactly the Session the read ended on", () => {
    const { store, projectRoot, finalize, readToken, fullSave, raw, writtenPage } = setup();
    const { first } = writtenPage();
    expect(raw()).toMatchObject({
      covered_through_completed_at: first.completedAt,
      covered_through_session_id: first.id,
    });
    const shown = finalize("shown");
    const token = readToken();
    finalize("after-read");
    expect(fullSave(shown.id, token)).toMatchObject({ outcome: "knowledge_page_saved", page: { version: 2 } });
    expect(raw()).toMatchObject({ covered_through_session_id: shown.id });
    expect(store.listKnowledgePages({ projectRoot })).toMatchObject({
      items: [expect.objectContaining({ newSessionCount: 1 })],
    });
  });

  it("refuses a token from another page without writing", () => {
    const { store, projectRoot, finalize, readToken, fullSave, sectionSave, versionCount, writtenPage } = setup();
    const { first } = writtenPage();
    store.requestKnowledgePageUpdate({ projectRoot, slug: "pitfalls" });
    finalize("other-page-read");
    const foreign = readToken("pitfalls");
    const before = versionCount();
    expect(fullSave(first.id, foreign)).toMatchObject({ outcome: "invalid_review_token" });
    expect(sectionSave(foreign)).toMatchObject({ outcome: "invalid_review_token" });
    expect(versionCount()).toBe(before);
  });

  it("answers version_conflict before judging the coverage point of a stale token", () => {
    const { finalize, readToken, fullSave, sectionSave, versionCount, writtenPage, raw } = setup();
    const { first } = writtenPage();
    finalize("shown");
    const stale = readToken();
    expect(fullSave(first.id, stale)).toMatchObject({ outcome: "knowledge_page_saved" });
    const tampered = encodeToken({ ...decodeToken(stale), at: "2031-01-01T00:00:00.000Z" });
    const before = { versions: versionCount(), coverage: raw() };
    expect(fullSave(first.id, stale)).toMatchObject({ outcome: "version_conflict", baseVersion: 1, currentVersion: 2 });
    expect(fullSave(first.id, tampered)).toMatchObject({ outcome: "version_conflict" });
    expect(sectionSave(tampered)).toMatchObject({ outcome: "version_conflict" });
    expect({ versions: versionCount(), coverage: raw() }).toEqual(before);
  });

  it("does not count Sessions the Agent never read when it saves without a token", () => {
    const { store, projectRoot, finalize, fullSave, newIds, raw, writtenPage } = setup();
    const { first } = writtenPage();
    const covered = raw();
    const unseen = finalize("unseen");
    const saved = fullSave(first.id);
    expect(saved).toMatchObject({
      outcome: "knowledge_page_saved",
      warnings: [expect.stringContaining("no check for a newer page version")],
      page: { version: 2, newSessionCount: 1 },
    });
    expect(raw()).toMatchObject({
      covered_through_completed_at: covered.covered_through_completed_at,
      covered_through_session_id: covered.covered_through_session_id,
    });
    expect(newIds()).toEqual([unseen.id]);
    expect(store.listKnowledgePages({ projectRoot })).toMatchObject({
      items: [expect.objectContaining({ status: "has_new_data" })],
    });
  });

  it("keeps a brand-new page uncovered when it is first saved without a token", () => {
    const { store, projectRoot, finalize, fullSave, newIds, raw } = setup();
    const early = finalize("early");
    const late = finalize("late");
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    expect(fullSave(early.id)).toMatchObject({ outcome: "knowledge_page_saved", warnings: [expect.any(String)] });
    expect(raw()).toMatchObject({ covered_through_completed_at: "", covered_through_session_id: null });
    expect(newIds()).toEqual([early.id, late.id]);
  });

  it("refuses a token whose time was changed", () => {
    const { finalize, readToken, fullSave, sectionSave, versionCount, raw, writtenPage } = setup();
    const { first } = writtenPage();
    finalize("shown");
    const payload = decodeToken(readToken());
    const before = { versions: versionCount(), coverage: raw() };
    for (const at of ["2031-06-01T00:00:00.000Z", "2029-06-01T00:00:00.000Z", "not a time"]) {
      const tampered = encodeToken({ ...payload, at });
      expect(fullSave(first.id, tampered)).toMatchObject({ outcome: "invalid_review_token" });
      expect(sectionSave(tampered)).toMatchObject({ outcome: "invalid_review_token" });
    }
    expect({ versions: versionCount(), coverage: raw() }).toEqual(before);
  });

  it("refuses a token whose Session id was changed or removed", () => {
    const { finalize, readToken, fullSave, sectionSave, versionCount, raw, writtenPage } = setup();
    const { first } = writtenPage();
    finalize("shown");
    const payload = decodeToken(readToken());
    const before = { versions: versionCount(), coverage: raw() };
    for (const tampered of [
      encodeToken({ ...payload, id: "no-such-session" }),
      encodeToken(withoutId(payload)),
      encodeToken({ ...payload, id: first.id }),
    ]) {
      expect(fullSave(first.id, tampered)).toMatchObject({ outcome: "invalid_review_token" });
      expect(sectionSave(tampered)).toMatchObject({ outcome: "invalid_review_token" });
    }
    expect({ versions: versionCount(), coverage: raw() }).toEqual(before);
  });

  it("refuses a real Session id paired with another Session's completion time", () => {
    const { finalize, readToken, fullSave, sectionSave, versionCount, raw, writtenPage } = setup();
    const { first } = writtenPage();
    const shown = finalize("shown");
    const payload = decodeToken(readToken());
    const before = { versions: versionCount(), coverage: raw() };
    const mismatched = encodeToken({ ...payload, at: first.completedAt, id: shown.id });
    expect(fullSave(first.id, mismatched)).toMatchObject({ outcome: "invalid_review_token" });
    expect(sectionSave(mismatched)).toMatchObject({ outcome: "invalid_review_token" });
    expect({ versions: versionCount(), coverage: raw() }).toEqual(before);
  });

  it("refuses a point that names a voided Session", () => {
    const { store, finalize, readToken, fullSave, versionCount, writtenPage } = setup();
    const { first } = writtenPage();
    const shown = finalize("shown");
    const token = readToken();
    store.setSessionVoid({ sessionId: shown.id, voided: true, reason: "Recorded by mistake." });
    const before = versionCount();
    const result = fullSave(first.id, token);
    expect(result).toMatchObject({ outcome: "invalid_review_token", fix: expect.stringContaining(INVALID_FIX) });
    expect(versionCount()).toBe(before);
  });

  it("names the reason and the fix in the refusal", () => {
    const { finalize, readToken, fullSave, writtenPage } = setup();
    const { first } = writtenPage();
    finalize("shown");
    const tampered = encodeToken({ ...decodeToken(readToken()), id: "no-such-session" });
    expect(fullSave(first.id, tampered)).toEqual({
      outcome: "invalid_review_token",
      reason:
        "reviewToken does not point at a Session position this page can have been read at, so nothing was written.",
      fix: "Read the page again with work_get_knowledge_page_context and save with the reviewToken it returns, unchanged.",
    });
  });

  it("keeps a Session finalized after the read new when saving with the old token", () => {
    const { finalize, readToken, fullSave, newIds, writtenPage } = setup();
    const { first } = writtenPage();
    const shown = finalize("shown");
    const token = readToken();
    const afterRead = finalize("after-read");
    expect(fullSave(first.id, token)).toMatchObject({ outcome: "knowledge_page_saved", page: { newSessionCount: 1 } });
    expect(newIds()).toEqual([afterRead.id]);
    expect(newIds()).not.toContain(shown.id);
  });

  it("answers an identical resend as a duplicate and never moves coverage backwards", () => {
    const { store, projectRoot, finalize, readToken, raw, versionCount, writtenPage, sections } = setup();
    const { first } = writtenPage();
    const shown = finalize("shown");
    const token = readToken();
    const request = {
      projectRoot,
      slug: "architecture",
      idempotencyKey: "resend",
      sections: sections(first.id, "Resent."),
      reviewToken: token,
    };
    expect(store.saveKnowledgePage(request)).toMatchObject({ outcome: "knowledge_page_saved", duplicate: false });
    const covered = raw();
    expect(covered).toMatchObject({ covered_through_session_id: shown.id });
    finalize("later");
    const versions = versionCount();
    expect(store.saveKnowledgePage(request)).toMatchObject({ outcome: "knowledge_page_saved", duplicate: true });
    expect(raw()).toEqual(covered);
    expect(versionCount()).toBe(versions);
  });

  it("keeps the review cursor when an older legal token saves after a check", () => {
    const { store, projectRoot, finalize, readToken, fullSave, raw, writtenPage } = setup();
    const { first } = writtenPage();
    const second = finalize("second");
    const token = readToken();
    expect(decodeToken(token).id).toBe(second.id);
    const third = finalize("third");
    expect(
      store.markKnowledgePageChecked({ projectRoot, slug: "architecture", throughSessionId: third.id }),
    ).toMatchObject({
      outcome: "knowledge_page_checked",
    });
    expect(fullSave(first.id, token)).toMatchObject({ outcome: "knowledge_page_saved" });
    expect(raw()).toMatchObject({ covered_through_session_id: third.id });
  });

  it("keeps Web manual edits covering every Session finished before the edit", () => {
    const { store, projectRoot, finalize, newIds, raw, sections, writtenPage } = setup();
    const { first } = writtenPage();
    finalize("unread-one");
    finalize("unread-two");
    const page = store.listKnowledgePages({ projectRoot });
    if (page.outcome !== "knowledge_pages") throw new Error("Expected pages");
    expect(page.items[0]).toMatchObject({ newSessionCount: 2 });
    const edited = store.updateKnowledgePage({
      pageId: page.items[0]!.id,
      sections: sections(first.id, "Edited by hand."),
      baseVersion: 1,
    });
    expect(edited).toMatchObject({ outcome: "knowledge_page_updated", page: { newSessionCount: 0, status: "fresh" } });
    expect(raw()).toMatchObject({ covered_through_completed_at: null, covered_through_session_id: null });
    expect(newIds()).toEqual([]);
  });

  it("applies the same checks to section updates and keeps their coverage", () => {
    const { finalize, readToken, sectionSave, versionCount, raw, newIds, writtenPage } = setup();
    const { first } = writtenPage();
    const shown = finalize("shown");
    const token = readToken();
    const afterRead = finalize("after-read");
    const covered = raw();
    const before = versionCount();

    expect(sectionSave(encodeToken({ ...decodeToken(token), id: "no-such-session" }))).toMatchObject({
      outcome: "invalid_review_token",
    });
    expect(sectionSave(encodeToken({ ...decodeToken(token), at: first.completedAt }))).toMatchObject({
      outcome: "invalid_review_token",
    });
    expect(versionCount()).toBe(before);

    expect(sectionSave(token)).toMatchObject({
      outcome: "knowledge_page_saved",
      sectionChanges: { added: ["Feeding"] },
    });
    expect(versionCount()).toBe(before + 1);
    expect(raw()).toMatchObject({
      covered_through_completed_at: covered.covered_through_completed_at,
      covered_through_session_id: first.id,
    });
    expect(newIds()).toEqual([shown.id, afterRead.id]);
  });
});

describe("reviewToken operation sequence", () => {
  it("keeps coverage on real Sessions and never covers what an Agent save was not shown", () => {
    const random = seededRandom(SEED);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const { store, db, projectRoot, tick, finalize, readToken, fullSave, sectionSave, raw, versionCount } = setup();
    store.requestKnowledgePageUpdate({ projectRoot, slug: "architecture" });
    const live = new Map<string, { completedAt: string; voided: boolean }>();
    const reads: { token: string; readPoint?: { completedAt: string; id: string }; version: number }[] = [];
    let saves = 0;
    let invalid = 0;
    let moved = 0;

    const sessionRows = () =>
      db.prepare("SELECT id, completed_at, voided_at FROM sessions ORDER BY completed_at, id").all() as unknown as {
        id: string;
        completed_at: string;
        voided_at: string | null;
      }[];
    const pageState = () => {
      const page = db
        .prepare("SELECT * FROM knowledge_pages WHERE slug = 'architecture'")
        .get() as unknown as RawCoverage & {
        sections_json: string;
        checked_through_session_id: string | null;
      };
      return JSON.stringify(page);
    };
    const newestLive = () => [...live.entries()].filter(([, value]) => !value.voided).at(-1)?.[0];
    const checkInvariants = (step: number) => {
      const coverage = raw();
      const at = coverage.covered_through_completed_at;
      const id = coverage.covered_through_session_id;
      if (at === null || at === "") return;
      expect(id, `step ${step}: coverage carries a Session`).not.toBeNull();
      const row = sessionRows().find((session) => session.id === id);
      expect(row, `step ${step}: coverage names a real Session`).toBeDefined();
      expect(row?.completed_at, `step ${step}: coverage time matches its Session`).toBe(at);
    };

    for (let step = 0; step < SEQUENCE_STEPS; step += 1) {
      const action = pick([
        "finalize",
        "finalize",
        "read",
        "read",
        "save-real",
        "save-real",
        "save-tampered",
        "save-stale",
        "save-none",
        "section-real",
        "section-tampered",
        "void",
      ] as const);
      const before = { page: pageState(), versions: versionCount() };
      const coverageBefore = raw();

      if (action === "finalize") {
        const created = finalize("sequence");
        live.set(created.id, { completedAt: created.completedAt, voided: false });
      } else if (action === "read") {
        const token = readToken();
        const payload = decodeToken(token);
        reads.push({
          token,
          version: payload.v,
          ...(payload.id ? { readPoint: { completedAt: payload.at, id: payload.id } } : {}),
        });
      } else if (action === "void") {
        const target = pick([...live.keys(), "none"]);
        if (target !== "none") {
          tick();
          const entry = live.get(target)!;
          store.setSessionVoid({ sessionId: target, voided: !entry.voided, reason: "Sequence fixture." });
          live.set(target, { ...entry, voided: !entry.voided });
        }
      } else if (action === "save-none") {
        const anchor = newestLive();
        if (anchor) {
          saves += 1;
          const result = fullSave(anchor);
          expect(["knowledge_page_saved", "invalid_sources"]).toContain(result.outcome);
          if (result.outcome === "knowledge_page_saved") {
            expect(raw().covered_through_session_id).toBe(coverageBefore.covered_through_session_id);
            expect(raw().covered_through_completed_at).toBe(coverageBefore.covered_through_completed_at ?? "");
          }
        }
      } else {
        const anchor = newestLive();
        const current = reads.at(-1);
        if (anchor && current) {
          const read = action === "save-stale" ? pick(reads) : current;
          const payload = decodeToken(read.token);
          const token =
            action === "save-tampered" || action === "section-tampered"
              ? encodeToken(
                  pick([
                    { ...payload, at: `${payload.at}x` },
                    { ...payload, id: `${payload.id ?? "none"}-forged` },
                    withoutId({ ...payload, at: payload.at || "2030-01-01T00:00:00.000Z" }),
                  ]),
                )
              : read.token;
          saves += 1;
          const result = action.startsWith("section") ? sectionSave(token) : fullSave(anchor, token);
          if (result.outcome === "invalid_review_token") {
            invalid += 1;
            expect(pageState(), `step ${step}: an invalid token changes nothing`).toBe(before.page);
            expect(versionCount()).toBe(before.versions);
          } else if (result.outcome === "knowledge_page_saved") {
            expect(action === "save-tampered" || action === "section-tampered").toBe(false);
            if (action.startsWith("save") && read.readPoint) {
              const covered = raw();
              const readAt = read.readPoint.completedAt;
              const coveredAt = covered.covered_through_completed_at!;
              const reviewedBefore = coverageBefore.covered_through_completed_at ?? "";
              expect(
                coveredAt <= readAt || coveredAt <= reviewedBefore,
                `step ${step}: an Agent save covers nothing finalized after its read`,
              ).toBe(true);
              if (coveredAt !== reviewedBefore) moved += 1;
            }
          } else {
            expect(["version_conflict", "invalid_sources"]).toContain(result.outcome);
            expect(pageState()).toBe(before.page);
          }
        }
      }
      checkInvariants(step);
    }

    expect(saves).toBeGreaterThan(50);
    expect(invalid).toBeGreaterThan(10);
    expect(moved).toBeGreaterThan(5);
  });
});
