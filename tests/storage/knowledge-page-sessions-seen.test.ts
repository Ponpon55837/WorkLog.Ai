import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgePageContext,
  KnowledgePageContextResult,
  KnowledgePageContextSession,
  KnowledgePageReviewContext,
} from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const FIRST = "architecture";
const SECOND = "pitfalls";
const THIRD = "in-progress";
const CONTEXT_BUDGET = 12_000;
const TOKEN_LIMIT = 1_000;

type Read = KnowledgePageContext | KnowledgePageReviewContext;

function plainRead(result: KnowledgePageContextResult): KnowledgePageContext {
  if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
    throw new Error(`Expected a plain read, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}

function reviewOnlyRead(result: KnowledgePageContextResult): KnowledgePageReviewContext {
  if (result.outcome !== "knowledge_page_context" || !("reviewOnly" in result) || "mode" in result) {
    throw new Error(`Expected a reviewOnly read, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}

function previews(read: Read): KnowledgePageContextSession[] {
  return read.sessions.map((session) => {
    if ("previewSeen" in session) throw new Error("Expected a preview, found a stub");
    return session;
  });
}

function stubIds(read: Read): string[] {
  return read.sessions.filter((session) => "previewSeen" in session).map((session) => session.id);
}

function restored<T extends Read>(read: T, shown: Read): T {
  const byId = new Map(previews(shown).map((session) => [session.id, session]));
  return {
    ...read,
    sessions: read.sessions.map((session) =>
      "previewSeen" in session ? { ...byId.get(session.id)!, reasons: session.reasons } : session,
    ),
    reviewToken: "",
  };
}

function decodeToken(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.slice("kpr1.".length), "base64url").toString("utf8")) as Record<string, unknown>;
}

function encodeToken(payload: Record<string, unknown>): string {
  return `kpr1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function withoutWindow(token: string): string {
  const { fi: _fi, n: _n, m: _m, d: _d, ...rest } = decodeToken(token);
  return encodeToken(rest);
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-sessions-seen-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const db = (store as unknown as { db: DatabaseSync }).db;
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const track = (name: string) => {
    const projectRoot = join(root, name);
    mkdirSync(projectRoot);
    store.updateProject(store.addProject(name, projectRoot).id, { status: "tracked" });
    return projectRoot;
  };
  const projectRoot = track("apiary");
  const finalize = (
    key: string,
    options: { root?: string; outcome?: string; files?: string[]; completedAt?: string; advance?: boolean } = {},
  ) => {
    if (options.advance !== false) tick();
    const outcome = options.outcome ?? `${key} outcome`;
    const result = store.finalizeSession({
      projectRoot: options.root ?? projectRoot,
      idempotencyKey: `${options.root ?? ""}${key}`,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [outcome], scope: [], decisions: [outcome], verification: [], nextSteps: [outcome] },
      changedFiles: options.files ?? ["src/hive.ts"],
      verification: { status: "passed" },
      ...(options.completedAt ? { completedAt: options.completedAt } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const read = (
    slug: string,
    extra: { sessionsSeenIn?: string; reviewOnly?: boolean; query?: string } = {},
    at = projectRoot,
  ) => store.getKnowledgePageContext({ projectRoot: at, slug, ...extra });
  const plain = (slug: string, seenIn?: string, at = projectRoot) =>
    plainRead(read(slug, seenIn === undefined ? {} : { sessionsSeenIn: seenIn }, at));
  const reviewOnly = (slug: string, seenIn?: string, at = projectRoot) =>
    reviewOnlyRead(read(slug, { reviewOnly: true, ...(seenIn === undefined ? {} : { sessionsSeenIn: seenIn }) }, at));
  const writePage = (slug: string, at = projectRoot) => {
    store.requestKnowledgePageUpdate({ projectRoot: at, slug });
    const context = plain(slug, undefined, at);
    const idOf = (key: string) => context.sessions.find((session) => session.title === `Session ${key}`)?.id;
    const saved = store.saveKnowledgePage({
      projectRoot: at,
      slug,
      idempotencyKey: `write-${at}-${slug}`,
      reviewToken: context.reviewToken,
      sections: ["base", "topic-1", "topic-2", "topic-3", "topic-4"].map((key) => ({
        heading: key,
        content: `${key}: ${"The recorded fictional rule stays short and cites its source. ".repeat(6)}`,
        sourceSessionIds: [idOf(key)!],
      })),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    tick();
  };
  return { store, db, projectRoot, track, tick, finalize, read, plain, reviewOnly, writePage };
}

function seedBase(context: ReturnType<typeof setup>, root?: string) {
  for (const topic of [1, 2, 3, 4]) context.finalize(`topic-${topic}`, { root, files: [`src/topic-${topic}.ts`] });
  context.finalize("base", { root });
}

function pages(slugs = [FIRST, SECOND, THIRD]) {
  const context = setup();
  seedBase(context);
  for (const slug of slugs) context.writePage(slug);
  const ids = ["n1", "n2", "n3"].map((key) => context.finalize(key));
  context.tick();
  return { ...context, ids };
}

describe("sessionsSeenIn on plain reads", () => {
  it("returns a stub for each new Session the token's read already showed", () => {
    const { ids, plain } = pages();
    const token = plain(FIRST).reviewToken;

    const second = plain(SECOND, token);

    expect(second.mode).toBe("review");
    expect(second.sessions).toEqual(
      ids.map((id, index) => ({ id, title: `Session n${index + 1}`, reasons: ["new"], previewSeen: true })),
    );
    expect(second.warnings).toBeUndefined();
  });

  it("is the same response as a plain read once each stub gets the first read's preview", () => {
    const { plain } = pages();
    const first = plain(FIRST);

    const deduped = plain(SECOND, first.reviewToken);

    expect(stubIds(deduped)).toHaveLength(3);
    expect(restored(deduped, first)).toEqual({ ...plain(SECOND), reviewToken: "" });
    const { at, id } = decodeToken(deduped.reviewToken);
    expect({ at, id }).toEqual({
      at: decodeToken(plain(SECOND).reviewToken).at,
      id: decodeToken(plain(SECOND).reviewToken).id,
    });
  });

  it("keeps a preview for a Session before the window and one finished after the read", () => {
    const context = setup();
    seedBase(context);
    context.writePage(SECOND);
    const early = context.finalize("early");
    context.writePage(FIRST);
    const inside = context.finalize("inside");
    context.tick();
    const { reviewToken } = context.plain(FIRST);
    const late = context.finalize("late");

    const second = context.plain(SECOND, reviewToken);

    expect(second.sessions.map((session) => [session.id, "previewSeen" in session])).toEqual([
      [early, false],
      [inside, true],
      [late, false],
    ]);
  });

  it("keeps the preview of a Session that is new and also a changed cited source", () => {
    const context = setup();
    seedBase(context);
    context.writePage(FIRST);
    context.writePage(SECOND);
    const ids = ["n1", "n2"].map((key) => context.finalize(key));
    context.tick();
    const saved = context.store.saveKnowledgePage({
      projectRoot: context.projectRoot,
      slug: SECOND,
      idempotencyKey: "cite-new",
      reviewToken: context.plain(SECOND).reviewToken,
      upsertSections: [{ heading: "Feeding", content: "Feed syrup.", sourceSessionIds: [ids[0]!] }],
    });
    expect(saved.outcome).toBe("knowledge_page_saved");
    context.tick();
    context.store.updateSessionWorkSummary({
      sessionId: ids[0]!,
      idempotencyKey: "change-cited",
      mode: "patch",
      workSummary: { outcomes: ["Changed after the save."] },
    });
    context.tick();
    const { reviewToken } = context.plain(FIRST);

    const second = context.plain(SECOND, reviewToken);

    expect(second.sessions.map((session) => [session.id, "previewSeen" in session, session.reasons])).toEqual([
      [ids[0], false, ["new", "source_changed"]],
      [ids[1], true, ["new"]],
    ]);
  });

  it("counts stubs against the Session budget", () => {
    const context = setup();
    seedBase(context);
    context.writePage(FIRST);
    context.writePage(SECOND);
    const outcome = "Long outcome. ".repeat(20);
    for (let index = 0; index < 59; index += 1) context.finalize(`bulk-${index}`, { outcome });
    context.tick();
    const first = context.plain(FIRST);
    const plainSecond = context.plain(SECOND);

    const second = context.plain(SECOND, first.reviewToken);

    expect(first.truncated).toBe(true);
    expect(stubIds(second)).toHaveLength(first.sessions.length);
    expect(second.sessions.length).toBeGreaterThan(plainSecond.sessions.length);
    expect(second.truncated).toBe(true);
    expect(JSON.stringify(second.sessions).length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(JSON.stringify(second.sessions).length).toBeGreaterThan(CONTEXT_BUDGET - 2_000);
  });

  it("issues a token well under the schema limit", () => {
    const { plain } = pages();

    expect(plain(FIRST).reviewToken.length).toBeLessThan(TOKEN_LIMIT / 2);
  });
});

describe("sessionsSeenIn with reviewOnly", () => {
  it("stubs the new Sessions a plain read showed", () => {
    const { ids, plain, reviewOnly } = pages();
    const first = plain(FIRST);

    const second = reviewOnly(SECOND, first.reviewToken);

    expect(stubIds(second)).toEqual(ids);
    expect(second.warnings).toBeUndefined();
    expect(restored(second, first)).toEqual({ ...reviewOnly(SECOND), reviewToken: "" });
  });

  it("issues a window when it shows previews, so a plain read can use its token", () => {
    const { ids, plain, reviewOnly } = pages();
    const first = reviewOnly(FIRST);

    const second = plain(SECOND, first.reviewToken);

    expect(first.sessions.map((session) => session.id)).toEqual(ids);
    expect(stubIds(second)).toEqual(ids);
    expect(restored(second, first)).toEqual({ ...plain(SECOND), reviewToken: "" });
  });

  it("dedupes a chain of reviewOnly reads that all use the first token", () => {
    const { ids, reviewOnly } = pages();
    const first = reviewOnly(FIRST);

    const second = reviewOnly(SECOND, first.reviewToken);
    const third = reviewOnly(THIRD, first.reviewToken);

    expect(stubIds(second)).toEqual(ids);
    expect(stubIds(third)).toEqual(ids);
    expect(restored(third, first)).toEqual({ ...reviewOnly(THIRD), reviewToken: "" });
  });

  it("does not let a deduped read's token vouch for the stubs, and says so", () => {
    const { reviewOnly } = pages();
    const second = reviewOnly(SECOND, reviewOnly(FIRST).reviewToken);

    const third = reviewOnly(THIRD, second.reviewToken);

    expect(decodeToken(second.reviewToken)).not.toHaveProperty("fi");
    expect(stubIds(third)).toEqual([]);
    expect(third.warnings?.[0]).toContain("first plain or reviewOnly");
  });

  it("gives an unmapped new Session no preview and no stub, and a later read still previews it", () => {
    const context = pages();
    const unmapped = context.finalize("unmapped", { files: ["src/other.ts"] });
    context.tick();
    const first = context.reviewOnly(FIRST);

    const second = context.reviewOnly(SECOND, first.reviewToken);

    expect(first.unmappedSessions.map((session) => session.id)).toEqual([unmapped]);
    expect(stubIds(second)).toEqual(context.ids);
    expect(second.unmappedSessions.map((session) => session.id)).toEqual([unmapped]);
  });
});

describe("sessionsSeenIn when reviewOnly falls back to the full read", () => {
  it("returns the plain read's stubs and token with the fallback marker", () => {
    const { ids, plain, read, finalize } = pages();
    for (const topic of [1, 2, 3, 4]) finalize(`hit-${topic}`, { files: [`src/topic-${topic}.ts`] });
    const first = plain(FIRST);

    const fallback = read(SECOND, { reviewOnly: true, sessionsSeenIn: first.reviewToken });

    if (fallback.outcome !== "knowledge_page_context" || !("reviewOnly" in fallback) || !("mode" in fallback)) {
      throw new Error("Expected a reviewOnly fallback");
    }
    expect(fallback).toMatchObject({ reviewOnly: true, review: "use_full_read", mode: "review" });
    expect(stubIds(fallback)).toEqual(expect.arrayContaining(ids));
    const { reviewOnly: _reviewOnly, review: _review, ...rest } = fallback;
    expect(rest).toEqual(plain(SECOND, first.reviewToken));
  });
});

describe("sessionsSeenIn from a full read", () => {
  it("carries a window over the Sessions the full read showed", () => {
    const { ids, store, projectRoot, plain, reviewOnly } = pages();
    store.requestKnowledgePageUpdate({ projectRoot, slug: FIRST });
    const first = plain(FIRST);

    const second = plain(SECOND, first.reviewToken);
    const third = reviewOnly(THIRD, first.reviewToken);

    expect(first.mode).toBe("full");
    expect(stubIds(second)).toEqual(ids);
    expect(stubIds(third)).toEqual(ids);
    expect(restored(second, first)).toEqual({ ...plain(SECOND), reviewToken: "" });
  });

  it("never returns a stub in a full read", () => {
    const { store, projectRoot, plain } = pages();
    const { reviewToken } = plain(FIRST);
    store.requestKnowledgePageUpdate({ projectRoot, slug: SECOND });

    const second = plain(SECOND, reviewToken);

    expect(second.mode).toBe("full");
    expect(stubIds(second)).toEqual([]);
    expect(second.sessions).toEqual(plain(SECOND).sessions);
    expect(second.warnings).toBeUndefined();
  });
});

describe("a read that is out of date", () => {
  const staleWarning = (read: Read) => expect(read.warnings?.[0]).toContain("has changed since");

  it("shows every preview when a Session was edited after the token's read", () => {
    const { ids, tick, store, plain, reviewOnly } = pages();
    const token = plain(FIRST).reviewToken;
    tick();
    store.updateSessionWorkSummary({
      sessionId: ids[1]!,
      idempotencyKey: "after-read",
      mode: "patch",
      workSummary: { outcomes: ["Corrected outcome."] },
    });
    tick();

    const second = plain(SECOND, token);
    const third = reviewOnly(SECOND, token);

    expect(stubIds(second)).toEqual([]);
    expect(stubIds(third)).toEqual([]);
    staleWarning(second);
    staleWarning(third);
    expect(previews(second)[1]).toMatchObject({ workSummary: { outcomes: ["Corrected outcome."] } });
    expect({ ...second, warnings: undefined }).toEqual({ ...plain(SECOND), reviewToken: second.reviewToken });
  });

  it("shows every preview when a Session was rewritten in place without a content timestamp", () => {
    const { ids, db, plain } = pages();
    const token = plain(FIRST).reviewToken;
    db.prepare("UPDATE sessions SET work_summary_json = ? WHERE id = ?").run(
      JSON.stringify({ outcomes: ["Imported rewrite."], scope: [], decisions: [], verification: [], nextSteps: [] }),
      ids[0]!,
    );

    const second = plain(SECOND, token);

    expect(stubIds(second)).toEqual([]);
    staleWarning(second);
    expect(previews(second)[0]).toMatchObject({ workSummary: { outcomes: ["Imported rewrite."] } });
  });

  it("shows every preview when a Session is added inside the window with the same ids around it", () => {
    const { store, db, projectRoot, finalize, plain } = pages();
    const [first, second] = db
      .prepare("SELECT completed_at FROM sessions WHERE title IN ('Session n1', 'Session n2') ORDER BY completed_at")
      .all() as Array<{ completed_at: string }>;
    const token = plain(FIRST).reviewToken;
    const between = new Date((Date.parse(first!.completed_at) + Date.parse(second!.completed_at)) / 2).toISOString();
    finalize("inserted", { completedAt: between, advance: false });

    const deduped = plain(SECOND, token);

    expect(store.getKnowledgePageContext({ projectRoot, slug: SECOND }).outcome).toBe("knowledge_page_context");
    expect(stubIds(deduped)).toEqual([]);
    staleWarning(deduped);
    expect(deduped.sessions).toHaveLength(4);
  });

  it("shows every preview when a Session in the window is voided", () => {
    const { ids, store, plain } = pages();
    const token = plain(FIRST).reviewToken;
    expect(store.setSessionVoid({ sessionId: ids[1]!, voided: true, reason: "Recorded as a test." })).toMatchObject({
      outcome: "session_void_updated",
    });

    const second = plain(SECOND, token);

    expect(stubIds(second)).toEqual([]);
    staleWarning(second);
  });
});

describe("window edges", () => {
  it("handles Sessions that share a completedAt at the window edges", () => {
    const context = setup();
    seedBase(context);
    context.writePage(FIRST);
    context.writePage(SECOND);
    context.tick();
    const tied = [1, 2, 3].map((index) => context.finalize(`tie-${index}`, { advance: false }));
    const first = context.plain(FIRST);
    const lateTie = context.finalize("tie-late", { advance: false });

    const second = context.plain(SECOND, first.reviewToken);

    expect(second.sessions.map((session) => session.id)).toContain(lateTie);
    const stubbed = new Set(stubIds(second));
    if (stubbed.size === 0) expect(second.warnings).toHaveLength(1);
    else expect(second.warnings).toBeUndefined();
    expect([0, tied.length]).toContain(stubbed.size);
    for (const id of stubbed) expect(tied).toContain(id);
    expect({ ...restored(second, first), warnings: undefined }).toEqual({ ...context.plain(SECOND), reviewToken: "" });
  });

  it("stubs every Session of a run that shares one completedAt", () => {
    const context = setup();
    seedBase(context);
    context.writePage(FIRST);
    context.writePage(SECOND);
    context.tick();
    const tied = [1, 2, 3, 4].map((index) => context.finalize(`tie-${index}`, { advance: false }));
    const first = context.plain(FIRST);

    const second = context.plain(SECOND, first.reviewToken);

    expect(new Set(stubIds(second))).toEqual(new Set(tied));
    expect(restored(second, first)).toEqual({ ...context.plain(SECOND), reviewToken: "" });
  });

  it("keeps the first and last shown Session of the window as stubs", () => {
    const { ids, plain } = pages();
    const first = plain(FIRST);
    const second = plain(SECOND, first.reviewToken);

    expect(second.sessions[0]?.id).toBe(ids[0]);
    expect(second.sessions.at(-1)?.id).toBe(ids.at(-1));
    expect(stubIds(second)).toEqual(ids);
  });
});

describe("sessionsSeenIn that cannot be used", () => {
  it.each([
    ["not a token", "garbage"],
    ["a prefix with no payload", "kpr1."],
    ["a payload that is not JSON", "kpr1.AAAA"],
  ])("ignores %s with a warning in every kind of read", (_name, token) => {
    const { store, projectRoot, plain, reviewOnly } = pages();
    store.requestKnowledgePageUpdate({ projectRoot, slug: THIRD });

    const reads = [plain(SECOND, token), reviewOnly(SECOND, token), plain(THIRD, token)];

    for (const read of reads) {
      expect(stubIds(read)).toEqual([]);
      expect(read.warnings).toHaveLength(1);
      expect(read.warnings?.[0]).toContain("not a reviewToken from this project");
    }
    expect(reads[0]?.sessions).toEqual(plain(SECOND).sessions);
  });

  it("ignores a token from another project with a warning, in full mode too", () => {
    const context = pages();
    const otherRoot = context.track("orchard");
    seedBase(context, otherRoot);
    context.writePage(FIRST, otherRoot);
    context.finalize("orchard-new", { root: otherRoot });
    context.tick();
    const foreign = context.plain(FIRST, undefined, otherRoot).reviewToken;
    context.store.requestKnowledgePageUpdate({ projectRoot: context.projectRoot, slug: THIRD });

    const reads = [context.plain(SECOND, foreign), context.reviewOnly(SECOND, foreign), context.plain(THIRD, foreign)];

    for (const read of reads) {
      expect(stubIds(read)).toEqual([]);
      expect(read.warnings).toHaveLength(1);
    }
  });

  it("ignores a token whose page does not exist", () => {
    const { plain } = pages();
    const token = plain(FIRST).reviewToken;

    const second = plain(SECOND, encodeToken({ ...decodeToken(token), p: "missing-page" }));

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toHaveLength(1);
  });

  it("tells the Agent which token to pass when the token has no window", () => {
    const { projectRoot, store, plain, reviewOnly } = pages();
    const token = plain(FIRST).reviewToken;
    const focused = store.getKnowledgePageContext({ projectRoot, slug: FIRST, query: "hive" });
    if (!("focused" in focused)) throw new Error("Expected a focused read");
    const deduped = plain(SECOND, token);
    const tokens = [withoutWindow(token), focused.reviewToken, deduped.reviewToken];

    for (const unusable of tokens) {
      for (const read of [plain(THIRD, unusable), reviewOnly(THIRD, unusable)]) {
        expect(stubIds(read)).toEqual([]);
        expect(read.warnings).toHaveLength(1);
        expect(read.warnings?.[0]).toContain("first plain or reviewOnly page read");
      }
    }
    expect(plain(THIRD, tokens[0]).sessions).toEqual(plain(THIRD).sessions);
  });

  it("warns on a focused read, which returns no Sessions", () => {
    const { projectRoot, store, plain } = pages();
    const token = plain(FIRST).reviewToken;

    const focused = store.getKnowledgePageContext({
      projectRoot,
      slug: SECOND,
      query: "hive",
      sessionsSeenIn: token,
    });

    expect(focused).toMatchObject({ focused: true, warnings: [expect.stringContaining("focused read")] });
  });

  it("still accepts a windowed token for saving", () => {
    const { store, projectRoot, ids, plain, reviewOnly } = pages();

    for (const [slug, reviewToken] of [
      [FIRST, plain(FIRST).reviewToken],
      [SECOND, reviewOnly(SECOND).reviewToken],
    ] as const) {
      const saved = store.saveKnowledgePage({
        projectRoot,
        slug,
        idempotencyKey: `save-${slug}`,
        reviewToken,
        sections: [{ heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [ids[0]!] }],
      });
      expect(saved.outcome).toBe("knowledge_page_saved");
    }
  });
});
