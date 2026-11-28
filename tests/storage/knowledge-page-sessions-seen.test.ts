import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgePageContext,
  KnowledgePageContextResult,
  KnowledgePageContextSession,
} from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const FIRST = "architecture";
const SECOND = "pitfalls";
const CONTEXT_BUDGET = 12_000;

function readContext(result: KnowledgePageContextResult): KnowledgePageContext {
  if (result.outcome !== "knowledge_page_context" || "focused" in result || "reviewOnly" in result) {
    throw new Error(`Expected a default read, received ${JSON.stringify(result).slice(0, 120)}`);
  }
  return result;
}

function previews(context: KnowledgePageContext): KnowledgePageContextSession[] {
  return context.sessions.map((session) => {
    if ("previewSeen" in session) throw new Error("Expected a preview, found a stub");
    return session;
  });
}

function stubIds(context: KnowledgePageContext): string[] {
  return context.sessions.filter((session) => "previewSeen" in session).map((session) => session.id);
}

function decodeToken(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.slice("kpr1.".length), "base64url").toString("utf8")) as Record<string, unknown>;
}

function encodeToken(payload: Record<string, unknown>): string {
  return `kpr1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
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
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const track = (name: string) => {
    const projectRoot = join(root, name);
    mkdirSync(projectRoot);
    store.updateProject(store.addProject(name, projectRoot).id, { status: "tracked" });
    return projectRoot;
  };
  const projectRoot = track("apiary");
  const finalize = (key: string, root = projectRoot, outcome = `${key} outcome`) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [outcome], scope: [], decisions: [outcome], verification: [], nextSteps: [outcome] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const read = (slug: string, extra: { sessionsSeenIn?: string; reviewOnly?: boolean } = {}, root = projectRoot) =>
    store.getKnowledgePageContext({ projectRoot: root, slug, ...extra });
  const fullRead = (slug: string, root = projectRoot) => readContext(read(slug, {}, root));
  const writePage = (slug: string, root = projectRoot) => {
    store.requestKnowledgePageUpdate({ projectRoot: root, slug });
    const context = fullRead(slug, root);
    const cited = context.sessions[0]?.id;
    const saved = store.saveKnowledgePage({
      projectRoot: root,
      slug,
      idempotencyKey: `write-${root}-${slug}`,
      reviewToken: context.reviewToken,
      sections: [
        { heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: cited ? [cited] : [] },
      ],
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Expected a save, got ${saved.outcome}`);
    tick();
  };
  const readSeen = (slug: string, token: string, root = projectRoot) =>
    readContext(read(slug, { sessionsSeenIn: token }, root));
  return { store, projectRoot, track, tick, finalize, read, fullRead, readSeen, writePage };
}

/** Two written pages that share three new Sessions; the token comes from a plain read of the first page. */
function twoPagesWithNewSessions() {
  const context = setup();
  const base = context.finalize("base");
  context.writePage(FIRST);
  context.writePage(SECOND);
  const ids = ["n1", "n2", "n3"].map((key) => context.finalize(key));
  context.tick();
  const first = context.fullRead(FIRST);
  return { ...context, base, ids, first, token: first.reviewToken };
}

describe("sessionsSeenIn", () => {
  it("returns a stub for each new Session the token's read already showed", () => {
    const { ids, token, readSeen } = twoPagesWithNewSessions();

    const second = readSeen(SECOND, token);

    expect(second.mode).toBe("review");
    expect(second.sessions).toEqual(
      ids.map((id, index) => ({ id, title: `Session n${index + 1}`, reasons: ["new"], previewSeen: true })),
    );
    expect(second.warnings).toBeUndefined();
  });

  it("is the same response as a plain read once each stub gets the preview the first read showed", () => {
    const { first, token, readSeen, fullRead } = twoPagesWithNewSessions();
    const shown = new Map(previews(first).map((session) => [session.id, session]));

    const deduped = readSeen(SECOND, token);
    const plain = fullRead(SECOND);

    expect(stubIds(deduped)).toHaveLength(3);
    expect({
      ...deduped,
      sessions: deduped.sessions.map((session) => ("previewSeen" in session ? shown.get(session.id) : session)),
      reviewToken: undefined,
    }).toEqual({ ...plain, reviewToken: undefined });
    const { at, id } = decodeToken(deduped.reviewToken);
    expect({ at, id }).toEqual({ at: decodeToken(plain.reviewToken).at, id: decodeToken(plain.reviewToken).id });
  });

  it("keeps a preview for a Session before the token's window and one finished after the read", () => {
    const context = setup();
    context.finalize("base");
    context.writePage(SECOND);
    const early = context.finalize("early");
    context.writePage(FIRST);
    const inside = context.finalize("inside");
    context.tick();
    const { reviewToken } = context.fullRead(FIRST);
    const late = context.finalize("late");

    const second = context.readSeen(SECOND, reviewToken);

    expect(second.sessions.map((session) => [session.id, "previewSeen" in session])).toEqual([
      [early, false],
      [inside, true],
      [late, false],
    ]);
  });

  it("keeps the preview of a Session whose content changed after the token was issued", () => {
    const { ids, token, tick, store, readSeen } = twoPagesWithNewSessions();
    tick();
    const updated = store.updateSessionWorkSummary({
      sessionId: ids[1]!,
      idempotencyKey: "after-issue",
      mode: "patch",
      workSummary: { outcomes: ["Corrected outcome."] },
    });
    expect(updated.outcome).toBe("work_summary_updated");
    tick();

    const second = readSeen(SECOND, token);

    expect(stubIds(second)).toEqual([ids[0], ids[2]]);
    expect(
      previews({ ...second, sessions: second.sessions.filter((session) => session.id === ids[1]) })[0],
    ).toMatchObject({
      workSummary: { outcomes: ["Corrected outcome."] },
    });
  });

  it("keeps the preview of a Session that is new and also a changed cited source", () => {
    const context = setup();
    context.finalize("base");
    context.writePage(FIRST);
    context.writePage(SECOND);
    const ids = ["n1", "n2"].map((key) => context.finalize(key));
    context.tick();
    const saved = context.store.saveKnowledgePage({
      projectRoot: context.projectRoot,
      slug: SECOND,
      idempotencyKey: "cite-new",
      reviewToken: context.fullRead(SECOND).reviewToken,
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
    const { reviewToken } = context.fullRead(FIRST);

    const second = context.readSeen(SECOND, reviewToken);

    expect(second.sessions.map((session) => [session.id, "previewSeen" in session, session.reasons])).toEqual([
      [ids[0], false, ["new", "source_changed"]],
      [ids[1], true, ["new"]],
    ]);
  });

  it("never returns a stub in a full read", () => {
    const { token, store, projectRoot, fullRead, readSeen } = twoPagesWithNewSessions();
    store.requestKnowledgePageUpdate({ projectRoot, slug: SECOND });

    const second = readSeen(SECOND, token);

    expect(second.mode).toBe("full");
    expect(stubIds(second)).toEqual([]);
    expect(second.sessions).toEqual(fullRead(SECOND).sessions);
  });

  it("ignores a token from a review-only read, which showed no window", () => {
    const { projectRoot, store, readSeen, fullRead } = twoPagesWithNewSessions();
    const reviewOnly = store.getKnowledgePageContext({ projectRoot, slug: FIRST, reviewOnly: true });
    if (reviewOnly.outcome !== "knowledge_page_context" || !("reviewOnly" in reviewOnly)) throw new Error("Expected");

    const second = readSeen(SECOND, reviewOnly.reviewToken);

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toBeUndefined();
    expect(second.sessions).toEqual(fullRead(SECOND).sessions);
  });

  it("ignores an old-format token without a window and keeps every preview", () => {
    const { token, readSeen, fullRead } = twoPagesWithNewSessions();
    const { fa: _from, fi: _fromId, iat: _issued, ...old } = decodeToken(token);

    const second = readSeen(SECOND, encodeToken(old));

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toBeUndefined();
    expect(second.sessions).toEqual(fullRead(SECOND).sessions);
  });

  it("still accepts a windowed token for saving", () => {
    const { token, store, projectRoot, ids } = twoPagesWithNewSessions();

    const saved = store.saveKnowledgePage({
      projectRoot,
      slug: FIRST,
      idempotencyKey: "save-windowed",
      reviewToken: token,
      sections: [{ heading: "Hive layout", content: "Queen excluders go on first.", sourceSessionIds: [ids[0]!] }],
    });

    expect(saved.outcome).toBe("knowledge_page_saved");
  });

  it("ignores a token from another project with a warning and keeps every preview", () => {
    const context = twoPagesWithNewSessions();
    const otherRoot = context.track("orchard");
    context.finalize("orchard-base", otherRoot);
    context.writePage(FIRST, otherRoot);
    context.finalize("orchard-new", otherRoot);
    context.tick();
    const foreign = context.fullRead(FIRST, otherRoot).reviewToken;

    const second = context.readSeen(SECOND, foreign);

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toHaveLength(1);
    expect(second.sessions).toEqual(context.fullRead(SECOND).sessions);
  });

  it.each([
    ["not a token", "garbage"],
    ["a prefix with no payload", "kpr1."],
    ["a payload that is not JSON", "kpr1.AAAA"],
  ])("ignores %s with a warning instead of failing the read", (_name, token) => {
    const { readSeen, fullRead } = twoPagesWithNewSessions();

    const second = readSeen(SECOND, token);

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toHaveLength(1);
    expect(second.sessions).toEqual(fullRead(SECOND).sessions);
  });

  it("ignores a token whose page does not exist", () => {
    const { token, readSeen } = twoPagesWithNewSessions();

    const second = readSeen(SECOND, encodeToken({ ...decodeToken(token), p: "missing-page" }));

    expect(stubIds(second)).toEqual([]);
    expect(second.warnings).toHaveLength(1);
  });

  it("does not let a stubbed read vouch for Sessions it did not show", () => {
    const { token, readSeen } = twoPagesWithNewSessions();
    const second = readSeen(SECOND, token);

    expect(decodeToken(second.reviewToken)).not.toHaveProperty("fa");
    expect(stubIds(readSeen(FIRST, second.reviewToken))).toEqual([]);
  });

  it("counts stubs against the Session budget", () => {
    const context = setup();
    context.finalize("base");
    context.writePage(FIRST);
    context.writePage(SECOND);
    const outcome = "Long outcome. ".repeat(20);
    for (let index = 0; index < 59; index += 1) context.finalize(`bulk-${index}`, context.projectRoot, outcome);
    context.tick();
    const first = context.fullRead(FIRST);
    const plain = context.fullRead(SECOND);

    const second = context.readSeen(SECOND, first.reviewToken);

    expect(first.truncated).toBe(true);
    expect(stubIds(second)).toHaveLength(first.sessions.length);
    expect(second.sessions.length).toBeGreaterThan(plain.sessions.length);
    expect(second.truncated).toBe(true);
    expect(JSON.stringify(second.sessions).length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(JSON.stringify(second.sessions).length).toBeGreaterThan(CONTEXT_BUDGET - 2_000);
    expect(second.sessions.map((session) => session.id).slice(0, plain.sessions.length)).toEqual(
      plain.sessions.map((session) => session.id),
    );
  });
});
