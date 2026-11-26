import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentReviewContext,
  AgentReviewRequest,
  AgentReviewVerdict,
  FinalizeSessionInput,
  KnowledgeRecord,
  OverturnAgentReviewResult,
  SubmitAgentReviewVerdictsResult,
} from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Time is faked so every write has its own later timestamp.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-knowledge-"));
  tempDirs.push(root);
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);

  const finalize = (key: string, changedFiles: string[], overrides: Partial<FinalizeSessionInput> = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `Fictional summary for ${key}.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status: "passed" },
      ...overrides,
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    return result.session.id;
  };
  const record = (key: string, appliesTo: string[] = [], body = `${key} body.`) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "gotcha",
      title: `Orchard ${key}`,
      body,
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected recorded Knowledge.");
    return result.knowledge.id;
  };
  const read = (id: string): KnowledgeRecord => {
    for (const status of ["active", "archived"] as const) {
      const result = store.searchKnowledge({ projectRoot: root, status, limit: 100 });
      const found = result.outcome === "knowledge" ? result.items.find((item) => item.id === id) : undefined;
      if (found) return found;
    }
    throw new Error("Expected the Knowledge.");
  };
  const open = (key = "review-1"): AgentReviewRequest => {
    tick();
    const result = store.requestAgentReview({ projectRoot: root, idempotencyKey: key });
    if (result.outcome !== "agent_review_request") throw new Error(`Expected a request, got ${result.outcome}.`);
    return result.request;
  };
  const context = (requestId: string, page = 1): AgentReviewContext => {
    const result = store.getAgentReviewContext({ requestId, page });
    if (result.outcome !== "agent_review_context") throw new Error("Expected context.");
    return result;
  };
  const submit = (
    requestId: string,
    verdicts: AgentReviewVerdict[],
    key = "submit-1",
  ): Extract<SubmitAgentReviewVerdictsResult, { outcome: "agent_review_verdicts_submitted" }> => {
    tick();
    const result = store.submitAgentReviewVerdicts({ requestId, idempotencyKey: key, verdicts });
    if (result.outcome !== "agent_review_verdicts_submitted") throw new Error(`Got ${result.outcome}.`);
    return result;
  };
  const overturn = (knowledgeId: string): OverturnAgentReviewResult => {
    tick();
    return store.overturnAgentReview({ projectRoot: root, itemKind: "knowledge", itemId: knowledgeId });
  };
  const reviewed = () => {
    const result = store.listAgentReviewedKnowledge({ projectRoot: root });
    if (result.outcome !== "agent_reviewed_knowledge") throw new Error("Expected reviewed Knowledge.");
    return result.items;
  };
  const itemRow = (knowledgeId: string) =>
    db
      .prepare(
        `SELECT request_id, verdict, outcome, reason, knowledge_id, decided_at, overturned_at, source_session_id
         FROM agent_review_request_items WHERE item_kind = 'knowledge' AND item_id = ?`,
      )
      .get(knowledgeId);
  return {
    store,
    db,
    root,
    projectId: project.id,
    tick,
    finalize,
    record,
    read,
    open,
    context,
    submit,
    overturn,
    reviewed,
    itemRow,
  };
}

function verdict(
  itemId: string,
  kind: "confirm" | "archive" | "supersede",
  extra: { knowledge?: { title: string; body: string } } = {},
): AgentReviewVerdict {
  return { itemKind: "knowledge", itemId, verdict: kind, reason: `Fictional reason to ${kind}.`, ...extra };
}

/** One Knowledge a later focused Session touched, so it is possibly stale. */
function staleKnowledge(fixture: ReturnType<typeof setup>, key: string): string {
  const id = fixture.record(key, [`src/${key}/**`]);
  fixture.finalize(`touch-${key}`, [`src/${key}/file.ts`]);
  return id;
}

describe("Agent review snapshot of Knowledge in doubt", () => {
  it("holds only active Knowledge that is possibly stale or contradicted", () => {
    const fixture = setup();
    const stale = fixture.record("stale", ["src/stale/**"]);
    const contradicted = fixture.record("contradicted", ["src/contradicted/**"]);
    const broad = fixture.record("broad", ["src/broad/**"]);
    const archived = fixture.record("archived", ["src/archived/**"]);
    fixture.record("untouched", ["src/untouched/**"]);
    fixture.record("plain");
    fixture.finalize("focused", ["src/stale/file.ts", "src/archived/file.ts"]);
    fixture.finalize("contradicting", [], { contradictedKnowledgeIds: [contradicted] });
    fixture.finalize("broad-session", [
      "src/broad/file.ts",
      ...Array.from({ length: 24 }, (_, index) => `vendor/file-${index}.ts`),
    ]);
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: archived, status: "archived" });
    expect(fixture.read(broad)).toMatchObject({ broadChangesSince: 1 });
    expect(fixture.read(broad).possiblyStale).toBeUndefined();

    const request = fixture.open();
    expect(request).toMatchObject({
      itemCount: 2,
      knowledgeCount: 2,
      decisionCount: 0,
      candidateCount: 0,
      openCount: 2,
    });
    expect(fixture.context(request.id).items.map((item) => [item.itemKind, item.id, item.state])).toEqual([
      ["knowledge", stale, "open"],
      ["knowledge", contradicted, "open"],
    ]);
    expect(fixture.itemRow(stale)).toMatchObject({ source_session_id: null, outcome: null });
  });

  it("answers agent_review_not_needed when only broad Sessions touched the Knowledge", () => {
    const fixture = setup();
    fixture.record("broad", ["src/broad/**"]);
    fixture.finalize("broad-session", [
      "src/broad/file.ts",
      ...Array.from({ length: 24 }, (_, index) => `vendor/file-${index}.ts`),
    ]);
    expect(fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-1" })).toMatchObject({
      outcome: "agent_review_not_needed",
    });
  });

  it("returns the open request again instead of putting a Knowledge into a second one", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "orchard");
    const request = fixture.open();
    const again = fixture.store.requestAgentReview({ projectRoot: fixture.root, idempotencyKey: "review-2" });
    expect(again).toMatchObject({ outcome: "agent_review_request", duplicate: true, request: { id: request.id } });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_review_requests").get()).toEqual({ count: 1 });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_review_request_items WHERE item_id = ?").get(id),
    ).toEqual({ count: 1 });
  });
});

describe("Agent review context of a Knowledge item", () => {
  it("describes the Knowledge, its doubt and the later Sessions, newest first", () => {
    const fixture = setup();
    const id = fixture.record("hives", ["src/hives/**"], "Smoke the hive before opening it.");
    fixture.finalize("first", ["src/hives/one.ts", "README.md"]);
    fixture.finalize("second", ["src/hives/two.ts"]);
    const request = fixture.open();

    const page = fixture.context(request.id);
    expect(page.request.status).toBe("processing");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      itemKind: "knowledge",
      id,
      state: "open",
      kind: "gotcha",
      title: "Orchard hives",
      body: "Smoke the hive before opening it.",
      appliesTo: ["src/hives/**"],
      createdAt: fixture.read(id).createdAt,
      doubt: { possiblyStale: { sessionCount: 2 } },
      laterSessions: [
        { title: "Session second", paths: ["src/hives/two.ts"] },
        { title: "Session first", paths: ["src/hives/one.ts"] },
      ],
    });
    expect(page.items[0]!.doubt!.contradicted).toBeUndefined();
    expect(page.items[0]!.laterSessionsOmitted).toBeUndefined();
    expect(page.truncated).toBe(false);
  });

  it("names the contradicting Session of a contradicted Knowledge", () => {
    const fixture = setup();
    const id = fixture.record("hives", ["src/hives/**"]);
    const sessionId = fixture.finalize("contradicting", [], { contradictedKnowledgeIds: [id] });
    const item = fixture.context(fixture.open().id).items[0]!;
    expect(item.doubt).toMatchObject({ contradicted: { sessionId, sessionTitle: "Session contradicting" } });
    expect(item.doubt!.possiblyStale).toBeUndefined();
  });

  it("keeps item fields whole and trims the later Sessions first when the page is full", () => {
    const fixture = setup();
    const body = "b".repeat(1_500);
    const ids = Array.from({ length: 10 }, (_, index) => fixture.record(`area-${index}`, [`area-${index}/**`], body));
    const long = "d".repeat(100);
    ids.forEach((_, index) => {
      for (let session = 0; session < 5; session += 1) {
        fixture.finalize(`later-${index}-${session}-${"t".repeat(120)}`, [
          ...Array.from({ length: 5 }, (_, file) => `area-${index}/${long}/${session}-${file}-${long}.ts`),
        ]);
      }
    });
    for (let index = 0; index < 20; index += 1) fixture.record(`other-${index}`, [], "Other.");
    const page = fixture.context(fixture.open().id);

    expect(page.items.map((item) => item.id)).toEqual(ids);
    expect(page.items.every((item) => item.body === body && !item.bodyTruncated && !item.titleTruncated)).toBe(true);
    const omitted = page.items.reduce((sum, item) => sum + (item.laterSessionsOmitted ?? 0), 0);
    expect(omitted).toBeGreaterThan(0);
    expect(page.truncated).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(24_000);
  });
});

describe("Agent review verdicts on Knowledge", () => {
  it("confirms: the Knowledge is no longer possibly stale and the verdict is recorded", () => {
    const fixture = setup();
    const id = fixture.record("hives", ["src/hives/**"]);
    fixture.finalize("contradicting", ["src/hives/one.ts"], { contradictedKnowledgeIds: [id] });
    const before = fixture.read(id);
    expect(before.possiblyStale).toBeDefined();
    expect(before.review).toBeDefined();
    const request = fixture.open();

    const result = fixture.submit(request.id, [verdict(id, "confirm")]);
    expect(result.results).toEqual([{ itemKind: "knowledge", itemId: id, outcome: "applied" }]);
    expect(result.request).toMatchObject({ status: "completed", appliedCount: 1, openCount: 0 });
    const after = fixture.read(id);
    expect(after.possiblyStale).toBeUndefined();
    expect(after.review).toBeUndefined();
    expect(after.lastConfirmedAt).toBeDefined();
    expect(after.status).toBe("active");
    expect(after.evidence!.confirmed).toBe(before.evidence!.confirmed + 1);
    expect(fixture.itemRow(id)).toMatchObject({
      request_id: request.id,
      verdict: "confirm",
      outcome: "applied",
      reason: "Fictional reason to confirm.",
      knowledge_id: null,
    });
    expect(fixture.reviewed()).toMatchObject([
      { knowledge: { id }, verdict: "confirm", reason: "Fictional reason to confirm.", requestId: request.id },
    ]);
    expect(fixture.reviewed()[0]!.successor).toBeUndefined();
  });

  it("archives the Knowledge", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const request = fixture.open();
    const result = fixture.submit(request.id, [verdict(id, "archive")]);
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect(fixture.read(id).status).toBe("archived");
    expect(fixture.itemRow(id)).toMatchObject({ verdict: "archive", outcome: "applied" });
    expect(fixture.reviewed()).toMatchObject([{ knowledge: { id, status: "archived" }, verdict: "archive" }]);
  });

  it("supersedes: records the replacement, archives the old one and keeps unchanged fields", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const request = fixture.open();
    const result = fixture.submit(request.id, [
      verdict(id, "supersede", { knowledge: { title: "Smoke every hive", body: "Smoke every hive first." } }),
    ]);
    const successorId = result.results[0]!.knowledgeId!;
    expect(result.results[0]).toMatchObject({ outcome: "applied" });
    expect(fixture.read(id).status).toBe("archived");
    expect(fixture.read(successorId)).toMatchObject({
      status: "active",
      supersedesId: id,
      kind: "gotcha",
      title: "Smoke every hive",
      body: "Smoke every hive first.",
      appliesTo: ["src/hives/**"],
    });
    expect(fixture.itemRow(id)).toMatchObject({ verdict: "supersede", outcome: "applied", knowledge_id: successorId });
    expect(fixture.reviewed()).toMatchObject([
      {
        knowledge: { id },
        verdict: "supersede",
        successor: { id: successorId, title: "Smoke every hive", status: "active" },
      },
    ]);
  });

  it("skips a Knowledge a person confirmed or edited after the snapshot, or archived", () => {
    const fixture = setup();
    const confirmed = staleKnowledge(fixture, "confirmed");
    const edited = staleKnowledge(fixture, "edited");
    const archived = staleKnowledge(fixture, "archived");
    const request = fixture.open();
    fixture.tick();
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: confirmed, confirm: true });
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: edited, body: "A person reworded this." });
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: archived, status: "archived" });

    const states = fixture.context(request.id).items.map((item) => item.state);
    expect(states).toEqual(["stale", "stale", "reviewed"]);
    const result = fixture.submit(request.id, [
      verdict(confirmed, "archive"),
      verdict(edited, "archive"),
      verdict(archived, "confirm"),
    ]);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      "skipped_stale",
      "skipped_stale",
      "skipped_reviewed",
    ]);
    expect(fixture.read(confirmed).status).toBe("active");
    expect(fixture.read(edited).status).toBe("active");
    expect(result.request).toMatchObject({ appliedCount: 0, skippedCount: 3, openCount: 0 });
  });

  it("reports knowledge_rejected without closing the item, then applies a resubmitted draft", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const request = fixture.open();
    const failing = vi.spyOn(fixture.store, "recordKnowledge").mockReturnValueOnce({
      outcome: "skipped",
      projectRoot: fixture.root,
      projectStatus: "tracked",
      reason: "Recording is off.",
    });
    const draft = { knowledge: { title: "Smoke every hive", body: "Smoke every hive first." } };

    const rejected = fixture.submit(request.id, [verdict(id, "supersede", draft)]);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(rejected.results).toEqual([
      {
        itemKind: "knowledge",
        itemId: id,
        outcome: "knowledge_rejected",
        knowledgeOutcome: "skipped",
        knowledgeReason: "Recording is off.",
      },
    ]);
    expect(rejected.request).toMatchObject({ appliedCount: 0, skippedCount: 0, openCount: 1 });
    expect(fixture.itemRow(id)).toMatchObject({ outcome: null, verdict: null, reason: null, knowledge_id: null });
    expect(fixture.read(id).status).toBe("active");
    expect(fixture.context(request.id).items[0]).toMatchObject({ id, state: "open" });
    expect(fixture.reviewed()).toEqual([]);

    const applied = fixture.submit(request.id, [verdict(id, "supersede", draft)], "submit-2");
    expect(applied.results[0]).toMatchObject({ outcome: "applied" });
    expect(applied.results[0]!.knowledgeId).toBeDefined();
    expect(applied.request).toMatchObject({ status: "completed", appliedCount: 1, openCount: 0 });
    expect(fixture.read(id).status).toBe("archived");
  });

  it("reports knowledge_rejected for a refused confirm and keeps the item open", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const request = fixture.open();
    vi.spyOn(fixture.store, "updateKnowledge").mockReturnValueOnce({
      outcome: "skipped",
      projectRoot: fixture.root,
      projectStatus: "tracked",
      reason: "Recording is off.",
    });
    const rejected = fixture.submit(request.id, [verdict(id, "confirm")]);
    expect(rejected.results[0]).toMatchObject({ outcome: "knowledge_rejected", knowledgeOutcome: "skipped" });
    expect(fixture.itemRow(id)).toMatchObject({ outcome: null });
    expect(fixture.read(id).lastConfirmedAt).toBeUndefined();
  });
});

describe("Evidence that arrives while a Knowledge item is under review", () => {
  it("skips a verdict when another focused Session touched the Knowledge after the snapshot", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const other = staleKnowledge(fixture, "sheds");
    const request = fixture.open();
    fixture.context(request.id);
    fixture.finalize("meanwhile", ["src/hives/two.ts"]);

    const result = fixture.submit(request.id, [verdict(id, "confirm"), verdict(other, "confirm")]);
    expect(result.results).toEqual([
      expect.objectContaining({ itemId: id, outcome: "skipped_stale" }),
      expect.objectContaining({ itemId: other, outcome: "applied" }),
    ]);
    expect(fixture.read(id).possiblyStale).toMatchObject({ sessionCount: 2 });
  });

  it("still applies a verdict when the Session in between touched nothing the Knowledge applies to", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const request = fixture.open();
    fixture.finalize("elsewhere", ["docs/unrelated.md"]);

    expect(fixture.submit(request.id, [verdict(id, "archive")]).results).toEqual([
      expect.objectContaining({ itemId: id, outcome: "applied" }),
    ]);
  });
});

describe("Overturning Agent verdicts on Knowledge", () => {
  it("withdraws a confirmation and restores the previous confirmation date", () => {
    const fixture = setup();
    const id = fixture.record("hives", ["src/hives/**"]);
    fixture.tick();
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: id, confirm: true });
    const confirmedByPerson = fixture.read(id).lastConfirmedAt;
    fixture.finalize("later", ["src/hives/one.ts"]);
    const before = fixture.read(id);
    expect(before.possiblyStale).toBeDefined();
    const request = fixture.open();
    fixture.submit(request.id, [verdict(id, "confirm")]);
    expect(fixture.read(id).possiblyStale).toBeUndefined();
    expect(fixture.read(id).lastConfirmedAt).not.toBe(confirmedByPerson);

    expect(fixture.overturn(id)).toMatchObject({
      outcome: "agent_review_overturned",
      itemKind: "knowledge",
      reviewedKnowledge: { action: "confirmation_withdrawn", knowledge: { id } },
    });
    const after = fixture.read(id);
    expect(after.lastConfirmedAt).toBe(confirmedByPerson);
    expect(after.possiblyStale).toBeDefined();
    expect(after.evidence).toEqual(before.evidence);
    expect(fixture.reviewed()).toEqual([]);
    expect(fixture.itemRow(id)).toMatchObject({ overturned_at: expect.any(String) });
  });

  it("withdraws a confirmation of never-confirmed, contradicted Knowledge back to the review", () => {
    const fixture = setup();
    const id = fixture.record("hives", ["src/hives/**"]);
    fixture.finalize("contradicting", ["src/hives/one.ts"], { contradictedKnowledgeIds: [id] });
    const before = fixture.read(id);
    const request = fixture.open();
    fixture.submit(request.id, [verdict(id, "confirm")]);
    expect(fixture.read(id).review).toBeUndefined();

    fixture.overturn(id);
    const after = fixture.read(id);
    expect(after.lastConfirmedAt).toBeUndefined();
    expect(after.review).toEqual(before.review);
    expect(after.possiblyStale).toBeDefined();
    expect(after.evidence).toEqual(before.evidence);
  });

  it("keeps a person's later confirmation when the Agent's earlier one is overturned", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "confirm")]);
    fixture.tick();
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: id, confirm: true });
    const confirmedByPerson = fixture.read(id);

    expect(fixture.overturn(id)).toMatchObject({ reviewedKnowledge: { action: "unchanged", knowledge: { id } } });
    const after = fixture.read(id);
    expect(after.lastConfirmedAt).toBe(confirmedByPerson.lastConfirmedAt);
    expect(after.possiblyStale).toBeUndefined();
    expect(after.evidence).toEqual(confirmedByPerson.evidence);
    expect(fixture.itemRow(id)).toMatchObject({ overturned_at: expect.any(String) });
  });

  it("keeps a person's confirmation made in the same millisecond as the Agent's", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "confirm")]);
    fixture.store.updateKnowledge({ projectRoot: fixture.root, knowledgeId: id, confirm: true });
    const confirmedByPerson = fixture.read(id);

    expect(fixture.overturn(id)).toMatchObject({ reviewedKnowledge: { action: "unchanged" } });
    expect(fixture.read(id).lastConfirmedAt).toBe(confirmedByPerson.lastConfirmedAt);
    expect(fixture.read(id).evidence).toEqual(confirmedByPerson.evidence);
  });

  it("keeps a contradiction reported after the Agent's confirmation when it is overturned", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "confirm")]);
    const contradicting = fixture.finalize("contradicting", [], { contradictedKnowledgeIds: [id] });

    expect(fixture.overturn(id)).toMatchObject({ reviewedKnowledge: { action: "confirmation_withdrawn" } });
    const after = fixture.read(id);
    expect(after.lastConfirmedAt).toBeUndefined();
    expect(after.review).toMatchObject({ reason: "contradicted", sessionId: contradicting });
    expect(after.possiblyStale).toBeDefined();
  });

  it("keeps a Session's later applied confirmation when the Agent's earlier one is overturned", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "confirm")]);
    const applying = fixture.finalize("applying", [], { appliedKnowledgeIds: [id] });
    const confirmedBySession = fixture.read(id);

    expect(fixture.overturn(id)).toMatchObject({ reviewedKnowledge: { action: "unchanged" } });
    expect(fixture.read(id)).toMatchObject({
      lastConfirmedAt: confirmedBySession.lastConfirmedAt,
      lastConfirmedSessionId: applying,
    });
  });

  it("answers a repeated overturn without changing the Knowledge again", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "confirm")]);
    fixture.overturn(id);
    const overturned = fixture.read(id);

    expect(fixture.overturn(id)).toEqual({ outcome: "rejected", reason: "not_agent_reviewed" });
    expect(fixture.read(id)).toEqual(overturned);
  });

  it("restores archived Knowledge to active", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    fixture.submit(fixture.open().id, [verdict(id, "archive")]);
    expect(fixture.overturn(id)).toMatchObject({ reviewedKnowledge: { action: "restored", knowledge: { id } } });
    expect(fixture.read(id).status).toBe("active");
    expect(fixture.reviewed()).toEqual([]);
  });

  it("archives the replacement and restores the replaced Knowledge", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const result = fixture.submit(fixture.open().id, [
      verdict(id, "supersede", { knowledge: { title: "Smoke every hive", body: "Smoke every hive first." } }),
    ]);
    const successorId = result.results[0]!.knowledgeId!;

    expect(fixture.overturn(id)).toMatchObject({
      reviewedKnowledge: { action: "restored", knowledge: { id, status: "active" } },
      knowledge: { id: successorId, action: "archived", status: "archived" },
    });
    expect(fixture.read(id).status).toBe("active");
    expect(fixture.read(successorId).status).toBe("archived");
    expect(fixture.reviewed()).toEqual([]);
  });

  it("keeps an overturned Knowledge out of the next request and out of the reviewed list", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    const other = staleKnowledge(fixture, "meadow");
    const first = fixture.open();
    fixture.submit(first.id, [verdict(id, "archive")]);
    fixture.overturn(id);
    fixture.store.cancelAgentReviewRequest(first.id);

    const next = fixture.open("review-2");
    expect(next).toMatchObject({ knowledgeCount: 1, itemCount: 1 });
    expect(fixture.context(next.id).items.map((item) => item.id)).toEqual([other]);
  });

  it("rejects Knowledge no Agent verdict covers, and reports an unknown one", () => {
    const fixture = setup();
    const id = staleKnowledge(fixture, "hives");
    expect(fixture.overturn(id)).toEqual({ outcome: "rejected", reason: "not_agent_reviewed" });
    expect(fixture.overturn("missing")).toMatchObject({ outcome: "not_found", itemId: "missing" });
    fixture.submit(fixture.open().id, [verdict(id, "archive")]);
    fixture.overturn(id);
    expect(fixture.overturn(id)).toEqual({ outcome: "rejected", reason: "not_agent_reviewed" });
  });
});
