import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCandidateInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-candidates-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Meadow", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, handoffContent?: string) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [`Decided ${key}.`], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      ...(handoffContent ? { handoffContent } : {}),
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result.session.id;
  };
  const candidate = (sourceSessionId: string, title: string): KnowledgeCandidateInput => ({
    sourceSessionId,
    kind: "gotcha",
    title,
    body: `${title} body.`,
    appliesTo: ["src/meadow/**"],
    rationale: "The handoff describes the failure and its fix.",
  });
  return { store, root, projectId: project.id, finalize, candidate };
}

function recorded(store: WorkIntelligenceStore, root: string, key: string, title: string, body = `${title}.`): string {
  const result = store.recordKnowledge({ projectRoot: root, idempotencyKey: key, kind: "gotcha", title, body });
  if (result.outcome !== "knowledge_recorded") throw new Error("Expected recorded Knowledge");
  return result.knowledge.id;
}

function openRequest(store: WorkIntelligenceStore, root: string): string {
  const result = store.requestKnowledgeCandidates(root);
  if (result.outcome !== "knowledge_candidate_request") throw new Error("Expected a candidate request");
  return result.request.id;
}

function submitted(store: WorkIntelligenceStore, requestId: string, candidates: KnowledgeCandidateInput[]) {
  const result = store.submitKnowledgeCandidates({ requestId, candidates });
  if (result.outcome !== "knowledge_candidates_submitted") throw new Error("Expected submitted candidates");
  return result.candidates;
}

function databaseOf(store: WorkIntelligenceStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function storedOverlaps(store: WorkIntelligenceStore, candidateId: string): unknown {
  const row = databaseOf(store)
    .prepare("SELECT overlaps_json FROM knowledge_candidates WHERE id = ?")
    .get(candidateId) as { overlaps_json: string | null } | undefined;
  return row?.overlaps_json === null || row === undefined ? row?.overlaps_json : JSON.parse(row.overlaps_json);
}

function submitOverlappingCandidate(fixture: ReturnType<typeof setup>) {
  const { store, root, finalize, candidate } = fixture;
  const first = finalize("first");
  const knowledgeId = recorded(
    store,
    root,
    "stored-active",
    "Sprinkler lease expires silently",
    "The sprinkler lease expires without an error.",
  );
  const request = openRequest(store, root);
  store.getKnowledgeCandidateContext({ requestId: request });
  const payload = [
    { ...candidate(first, "Sprinkler lease expires silently"), body: "The sprinkler lease expires without an error." },
    candidate(first, "Compost bin lid warps in sun"),
  ];
  const result = submitted(store, request, payload);
  return { ...fixture, request, payload, knowledgeId, result };
}

describe("Knowledge candidates", () => {
  it("proposes candidates from uncovered Sessions and records only accepted ones as Knowledge", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first", "# Handoff\n## Gotcha\nThe sprinkler lease expired silently.");
    const second = finalize("second");

    const request = store.requestKnowledgeCandidates(root);
    if (request.outcome !== "knowledge_candidate_request") {
      throw new Error("Expected request");
    }
    expect(request.request.sourceSessionIds.sort()).toEqual([first, second].sort());
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({
      duplicate: true,
      request: { id: request.request.id },
    });
    const context = store.getContext(root);
    expect(context.outcome === "context" && context.pendingRequests.knowledgeCandidates).toHaveLength(1);

    const candidateContext = store.getKnowledgeCandidateContext({ projectRoot: root });
    if (candidateContext.outcome !== "knowledge_candidate_context") {
      throw new Error("Expected candidate context");
    }
    expect(candidateContext.request.status).toBe("processing");
    expect(candidateContext.sessions.find((session) => session.id === first)?.handoff).toContain("sprinkler lease");

    const token = `ghs_${"U".repeat(36)}`;
    expect(
      store.submitKnowledgeCandidates({ requestId: request.request.id, candidates: [candidate("elsewhere", "Bad")] }),
    ).toMatchObject({ outcome: "invalid_candidates" });
    const submitted = store.submitKnowledgeCandidates({
      requestId: request.request.id,
      candidates: [candidate(first, `Sprinkler lease ${token}`), candidate(second, "Not reusable")],
    });
    if (submitted.outcome !== "knowledge_candidates_submitted") {
      throw new Error("Expected submission");
    }
    expect(submitted.redactions).toMatchObject({ total: 2 });
    expect(JSON.stringify(submitted.candidates)).not.toContain(token);
    expect(submitted.request).toMatchObject({ status: "completed", candidateCount: 2 });
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({ items: [] });

    const [accept, reject] = submitted.candidates;
    const accepted = store.decideKnowledgeCandidate({
      candidateId: accept!.id,
      decision: "accept",
      edits: { title: "Sprinkler lease expires without an error" },
    });
    expect(accepted).toMatchObject({
      outcome: "knowledge_candidate_decided",
      candidate: { status: "accepted" },
      knowledge: {
        title: "Sprinkler lease expires without an error",
        sessionId: first,
        appliesTo: ["src/meadow/**"],
      },
    });
    expect(store.decideKnowledgeCandidate({ candidateId: reject!.id, decision: "reject" })).toMatchObject({
      candidate: { status: "rejected" },
    });
    expect(store.decideKnowledgeCandidate({ candidateId: accept!.id, decision: "reject" })).toMatchObject({
      outcome: "already_decided",
    });

    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({ items: [], openRequests: [] });
    expect(store.listKnowledgeCandidates({ projectRoot: root, status: "accepted" })).toMatchObject({
      items: [{ id: accept!.id }],
    });
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({ outcome: "knowledge_candidates_not_needed" });

    const third = finalize("third");
    const next = store.requestKnowledgeCandidates(root);
    expect(next.outcome === "knowledge_candidate_request" && next.request.sourceSessionIds).toEqual([third]);
  });

  it("recovers abandoned processing requests and respects the project policy", () => {
    const { store, root, projectId, finalize } = setup();
    finalize("one");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const request = store.requestKnowledgeCandidates(root);
    store.getKnowledgeCandidateContext({ projectRoot: root });
    vi.setSystemTime(Date.UTC(2030, 0, 1, 1));
    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({
      openRequests: [{ status: "failed", failureReason: expect.stringContaining("30 分鐘") }],
    });
    expect(store.getKnowledgeCandidateContext({ projectRoot: root })).toMatchObject({
      outcome: "knowledge_candidate_context",
      request: { status: "processing" },
    });

    store.updateProject(projectId, { status: "paused" });
    expect(store.requestKnowledgeCandidates(root)).toMatchObject({ outcome: "skipped" });
    expect(
      request.outcome === "knowledge_candidate_request" &&
        store.submitKnowledgeCandidates({ requestId: request.request.id, candidates: [] }),
    ).toMatchObject({ outcome: "skipped" });
  });

  it("lists archived Knowledge and rejected candidates in the context and leaves scope and verification to reads", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    const active = recorded(store, root, "active", "Meadow gate opens inward");
    const archived = recorded(store, root, "archived", "Meadow pump needs priming");
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived, status: "archived" });
    const firstRequest = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: firstRequest });
    const rejected = submitted(store, firstRequest, [candidate(first, "Meadow fence posts lean north")])[0]!;
    store.decideKnowledgeCandidate({ candidateId: rejected.id, decision: "reject" });

    finalize("second");
    const context = store.getKnowledgeCandidateContext({ requestId: openRequest(store, root) });
    if (context.outcome !== "knowledge_candidate_context") throw new Error("Expected candidate context");
    expect(context.existingKnowledge).toEqual({
      active: { gotcha: ["Meadow gate opens inward"] },
      archived: { gotcha: ["Meadow pump needs priming"] },
      rejected: { gotcha: ["Meadow fence posts lean north"] },
    });
    expect(JSON.stringify(context.existingKnowledge)).not.toContain(active);
    expect(context).not.toHaveProperty("existingKnowledgeOmitted");
    expect(context).toMatchObject({
      omittedWorkSummarySections: ["scope", "verification"],
      sessionReadWith: "work_get_session",
    });
    expect(Object.keys(context.sessions[0]!.workSummary ?? {})).toEqual(["outcomes", "decisions", "nextSteps"]);
  });

  it("flags submitted candidates that overlap the project's Knowledge or earlier candidates, advisory only", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    const active = recorded(
      store,
      root,
      "dup-active",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error after one hour.",
    );
    const archived = recorded(
      store,
      root,
      "dup-archived",
      "Valve timer drifts after restart",
      "The valve timer drifts by a minute after each controller restart.",
    );
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived, status: "archived" });
    const firstRequest = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: firstRequest });
    const rejected = submitted(store, firstRequest, [
      { ...candidate(first, "Hose reel jams when wet"), body: "The hose reel jams when its spool is wet." },
    ])[0]!;
    store.decideKnowledgeCandidate({ candidateId: rejected.id, decision: "reject" });

    const second = finalize("second");
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const result = submitted(store, request, [
      {
        ...candidate(second, "Sprinkler lease expires silently after an hour"),
        body: "The sprinkler lease expires without an error.",
      },
      {
        ...candidate(second, "Valve timer drifts after a restart"),
        body: "The valve timer drifts after a controller restart.",
      },
      { ...candidate(second, "Hose reel jams when the spool is wet"), body: "The hose reel jams when wet." },
      { ...candidate(second, "Compost bin lid warps in sun"), body: "Direct sunlight warps the compost bin lid." },
    ]);
    expect(
      result.map((item) => item.overlaps?.map(({ relation, type, id, status }) => ({ relation, type, id, status }))),
    ).toEqual([
      [{ relation: "possible_duplicate", type: "knowledge", id: active, status: "active" }],
      [{ relation: "overlaps_archived", type: "knowledge", id: archived, status: "archived" }],
      [{ relation: "overlaps_rejected", type: "candidate", id: rejected.id, status: "rejected" }],
      undefined,
    ]);
    expect(result[0]!.overlaps![0]!.score).toBeGreaterThanOrEqual(0.3);
    expect(result.every((item) => item.status === "proposed")).toBe(true);
    expect(store.searchKnowledge({ projectRoot: root, status: "active" })).toMatchObject({ items: [{ id: active }] });
    expect(store.listKnowledgeCandidates({ projectRoot: root, status: "rejected" })).toMatchObject({
      items: [{ id: rejected.id }],
    });
  });

  it("never compares candidates across projects", () => {
    const { store, root, finalize, candidate } = setup();
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-candidates-other-"));
    tempDirs.push(otherRoot);
    const other = store.addProject("Orchard", otherRoot);
    store.updateProject(other.id, { status: "tracked" });
    recorded(
      store,
      otherRoot,
      "other-dup",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error.",
    );
    const first = finalize("first");
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const context = store.getKnowledgeCandidateContext({ requestId: request });
    expect(context.outcome === "knowledge_candidate_context" && context.existingKnowledge).toEqual({});
    const result = submitted(store, request, [
      {
        ...candidate(first, "Sprinkler lease expires silently"),
        body: "The sprinkler lease expires without an error.",
      },
    ]);
    expect(result[0]).not.toHaveProperty("overlaps");
  });

  it("returns the stored candidates and the same advisories when the same payload is submitted again", () => {
    const { store, root, finalize, candidate } = setup();
    const first = finalize("first");
    recorded(
      store,
      root,
      "replay-active",
      "Sprinkler lease expires silently",
      "The sprinkler lease expires without an error.",
    );
    const request = openRequest(store, root);
    store.getKnowledgeCandidateContext({ requestId: request });
    const payload = [
      {
        ...candidate(first, "  Sprinkler lease expires silently  "),
        body: "The sprinkler lease expires without an error.",
      },
      candidate(first, "Compost bin lid warps in sun"),
    ];
    const once = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    const again = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    if (once.outcome !== "knowledge_candidates_submitted" || again.outcome !== "knowledge_candidates_submitted")
      throw new Error("Expected both submissions to return the candidates.");
    expect(again.duplicate).toBe(true);
    expect(again.candidates).toEqual(once.candidates);
    expect(once.candidates[0]!.overlaps).toHaveLength(1);
    expect(store.listKnowledgeCandidates({ projectRoot: root })).toMatchObject({ items: { length: 2 } });
    expect(
      store.submitKnowledgeCandidates({ requestId: request, candidates: [candidate(first, "A different payload")] }),
    ).toMatchObject({ outcome: "request_not_open" });
  });
});

describe("stored Knowledge candidate overlap advisories", () => {
  it("stores ids, statuses and scores only, and lists the advisory with the matched title", () => {
    const fixture = submitOverlappingCandidate(setup());
    const { store, root, knowledgeId, result } = fixture;
    expect(storedOverlaps(store, result[0]!.id)).toEqual([
      {
        relation: "possible_duplicate",
        type: "knowledge",
        id: knowledgeId,
        status: "active",
        score: expect.any(Number),
      },
    ]);
    expect(storedOverlaps(store, result[1]!.id)).toEqual([]);
    expect(JSON.stringify(storedOverlaps(store, result[0]!.id))).not.toContain("Sprinkler");

    const listed = store.listKnowledgeCandidates({ projectRoot: root });
    if (listed.outcome !== "knowledge_candidates") throw new Error("Expected the candidate list");
    const byId = new Map(listed.items.map((item) => [item.id, item]));
    expect(byId.get(result[0]!.id)!.overlaps).toEqual(result[0]!.overlaps);
    expect(byId.get(result[0]!.id)!.overlaps![0]).toMatchObject({ title: "Sprinkler lease expires silently" });
    expect(byId.get(result[1]!.id)).not.toHaveProperty("overlaps");
  });

  it("replays the stored advisory after the matched record's status changed", () => {
    const fixture = submitOverlappingCandidate(setup());
    const { store, root, request, payload, knowledgeId, result } = fixture;
    store.updateKnowledge({ projectRoot: root, knowledgeId, status: "archived" });

    const again = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    if (again.outcome !== "knowledge_candidates_submitted") throw new Error("Expected the replay");
    expect(again.duplicate).toBe(true);
    expect(again.candidates[0]!.overlaps).toEqual([
      expect.objectContaining({ relation: "possible_duplicate", id: knowledgeId, status: "active" }),
    ]);
    expect(again.candidates).toEqual(result);
  });

  it("recomputes a candidate submitted before schema 33 exactly as before", () => {
    const fixture = submitOverlappingCandidate(setup());
    const { store, request, payload, knowledgeId, result } = fixture;
    databaseOf(store).prepare("UPDATE knowledge_candidates SET overlaps_json = NULL WHERE request_id = ?").run(request);

    const listed = store.listKnowledgeCandidates({});
    expect(listed.outcome === "knowledge_candidates" && listed.items.every((item) => !item.overlaps)).toBe(true);
    const again = store.submitKnowledgeCandidates({ requestId: request, candidates: payload });
    if (again.outcome !== "knowledge_candidates_submitted") throw new Error("Expected the replay");
    expect(again.candidates[0]!.overlaps).toEqual([expect.objectContaining({ id: knowledgeId })]);
    expect(again.candidates).toEqual(result);
  });

  it("drops a damaged advisory and never names a record of another project", () => {
    const fixture = submitOverlappingCandidate(setup());
    const { store, result } = fixture;
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-candidates-foreign-"));
    tempDirs.push(otherRoot);
    const other = store.addProject("Orchard", otherRoot);
    store.updateProject(other.id, { status: "tracked" });
    const foreign = recorded(store, otherRoot, "foreign", "Orchard secret plan");
    const db = databaseOf(store);
    const update = db.prepare("UPDATE knowledge_candidates SET overlaps_json = ? WHERE id = ?");
    update.run(
      JSON.stringify([
        { relation: "possible_duplicate", type: "knowledge", id: foreign, status: "active", score: 0.9 },
      ]),
      result[0]!.id,
    );
    update.run("{not json", result[1]!.id);

    const listed = store.listKnowledgeCandidates({});
    if (listed.outcome !== "knowledge_candidates") throw new Error("Expected the candidate list");
    const byId = new Map(listed.items.map((item) => [item.id, item]));
    expect(byId.get(result[0]!.id)!.overlaps).toEqual([
      { relation: "possible_duplicate", type: "knowledge", id: foreign, status: "active", score: 0.9 },
    ]);
    expect(byId.get(result[1]!.id)).not.toHaveProperty("overlaps");

    update.run(
      JSON.stringify([{ relation: "overlaps_archived", type: "knowledge", id: foreign, status: "active", score: 0.9 }]),
      result[0]!.id,
    );
    const inconsistent = store.listKnowledgeCandidates({});
    expect(
      inconsistent.outcome === "knowledge_candidates" &&
        inconsistent.items.find((item) => item.id === result[0]!.id)?.overlaps,
    ).toBeUndefined();
  });

  it("keeps the stored relation without a title once the matched record is gone", () => {
    const fixture = submitOverlappingCandidate(setup());
    const { store, root, knowledgeId, result } = fixture;
    const db = databaseOf(store);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM knowledge WHERE id = ?").run(knowledgeId);
    db.exec("PRAGMA foreign_keys = ON");

    const listed = store.listKnowledgeCandidates({ projectRoot: root });
    if (listed.outcome !== "knowledge_candidates") throw new Error("Expected the candidate list");
    const overlap = listed.items.find((item) => item.id === result[0]!.id)!.overlaps![0]!;
    expect(overlap).toMatchObject({ relation: "possible_duplicate", id: knowledgeId, status: "active" });
    expect(overlap).not.toHaveProperty("title");
  });
});

describe("Knowledge candidate continuation", () => {
  function finalizeWith(fixture: ReturnType<typeof setup>, key: string, decisions: boolean): string {
    const result = fixture.store.finalizeSession({
      projectRoot: fixture.root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: decisions ? [{ text: `Decision ${key}`, origin: "user_requested" }] : [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  }

  function valuable(fixture: ReturnType<typeof setup>, count: number, prefix = "valuable"): string[] {
    return Array.from({ length: count }, (_, index) => finalizeWith(fixture, `${prefix}-${index}`, true));
  }

  function submit(store: WorkIntelligenceStore, requestId: string, candidates: KnowledgeCandidateInput[] = []) {
    const result = store.submitKnowledgeCandidates({ requestId, candidates });
    if (result.outcome !== "knowledge_candidates_submitted") throw new Error("Expected submitted candidates");
    return result;
  }

  function requestCount(store: WorkIntelligenceStore, status?: string): number {
    const row = databaseOf(store)
      .prepare(`SELECT COUNT(*) AS total FROM knowledge_candidate_requests ${status ? "WHERE status = ?" : ""}`)
      .get(...(status ? [status] : [])) as { total: number };
    return row.total;
  }

  it("opens the next request for the remaining high-value Sessions, once the previous one completes", () => {
    const fixture = setup();
    const ids = valuable(fixture, 14);
    finalizeWith(fixture, "plain-late", false);
    const first = openRequest(fixture.store, fixture.root);
    const sources = (
      fixture.store.requestKnowledgeCandidates(fixture.root) as { request: { sourceSessionIds: string[] } }
    ).request.sourceSessionIds;
    const result = submit(fixture.store, first, [fixture.candidate(sources[0]!, "Hose splits in frost")]);
    expect(result.next).toMatchObject({ sourceSessions: 4, remaining: { uncoveredSessions: 1, highValueSessions: 0 } });
    expect(result.candidates).toHaveLength(1);
    const open = fixture.store.requestKnowledgeCandidates(fixture.root);
    expect(open).toMatchObject({ duplicate: true, request: { id: result.next!.requestId, status: "pending" } });
    const nextSources = (open as { request: { sourceSessionIds: string[] } }).request.sourceSessionIds;
    expect([...sources, ...nextSources].sort()).toEqual([...ids].sort());
  });

  it("does not continue when only low-score Sessions remain", () => {
    const fixture = setup();
    valuable(fixture, 3);
    finalizeWith(fixture, "plain-a", false);
    finalizeWith(fixture, "plain-b", false);
    const result = submit(fixture.store, openRequest(fixture.store, fixture.root));
    expect(result.request.sourceSessionIds).toHaveLength(3);
    expect(result).not.toHaveProperty("next");
    expect(requestCount(fixture.store, "pending")).toBe(0);
    expect(openRequest(fixture.store, fixture.root)).toBeTruthy();
  });

  it("ends the chain after ceil(high-value / 10) submissions, an empty one included", () => {
    const fixture = setup();
    valuable(fixture, 25);
    let requestId = openRequest(fixture.store, fixture.root);
    const sizes: number[] = [];
    for (let submissions = 0; submissions < 5; submissions += 1) {
      const result = submit(fixture.store, requestId);
      sizes.push(result.request.sourceSessionIds.length);
      if (!result.next) break;
      requestId = result.next.requestId;
    }
    expect(sizes).toEqual([10, 10, 5]);
    expect(requestCount(fixture.store)).toBe(3);
    expect(fixture.store.requestKnowledgeCandidates(fixture.root).outcome).toBe("knowledge_candidates_not_needed");
  });

  it("returns the request that is still open on a replay and creates no second one", () => {
    const fixture = setup();
    valuable(fixture, 14);
    const request = openRequest(fixture.store, fixture.root);
    const first = submit(fixture.store, request);
    const replay = submit(fixture.store, request);
    expect(replay.duplicate).toBe(true);
    expect(replay.next).toEqual(first.next);
    expect(requestCount(fixture.store)).toBe(2);
    submit(fixture.store, first.next!.requestId);
    expect(submit(fixture.store, request)).not.toHaveProperty("next");
  });

  it("does not open another request while one is already open", () => {
    const fixture = setup();
    valuable(fixture, 14);
    const request = openRequest(fixture.store, fixture.root);
    databaseOf(fixture.store)
      .prepare(
        `INSERT INTO knowledge_candidate_requests (id, project_id, status, requested_at, source_session_ids_json)
         VALUES ('manual', ?, 'failed', '2030-01-01T00:00:00.000Z', '[]')`,
      )
      .run(fixture.projectId);
    expect(submit(fixture.store, request)).not.toHaveProperty("next");
    expect(requestCount(fixture.store)).toBe(2);
  });

  it("writes neither the submission nor the next request when the transaction rolls back", () => {
    const fixture = setup();
    valuable(fixture, 14);
    const request = openRequest(fixture.store, fixture.root);
    databaseOf(fixture.store).exec(
      `CREATE TRIGGER block_requests BEFORE INSERT ON knowledge_candidate_requests
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    const sourceSessionId = (
      fixture.store.requestKnowledgeCandidates(fixture.root) as { request: { sourceSessionIds: string[] } }
    ).request.sourceSessionIds[0]!;
    expect(() =>
      fixture.store.submitKnowledgeCandidates({
        requestId: request,
        candidates: [fixture.candidate(sourceSessionId, "Hose splits in frost")],
      }),
    ).toThrow("blocked");
    expect(requestCount(fixture.store)).toBe(1);
    expect(requestCount(fixture.store, "completed")).toBe(0);
    const candidates = databaseOf(fixture.store)
      .prepare("SELECT COUNT(*) AS total FROM knowledge_candidates")
      .get() as {
      total: number;
    };
    expect(candidates.total).toBe(0);
  });

  it("lists candidates still proposed from earlier batches in the next context", () => {
    const fixture = setup();
    valuable(fixture, 14);
    const request = openRequest(fixture.store, fixture.root);
    const sourceSessionId = (
      fixture.store.requestKnowledgeCandidates(fixture.root) as { request: { sourceSessionIds: string[] } }
    ).request.sourceSessionIds[0]!;
    const proposed = submit(fixture.store, request, [fixture.candidate(sourceSessionId, "Hose splits in frost")]);
    const context = fixture.store.getKnowledgeCandidateContext({ requestId: proposed.next!.requestId });
    if (context.outcome !== "knowledge_candidate_context") throw new Error("Expected context");
    expect(context.existingKnowledge).toEqual({ proposed: { gotcha: ["Hose splits in frost"] } });
  });

  it("groups titles by status and kind newest first and drops repeated titles within a group", () => {
    const { store, root, finalize } = setup();
    finalize("first");
    const ids = ["Gate sticks", "Pump leaks", "Gate sticks", "Latch rusts"].map((title, index) =>
      recorded(store, root, `group-${index}`, `${title} ${index}`),
    );
    const database = databaseOf(store);
    ids.forEach((id, index) =>
      database
        .prepare("UPDATE knowledge SET title = ?, kind = ?, updated_at = ? WHERE id = ?")
        .run(
          ["Gate sticks", "Pump leaks", "Gate sticks", "Latch rusts"][index]!,
          index === 1 ? "decision" : "gotcha",
          `2026-10-01T09:0${index}:00.000Z`,
          id,
        ),
    );
    const context = store.getKnowledgeCandidateContext({ requestId: openRequest(store, root) });
    if (context.outcome !== "knowledge_candidate_context") throw new Error("Expected candidate context");
    expect(context.existingKnowledge).toEqual({
      active: { gotcha: ["Latch rusts", "Gate sticks"], decision: ["Pump leaks"] },
    });
    expect(context).not.toHaveProperty("existingKnowledgeOmitted");
  });

  it("caps the serialized existing Knowledge and counts the titles left out", () => {
    const { store, root, finalize } = setup();
    finalize("first");
    for (let index = 0; index < 200; index += 1) {
      recorded(store, root, `cap-${index}`, `Orchard rule ${String(index).padStart(3, "0")} ${"title ".repeat(14)}`);
    }
    const context = store.getKnowledgeCandidateContext({ requestId: openRequest(store, root) });
    if (context.outcome !== "knowledge_candidate_context") throw new Error("Expected candidate context");
    const kept = context.existingKnowledge.active?.gotcha ?? [];
    expect(JSON.stringify(context.existingKnowledge).length).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(context.existingKnowledge).length + 100).toBeGreaterThan(12_000);
    expect(kept.length + (context.existingKnowledgeOmitted ?? 0)).toBe(200);
    expect(context.existingKnowledgeOmitted).toBeGreaterThan(0);
    expect(kept.every((title) => title.length <= 120)).toBe(true);
  });

  it("stops the chain: a cancelled request frees its Sessions and no longer accepts a submission", () => {
    const fixture = setup();
    valuable(fixture, 14);
    const first = submit(fixture.store, openRequest(fixture.store, fixture.root));
    const nextId = first.next!.requestId;
    const cancelled = fixture.store.cancelKnowledgeCandidateRequest(nextId);
    expect(cancelled).toMatchObject({
      outcome: "knowledge_candidate_request_cancelled",
      duplicate: false,
      request: { id: nextId, status: "cancelled" },
    });
    expect(fixture.store.cancelKnowledgeCandidateRequest(nextId)).toMatchObject({ duplicate: true });
    expect(fixture.store.submitKnowledgeCandidates({ requestId: nextId, candidates: [] })).toMatchObject({
      outcome: "request_not_open",
    });
    const reopened = fixture.store.requestKnowledgeCandidates(fixture.root);
    expect(reopened).toMatchObject({ duplicate: false, remaining: { highValueSessions: 0 } });
    expect((reopened as { request: { sourceSessionIds: string[] } }).request.sourceSessionIds).toHaveLength(4);
  });

  it("does not cancel a completed or unknown request, and follows the project policy", () => {
    const fixture = setup();
    valuable(fixture, 2);
    const request = openRequest(fixture.store, fixture.root);
    submit(fixture.store, request);
    expect(fixture.store.cancelKnowledgeCandidateRequest(request)).toMatchObject({
      outcome: "request_not_open",
      request: { status: "completed" },
    });
    expect(fixture.store.cancelKnowledgeCandidateRequest("missing")).toMatchObject({ outcome: "not_found" });
    valuable(fixture, 1, "again");
    const open = openRequest(fixture.store, fixture.root);
    fixture.store.updateProject(fixture.projectId, { status: "paused" });
    expect(fixture.store.cancelKnowledgeCandidateRequest(open).outcome).toBe("skipped");
  });
});
