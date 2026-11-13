import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContextResult,
  KnowledgeCandidateBacklog,
  WorkSummaryDecisionEntry,
} from "../../packages/core/src/index.js";
import {
  BACKLOG_SCORE_WEIGHTS,
  scoreBacklogSession,
  selectTopBacklogSessions,
} from "../../packages/storage/src/knowledge-candidate-backlog.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

type Decisions = WorkSummaryDecisionEntry[];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databaseOf(store: WorkIntelligenceStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-backlog-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  // Each Session completes one hour after the previous one, so recency is the creation order.
  const finalize = (
    key: string,
    options: { decisions?: Decisions; verification?: "passed" | "failed" | "not_run" } = {},
  ): string => {
    clock += 60 * 60 * 1000;
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      completedAt: new Date(clock).toISOString(),
      workSummary: { outcomes: [], scope: [], decisions: options.decisions ?? [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: options.verification ?? "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  const plain = (count: number, prefix = "plain"): string[] =>
    Array.from({ length: count }, (_, index) => finalize(`${prefix}-${index}`));
  const confirmed = (text: string): Decisions => [{ text, origin: "user_requested" }];
  const backlog = (): KnowledgeCandidateBacklog | undefined => {
    const result = store.listKnowledgeCandidates({ projectRoot: root });
    if (result.outcome !== "knowledge_candidates") throw new Error("Expected a candidate list");
    return result.backlog[0];
  };
  const request = () => {
    const result = store.requestKnowledgeCandidates(root);
    if (result.outcome !== "knowledge_candidate_request") throw new Error(`Unexpected ${result.outcome}`);
    return result;
  };
  const context = (): ContextResult => {
    const result = store.getContext(root);
    if (result.outcome !== "context") throw new Error("Expected context");
    return result;
  };
  const setRequests = (sql: string, ...parameters: Array<string | number>) =>
    databaseOf(store)
      .prepare(`UPDATE knowledge_candidate_requests SET ${sql}`)
      .run(...parameters);
  return { store, root, projectId: project.id, finalize, plain, confirmed, backlog, request, context, setRequests };
}

/** The oldest Session carries the signal; ten newer plain Sessions would fill a request by recency alone. */
function oldestWithSignalFirst(prepare: (fixture: ReturnType<typeof setup>) => string, check?: () => void) {
  const fixture = setup();
  const signalId = prepare(fixture);
  fixture.plain(10);
  const ids = fixture.request().request.sourceSessionIds;
  expect(ids).toHaveLength(10);
  expect(ids[0]).toBe(signalId);
  check?.();
}

describe("value ranking of uncovered Sessions", () => {
  it("lists confirmed decisions ahead of newer Sessions, more decisions first, capped at three", () => {
    const fixture = setup();
    const one = fixture.finalize("one", { decisions: fixture.confirmed("A") });
    const four = fixture.finalize("four", {
      decisions: ["A", "B", "C", "D"].map((text) => ({ text, origin: "user_requested" as const })),
    });
    const two = fixture.finalize("two", { decisions: ["A", "B"] });
    fixture.plain(9);
    expect(fixture.request().request.sourceSessionIds.slice(0, 3)).toEqual([four, two, one]);
    expect(
      scoreBacklogSession({
        confirmedDecisions: 9,
        verificationRecovered: false,
        inboundLinks: 0,
        rereads: 0,
        citedByKnowledge: false,
      }),
    ).toBe(BACKLOG_SCORE_WEIGHTS.decisionCap * BACKLOG_SCORE_WEIGHTS.decision);
  });

  it("does not count decisions that are still pending review", () => {
    const fixture = setup();
    const pending = fixture.finalize("pending", { decisions: [{ text: "Agent idea", origin: "agent_autonomous" }] });
    fixture.plain(10);
    expect(fixture.request().request.sourceSessionIds).not.toContain(pending);
  });

  it("falls back to the work summary for a Session without session_decisions rows", () => {
    oldestWithSignalFirst(({ finalize, confirmed, store }) => {
      const id = finalize("legacy", { decisions: confirmed("Old decision") });
      databaseOf(store).prepare("DELETE FROM session_decisions WHERE session_id = ?").run(id);
      return id;
    });
  });

  it("ranks a Session whose verification recovered from failed to passed", () => {
    oldestWithSignalFirst(({ finalize, store }) => {
      const id = finalize("fixed", { verification: "failed" });
      store.updateSessionVerification(id, { status: "passed" });
      return id;
    });
  });

  it("ranks a passed Session that continues a Session whose verification failed", () => {
    oldestWithSignalFirst(({ finalize, store }) => {
      const failed = finalize("broken", { verification: "failed" });
      const fix = finalize("follow-up", { verification: "passed" });
      store.linkSessions({ sessionId: fix, relatedSessionId: failed, relation: "continues", linked: true });
      // The failed Session is also built upon (one inbound link), so both outrank plain Sessions; the fix is first
      // because recovery weighs more than one inbound link.
      return fix;
    });
  });

  it("ranks Sessions that later work was linked to", () => {
    oldestWithSignalFirst(({ finalize, plain, store }) => {
      const base = finalize("base");
      const [later] = plain(1, "later");
      store.linkSessions({ sessionId: later!, relatedSessionId: base, relation: "continues", linked: true });
      return base;
    });
  });

  it("ranks Sessions an Agent read repeatedly, and counts a single read below the high-value line", () => {
    const fixture = setup();
    const reread = fixture.finalize("reread");
    const once = fixture.finalize("once");
    const onlySeen = fixture.finalize("only-seen");
    fixture.plain(8);
    const db = databaseOf(fixture.store);
    // Context and recall log every Session they return; those are not deliberate reads.
    ["work_get_context", "work_recall"].forEach((tool, index) => {
      db.prepare("INSERT INTO agent_read_audit (id, created_at, tool, outcome) VALUES (?, ?, ?, 'ok')").run(
        `seen-${index}`,
        "2026-02-01T00:00:00.000Z",
        tool,
      );
      db.prepare(
        "INSERT INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES (?, 'session', ?)",
      ).run(`seen-${index}`, onlySeen);
    });
    [0, 1, 2].forEach((index) => {
      db.prepare(
        "INSERT INTO agent_read_audit (id, created_at, tool, outcome) VALUES (?, ?, 'work_get_session', 'ok')",
      ).run(`read-${index}`, "2026-02-01T00:00:00.000Z");
      db.prepare(
        "INSERT INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES (?, 'session', ?)",
      ).run(`read-${index}`, reread);
    });
    db.prepare(
      "INSERT INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES ('read-0', 'session', ?)",
    ).run(once);
    const result = fixture.request();
    expect(result.request.sourceSessionIds.slice(0, 2)).toEqual([reread, once]);
    // 3 reads = 1.5 (high value); 1 read = 0.5 (ranked, but below the line); context/recall sightings score 0.
    // The oldest plain Session is left out; with a score it would have been ranked in.
    expect(result.request.sourceSessionIds).not.toContain(onlySeen);
    expect(result.remaining).toEqual({ uncoveredSessions: 1, highValueSessions: 0 });
  });

  it("does not count links from voided later Sessions", () => {
    const fixture = setup();
    const base = fixture.finalize("base");
    const [liveLater, voidedLater] = fixture.plain(2, "later");
    fixture.plain(9);
    for (const later of [liveLater!, voidedLater!]) {
      fixture.store.linkSessions({ sessionId: later, relatedSessionId: base, relation: "continues", linked: true });
    }
    databaseOf(fixture.store)
      .prepare("UPDATE sessions SET voided_at = '2026-02-01T00:00:00.000Z' WHERE id = ?")
      .run(voidedLater!);
    const ids = fixture.request().request.sourceSessionIds;
    expect(ids[0]).toBe(base);
    // One live inbound link scores 1.5; the voided one would have made it 3.
    expect(fixture.backlog()?.highValueSessions).toBe(0);
    expect(
      scoreBacklogSession({
        confirmedDecisions: 0,
        verificationRecovered: false,
        inboundLinks: 1,
        rereads: 0,
        citedByKnowledge: false,
      }),
    ).toBe(1.5);
  });

  it("places a Session that Knowledge already cites after Sessions with no signal", () => {
    const fixture = setup();
    const newestCited = (() => {
      fixture.plain(10);
      return fixture.finalize("cited");
    })();
    const recorded = fixture.store.recordKnowledge({
      projectRoot: fixture.root,
      idempotencyKey: "cites",
      kind: "gotcha",
      title: "Hose splits in frost",
      body: "Drain the hose before frost.",
      sessionId: newestCited,
    });
    expect(recorded.outcome).toBe("knowledge_recorded");
    expect(fixture.request().request.sourceSessionIds).not.toContain(newestCited);
  });

  it("falls back to newest first when no Session has a signal, and to the larger id on equal times", () => {
    const fixture = setup();
    const ids = fixture.plain(12);
    expect(fixture.request().request.sourceSessionIds).toEqual(ids.slice(2).reverse());
    const tied = selectTopBacklogSessions(
      [
        { id: "a", projectId: "p", completedAt: "2026-01-01T00:00:00.000Z", score: 0 },
        { id: "c", projectId: "p", completedAt: "2026-01-01T00:00:00.000Z", score: 0 },
        { id: "b", projectId: "p", completedAt: "2026-01-01T00:00:00.000Z", score: 0 },
      ],
      2,
    );
    expect(tied.map((session) => session.id)).toEqual(["c", "b"]);
  });
});

describe("request size and coverage", () => {
  it("takes ten Sessions and reports what remains", () => {
    const fixture = setup();
    fixture.plain(3);
    fixture.finalize("valuable-a", { decisions: fixture.confirmed("A") });
    fixture.plain(5, "mid");
    fixture.finalize("valuable-b", { decisions: fixture.confirmed("B") });
    fixture.plain(5, "late");
    const result = fixture.request();
    expect(result.request.sourceSessionIds).toHaveLength(10);
    expect(result.remaining).toEqual({ uncoveredSessions: 5, highValueSessions: 0 });
    expect(fixture.backlog()).toMatchObject({ uncoveredSessions: 5, highValueSessions: 0 });
  });

  it("leaves out Sessions listed by pending, processing, failed and completed requests, but not cancelled ones", () => {
    const fixture = setup();
    fixture.plain(25);
    const first = fixture.request();
    expect(fixture.backlog()?.uncoveredSessions).toBe(15);

    fixture.setRequests("status = 'processing', started_at = ?", new Date().toISOString());
    expect(fixture.backlog()?.uncoveredSessions).toBe(15);
    fixture.setRequests("status = 'failed', failure_reason = 'x'");
    expect(fixture.backlog()?.uncoveredSessions).toBe(15);
    fixture.setRequests("status = 'completed', completed_at = ?", new Date().toISOString());
    expect(fixture.backlog()?.uncoveredSessions).toBe(15);

    const second = fixture.request();
    expect(second.request.sourceSessionIds.filter((id) => first.request.sourceSessionIds.includes(id))).toEqual([]);
    expect(fixture.backlog()?.uncoveredSessions).toBe(5);

    fixture.setRequests("status = 'cancelled' WHERE id = ?", first.request.id);
    expect(fixture.backlog()?.uncoveredSessions).toBe(15);
  });

  it("ignores null entries in a damaged source list instead of emptying the backlog", () => {
    const fixture = setup();
    const ids = fixture.plain(4);
    fixture.request();
    fixture.setRequests("status = 'completed', source_session_ids_json = ?", JSON.stringify([ids[0], null, 7]));
    expect(fixture.backlog()?.uncoveredSessions).toBe(3);
  });

  it("reports nothing to request once every live Session is covered", () => {
    const fixture = setup();
    fixture.plain(3);
    fixture.request();
    expect(fixture.backlog()).toBeUndefined();
    fixture.setRequests("status = 'completed'");
    expect(fixture.store.requestKnowledgeCandidates(fixture.root).outcome).toBe("knowledge_candidates_not_needed");
  });

  it("ignores voided Sessions", () => {
    const fixture = setup();
    const ids = fixture.plain(4);
    databaseOf(fixture.store)
      .prepare("UPDATE sessions SET voided_at = ? WHERE id = ?")
      .run("2026-02-01T00:00:00.000Z", ids[3]!);
    expect(fixture.backlog()?.uncoveredSessions).toBe(3);
    expect(fixture.request().request.sourceSessionIds).not.toContain(ids[3]);
  });

  it("lists each tracked project's counts when no project is named, and none for an untracked one", () => {
    const fixture = setup();
    fixture.plain(2);
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-backlog-other-"));
    tempDirs.push(otherRoot);
    const other = fixture.store.addProject("Pasture", otherRoot);
    fixture.store.updateProject(other.id, { status: "tracked" });
    fixture.store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "other-1",
      title: "Pasture work",
      summary: "Fenced the pasture.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    const all = fixture.store.listKnowledgeCandidates({});
    if (all.outcome !== "knowledge_candidates") throw new Error("Expected a candidate list");
    expect(Object.fromEntries(all.backlog.map((entry) => [entry.projectId, entry.uncoveredSessions]))).toEqual({
      [fixture.projectId]: 2,
      [other.id]: 1,
    });
    fixture.store.updateProject(other.id, { status: "paused" });
    const paused = fixture.store.listKnowledgeCandidates({});
    if (paused.outcome !== "knowledge_candidates") throw new Error("Expected a candidate list");
    expect(paused.backlog.map((entry) => entry.projectId)).toEqual([fixture.projectId]);
    expect(fixture.store.listKnowledgeCandidates({ projectRoot: otherRoot }).outcome).toBe("skipped");
  });
});

describe("backlog in getContext", () => {
  function valuable(fixture: ReturnType<typeof setup>, count: number, prefix = "valuable"): string[] {
    return Array.from({ length: count }, (_, index) =>
      fixture.finalize(`${prefix}-${index}`, { decisions: fixture.confirmed(`Decision ${index}`) }),
    );
  }

  it("appears only at five high-value Sessions", () => {
    const fixture = setup();
    valuable(fixture, 4);
    fixture.plain(6);
    expect(fixture.context().pendingRequests).not.toHaveProperty("knowledgeBacklog");
    valuable(fixture, 1, "extra");
    expect(fixture.context().pendingRequests.knowledgeBacklog).toEqual({
      uncoveredSessions: 11,
      highValueSessions: 5,
      requestWith: "work_request_knowledge_candidates",
    });
  });

  it("stays hidden while a request is open, including a failed one that is listed with its status", () => {
    const fixture = setup();
    valuable(fixture, 14);
    fixture.request();
    expect(fixture.context().pendingRequests).not.toHaveProperty("knowledgeBacklog");
    fixture.setRequests("status = 'failed', failure_reason = 'interrupted'");
    const pending = fixture.context().pendingRequests;
    expect(pending.knowledgeCandidates.map((request) => request.status)).toEqual(["failed"]);
    expect(pending).not.toHaveProperty("knowledgeBacklog");
    expect(fixture.store.requestKnowledgeCandidates(fixture.root)).toMatchObject({ duplicate: true });
  });

  it("stays hidden for a week after the last request, then returns", () => {
    const fixture = setup();
    valuable(fixture, 16);
    fixture.request();
    fixture.setRequests("status = 'completed', requested_at = ?", new Date(Date.now() - 6 * DAY_MS).toISOString());
    expect(fixture.context().pendingRequests).not.toHaveProperty("knowledgeBacklog");
    fixture.setRequests("requested_at = ?", new Date(Date.now() - 8 * DAY_MS).toISOString());
    expect(fixture.context().pendingRequests.knowledgeBacklog).toMatchObject({
      uncoveredSessions: 6,
      highValueSessions: 6,
    });
  });

  it("is never part of an unscoped context and follows the project policy", () => {
    const fixture = setup();
    valuable(fixture, 6);
    const unscoped = fixture.store.getContext();
    if (unscoped.outcome !== "context") throw new Error("Expected context");
    expect(unscoped.pendingRequests).not.toHaveProperty("knowledgeBacklog");
    fixture.store.updateProject(fixture.projectId, { status: "paused" });
    expect(fixture.store.getContext(fixture.root).outcome).toBe("skipped");
  });

  function watchScoring(fixture: ReturnType<typeof setup>) {
    const db = databaseOf(fixture.store);
    const prepare = db.prepare.bind(db);
    const scoring: string[] = [];
    db.prepare = (sql: string) => {
      if (sql.includes("cited_by_knowledge")) scoring.push(sql);
      return prepare(sql);
    };
    return { scoring, restore: () => (db.prepare = prepare) };
  }

  it("reuses one snapshot until the data revision moves, without scoring again", () => {
    const fixture = setup();
    valuable(fixture, 6);
    fixture.context();
    const watch = watchScoring(fixture);
    try {
      fixture.context();
      fixture.context();
      expect(watch.scoring).toEqual([]);

      fixture.finalize("late", { decisions: fixture.confirmed("Late") });
      expect(fixture.context().pendingRequests.knowledgeBacklog).toMatchObject({ uncoveredSessions: 7 });
      expect(watch.scoring).toHaveLength(1);
    } finally {
      watch.restore();
    }
  });

  it("does not score while the last request is recent, and scores once after the window passes", () => {
    const fixture = setup();
    valuable(fixture, 16);
    fixture.request();
    fixture.setRequests("status = 'completed', requested_at = ?", new Date(Date.now() - 3 * DAY_MS).toISOString());
    const watch = watchScoring(fixture);
    try {
      // Every write moves the revision, so each context call below is a cold one.
      for (const key of ["w1", "w2"]) {
        fixture.finalize(key, { decisions: fixture.confirmed(key) });
        expect(fixture.context().pendingRequests).not.toHaveProperty("knowledgeBacklog");
      }
      expect(watch.scoring).toEqual([]);

      fixture.setRequests("requested_at = ?", new Date(Date.now() - 8 * DAY_MS).toISOString());
      expect(fixture.context().pendingRequests.knowledgeBacklog).toMatchObject({ uncoveredSessions: 8 });
      fixture.context();
      expect(watch.scoring).toHaveLength(1);
    } finally {
      watch.restore();
    }
  });
});
