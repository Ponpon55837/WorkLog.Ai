import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-void-test-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Void project", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, overrides: Partial<FinalizeSessionInput> = {}) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `Beehive ${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [`Decision ${key}.`], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "not_run" },
      ...overrides,
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result.session.id;
  };
  return { store, root, projectId: project.id, finalize };
}

describe("voiding Sessions", () => {
  it("hides a voided Session everywhere except its own detail, and restores it", () => {
    const { store, root, finalize } = setup();
    const kept = finalize("kept");
    const mistake = finalize("mistake");

    const voided = store.setSessionVoid({ sessionId: mistake, voided: true, reason: "Recorded as a test." });
    expect(voided).toMatchObject({
      outcome: "session_void_updated",
      duplicate: false,
      session: { id: mistake, voided: { reason: "Recorded as a test." } },
    });

    expect(store.listSessions().map((session) => session.id)).toEqual([kept]);
    expect(store.listSessions({ voided: "only" }).map((session) => session.id)).toEqual([mistake]);
    expect(store.listSessions({ voided: "include" })).toHaveLength(2);
    expect(store.getDashboardSummary().finalizedSessions).toBe(1);

    const report = store.getReport({ period: "week" });
    expect(report.outcome === "report" && report.sessions.map((session) => session.id)).toEqual([kept]);

    const graph = store.getGraph({});
    expect(graph.outcome === "graph" && graph.nodes.some((node) => node.sessionId === mistake)).toBe(false);

    const context = store.getContext(root);
    if (context.outcome !== "context") {
      throw new Error("Expected context");
    }
    expect(context.recentSessions.map((session) => session.id)).toEqual([kept]);
    expect(context.recentDecisions.map((decision) => decision.sessionId)).toEqual([kept]);
    expect(context.metadataFollowUps.needsBackfill).toBe(1);

    const recall = store.recall({ q: "beehive mistake" });
    expect(recall.outcome === "recall" && recall.hits.map((hit) => hit.id)).not.toContain(mistake);

    const detail = store.getSessionDetail(mistake);
    expect(detail?.session.voided?.reason).toBe("Recorded as a test.");
    expect(detail?.voidHistory).toEqual([
      expect.objectContaining({ targetType: "session", action: "voided", reason: "Recorded as a test." }),
    ]);

    expect(store.setSessionVoid({ sessionId: mistake, voided: true, reason: "Again." })).toMatchObject({
      duplicate: true,
      session: { voided: { reason: "Recorded as a test." } },
    });

    const restored = store.setSessionVoid({ sessionId: mistake, voided: false });
    expect(restored).toMatchObject({ outcome: "session_void_updated", duplicate: false });
    expect(restored.outcome === "session_void_updated" && restored.session.voided).toBeUndefined();
    expect(store.listSessions()).toHaveLength(2);
    const afterRestore = store.recall({ q: "beehive mistake" });
    expect(afterRestore.outcome === "recall" && afterRestore.hits.map((hit) => hit.id)).toContain(mistake);
    expect(store.getSessionDetail(mistake)?.voidHistory.map((entry) => entry.action)).toEqual(["restored", "voided"]);
  });

  it("requires a reason, reports missing Sessions, and respects the project policy", () => {
    const { store, projectId, finalize } = setup();
    const sessionId = finalize("policy");

    expect(() => store.setSessionVoid({ sessionId, voided: true, reason: "  " })).toThrow(/reason/);
    expect(store.setSessionVoid({ sessionId: "missing", voided: true, reason: "x" })).toEqual({
      outcome: "not_found",
      sessionId: "missing",
    });
    store.updateProject(projectId, { status: "paused" });
    expect(store.setSessionVoid({ sessionId, voided: true, reason: "x" })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });
});

describe("voiding evidence", () => {
  it("keeps voided evidence in detail but drops it from reports and the graph", () => {
    const { store, finalize } = setup();
    const sessionId = finalize("evidence");
    const attached = store.attachEvidence({
      sessionId,
      kind: "test-result",
      reference: "hive-tests.log",
      summary: "Wrong log attached.",
    });
    if (attached.outcome !== "evidence_attached") {
      throw new Error("Expected evidence");
    }
    const evidenceId = attached.evidence.id;

    const countAttached = () => {
      const report = store.getReport({ period: "week", includeAllEvidence: true });
      return report.outcome === "report"
        ? report.evidence.filter((item) => item.reference === "hive-tests.log").length
        : -1;
    };
    const graphHasEvidence = () => {
      const graph = store.getGraph({});
      return graph.outcome === "graph" && graph.nodes.some((node) => node.kind === "evidence");
    };
    expect(countAttached()).toBe(1);
    expect(graphHasEvidence()).toBe(true);

    expect(store.setEvidenceVoid({ evidenceId, voided: true, reason: "Belongs to another run." })).toMatchObject({
      outcome: "evidence_void_updated",
      duplicate: false,
      evidence: { id: evidenceId, voided: { reason: "Belongs to another run." } },
    });
    expect(countAttached()).toBe(0);
    expect(graphHasEvidence()).toBe(false);
    const detail = store.getSessionDetail(sessionId);
    expect(detail?.evidence[0]?.voided?.reason).toBe("Belongs to another run.");
    expect(detail?.voidHistory[0]).toMatchObject({ targetType: "evidence", targetId: evidenceId });

    store.setEvidenceVoid({ evidenceId, voided: false });
    expect(countAttached()).toBe(1);
    expect(store.setEvidenceVoid({ evidenceId: "missing", voided: false })).toEqual({
      outcome: "not_found",
      evidenceId: "missing",
    });
  });
});

describe("correcting verification", () => {
  it("updates verification in place and keeps every change in the verification audit", () => {
    const { store, finalize } = setup();
    const sessionId = finalize("verify");

    const corrected = store.updateSessionVerification(sessionId, { status: "passed", summary: " pnpm test " }, "web");
    expect(corrected).toMatchObject({
      outcome: "updated",
      previous: { status: "not_run" },
      session: { verification: { status: "passed", summary: "pnpm test" } },
    });
    expect(store.updateSessionVerification(sessionId, { status: "passed", summary: "pnpm test" }, "web")).toMatchObject(
      {
        unchanged: true,
      },
    );

    store.updateSessionMetadata({
      sessionId,
      changedFiles: [],
      changedFilesMode: "merge",
      verification: { status: "failed", summary: "Flaky suite." },
    });
    expect(store.getSessionDetail(sessionId)?.verificationHistory).toEqual([
      expect.objectContaining({
        source: "agent",
        previous: { status: "passed", summary: "pnpm test" },
        resulting: { status: "failed", summary: "Flaky suite." },
      }),
      expect.objectContaining({ source: "web", previous: { status: "not_run" }, resulting: expect.anything() }),
    ]);
  });
});

describe("linking Sessions", () => {
  it("links a planning Session to its implementation both ways and surfaces the link in recall and the graph", () => {
    const { store, root, finalize } = setup();
    const plan = finalize("plan", { title: "Plan the pollination scheduler" });
    const build = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "build",
      title: "Implement the pollination scheduler",
      summary: "Built it.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      parentSessionId: plan,
      relatedSessionIds: ["missing-session"],
    });
    if (build.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    expect(build.linkWarnings).toEqual(["missing-session: The related Session does not exist."]);

    expect(store.getSessionDetail(build.session.id)?.links).toEqual([
      expect.objectContaining({ sessionId: plan, relation: "continues" }),
    ]);
    expect(store.getSessionDetail(plan)?.links).toEqual([
      expect.objectContaining({ sessionId: build.session.id, relation: "continued_by" }),
    ]);

    const recall = store.recall({ q: "plan pollination" });
    const planHit = recall.outcome === "recall" ? recall.hits.find((hit) => hit.id === plan) : undefined;
    expect(planHit?.related).toEqual([
      { id: build.session.id, title: "Implement the pollination scheduler", relation: "continued_by" },
    ]);

    const graph = store.getGraph({});
    expect(graph.outcome === "graph" && graph.edges.filter((edge) => edge.kind === "session_link")).toEqual([
      expect.objectContaining({ from: `session:${plan}`, to: `session:${build.session.id}` }),
    ]);

    store.setSessionVoid({ sessionId: build.session.id, voided: true, reason: "test" });
    const afterVoid = store.recall({ q: "plan pollination" });
    expect(afterVoid.outcome === "recall" && afterVoid.hits.find((hit) => hit.id === plan)?.related).toBeUndefined();
    expect(store.getSessionDetail(plan)?.links[0]).toMatchObject({ voided: true });
  });

  it("sends a link whose Sessions land on different graph pages so the pages can be joined", () => {
    const { store, finalize } = setup();
    const keys = Array.from({ length: 8 }, (_, index) => finalize(`paged-${index}`));
    const [first, last] = [keys[0]!, keys[keys.length - 1]!];
    store.linkSessions({ sessionId: last, relatedSessionId: first, relation: "related", linked: true });

    const pages: Array<{ nodes: Set<string>; links: string[] }> = [];
    let cursor: string | undefined;
    do {
      const page = store.getGraph({ pageSize: 3, cursor });
      if (page.outcome !== "graph") {
        throw new Error("Expected a graph page");
      }
      pages.push({
        nodes: new Set(page.nodes.map((node) => node.id)),
        links: page.edges.filter((edge) => edge.kind === "session_link").map((edge) => edge.id),
      });
      cursor = page.nextCursor;
    } while (cursor && pages.length < 20);

    const linkId = `session_link:${last}:${first}`;
    const withLink = pages.filter((page) => page.links.includes(linkId));
    expect(withLink.length).toBeGreaterThan(0);
    expect(withLink.every((page) => !(page.nodes.has(`session:${first}`) && page.nodes.has(`session:${last}`)))).toBe(
      true,
    );
    const allNodes = new Set(pages.flatMap((page) => [...page.nodes]));
    expect(allNodes.has(`session:${first}`) && allNodes.has(`session:${last}`)).toBe(true);
  });

  it("replaces, removes, and rejects links", () => {
    const { store, projectId, finalize } = setup();
    const first = finalize("first");
    const second = finalize("second");

    expect(
      store.linkSessions({ sessionId: first, relatedSessionId: second, relation: "related", linked: true }),
    ).toMatchObject({
      outcome: "session_link_updated",
      duplicate: false,
      links: [expect.objectContaining({ sessionId: second, relation: "related" })],
    });
    expect(
      store.linkSessions({ sessionId: first, relatedSessionId: second, relation: "related", linked: true }),
    ).toMatchObject({
      duplicate: true,
    });
    expect(
      store.linkSessions({ sessionId: second, relatedSessionId: first, relation: "continues", linked: true }, "web"),
    ).toMatchObject({
      duplicate: false,
      links: [expect.objectContaining({ sessionId: first, relation: "continues" })],
    });
    expect(store.getSessionDetail(first)?.links).toEqual([expect.objectContaining({ relation: "continued_by" })]);

    expect(
      store.linkSessions({ sessionId: first, relatedSessionId: second, relation: "related", linked: false }),
    ).toMatchObject({
      duplicate: false,
      links: [],
    });
    expect(
      store.linkSessions({ sessionId: first, relatedSessionId: first, relation: "related", linked: true }),
    ).toMatchObject({
      outcome: "invalid_link",
    });
    expect(
      store.linkSessions({ sessionId: "missing", relatedSessionId: first, relation: "related", linked: true }),
    ).toEqual({
      outcome: "not_found",
      sessionId: "missing",
    });
    store.updateProject(projectId, { status: "paused" });
    expect(
      store.linkSessions({ sessionId: first, relatedSessionId: second, relation: "related", linked: true }),
    ).toMatchObject({
      outcome: "skipped",
    });
  });
});

describe("Session start and update times", () => {
  it("keeps a reported start, derives one from earlier events, and never invents one", () => {
    const { store, root } = setup();
    const base = {
      projectRoot: root,
      summary: "Times.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" as const },
      completedAt: "2030-01-02T09:00:00.000Z",
    };
    const finalizeWith = (key: string, extra: Partial<FinalizeSessionInput>) => {
      const result = store.finalizeSession({ ...base, idempotencyKey: key, title: key, ...extra });
      if (result.outcome !== "finalized") {
        throw new Error("Expected finalize");
      }
      return result.session;
    };

    expect(finalizeWith("reported", { startedAt: "2030-01-01T15:00:00.000Z" })).toMatchObject({
      startedAt: "2030-01-01T15:00:00.000Z",
      completedAt: "2030-01-02T09:00:00.000Z",
    });
    expect(
      finalizeWith("derived", {
        events: [
          { type: "planning", summary: "Planned.", occurredAt: "2030-01-01T20:00:00.000Z" },
          { type: "execution", summary: "Built.", occurredAt: "2030-01-02T08:00:00.000Z" },
        ],
      }).startedAt,
    ).toBe("2030-01-01T20:00:00.000Z");
    expect(finalizeWith("after-completion", { startedAt: "2030-01-03T00:00:00.000Z" }).startedAt).toBeUndefined();
    expect(finalizeWith("unknown", {}).startedAt).toBeUndefined();

    const unknown = store.listSessions({ voided: "include" }).find((session) => session.title === "unknown")!;
    store.updateSessionMetadata({
      sessionId: unknown.id,
      changedFiles: [],
      changedFilesMode: "merge",
      startedAt: "2030-01-02T07:30:00.000Z",
    });
    expect(store.getSessionById(unknown.id)?.startedAt).toBe("2030-01-02T07:30:00.000Z");
  });

  it("moves updatedAt forward on every later change but not on finalize", () => {
    const { store, finalize } = setup();
    const sessionId = finalize("updates");
    const other = finalize("other");
    const created = store.getSessionById(sessionId)!;
    expect(created.updatedAt).toBe(created.createdAt);

    let last = created.updatedAt;
    const expectMoved = () => {
      const now = store.getSessionById(sessionId)!.updatedAt;
      expect(now >= last).toBe(true);
      last = now;
      return now;
    };
    const wait = () => {
      const until = Date.now() + 5;
      while (Date.now() < until) {
        // Timestamps have millisecond precision; make each change observable.
      }
    };

    wait();
    store.updateSessionSummary({ sessionId, idempotencyKey: "u-1", mode: "append", summary: "Follow-up." });
    expect(expectMoved() > created.updatedAt).toBe(true);
    wait();
    store.attachEvidence({ sessionId, kind: "command", reference: "pnpm test" });
    const afterEvidence = expectMoved();
    wait();
    store.linkSessions({ sessionId, relatedSessionId: other, relation: "related", linked: true });
    expect(expectMoved() > afterEvidence).toBe(true);
    expect(store.getSessionById(other)!.updatedAt).toBe(last);
    wait();
    store.updateSessionVerification(sessionId, { status: "passed" }, "web");
    expect(expectMoved() > afterEvidence).toBe(true);
  });

  it("backfills start and update times for Sessions written before the migration", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "work-intelligence-times-")), "times.sqlite");
    tempDirs.push(dirname(databasePath));
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-times-root-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(databasePath);
    const project = store.addProject("Times", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "legacy-times",
      title: "Legacy",
      summary: "Legacy.",
      changedFiles: [],
      verification: { status: "passed" },
      events: [{ type: "planning", summary: "Planned.", occurredAt: "2020-01-01T00:00:00.000Z" }],
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    store.updateSessionSummary({
      sessionId: finalized.session.id,
      idempotencyKey: "legacy-edit",
      mode: "append",
      summary: "Edited later.",
    });
    const editedAt = store.getSessionById(finalized.session.id)!.updatedAt;
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE sessions DROP COLUMN started_at;
      ALTER TABLE sessions DROP COLUMN updated_at;
      DELETE FROM schema_migrations WHERE version = 6;
    `);
    database.close();

    const reopened = new WorkIntelligenceStore(databasePath);
    stores.push(reopened);
    expect(reopened.getSessionById(finalized.session.id)).toMatchObject({
      startedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: editedAt,
    });
  });
});
