import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const CLIENT = "fictional-agent";
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-unreported-knowledge-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const now = () => new Date(Date.now()).toISOString();
  const record = (key: string, title = `Orchard rule ${key}`, appliesTo?: string[]) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `knowledge-${key}`,
      kind: "gotcha",
      title,
      body: `Prune the ${key} rows before the frost.`,
      ...(appliesTo ? { appliesTo } : {}),
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge.id;
  };
  const read = (
    knowledgeIds: string[],
    options: { tool?: string; agentClient?: string; connectionId?: string; projectId?: string; compact?: boolean } = {},
  ) => {
    tick();
    const projectId = options.projectId ?? project.id;
    store.recordAgentRead({
      tool: options.tool ?? "work_get_context",
      agentClient: options.agentClient ?? CLIENT,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      projectId,
      result: {
        items: knowledgeIds.map((id) =>
          options.compact
            ? { id, projectId, kind: "gotcha", title: "compact", status: "active" }
            : { id, projectId, kind: "gotcha", title: "full", body: "Body returned to the Agent." },
        ),
      },
      now: now(),
    });
  };
  const finalize = (
    key: string,
    overrides: Partial<FinalizeSessionInput> = {},
    agentClient: string | undefined = CLIENT,
    connection: { connectionId?: string; previousSaveAt?: string } = {},
  ) => {
    tick();
    const result = store.finalizeSession(
      {
        projectRoot: root,
        idempotencyKey: key,
        title: `Session ${key}`,
        summary: `${key} summary.`,
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        ...overrides,
      },
      agentClient ? { agentClient, ...connection } : {},
    );
    if (result.outcome !== "finalized") throw new Error("Expected finalize.");
    return result;
  };
  return { store, root, project, tick, now, record, read, finalize };
}

function databaseOf(store: WorkIntelligenceStore) {
  return (store as unknown as { db: DatabaseSync }).db;
}

function feedbackRows(store: WorkIntelligenceStore, sessionId: string) {
  return databaseOf(store)
    .prepare("SELECT knowledge_id, kind FROM knowledge_feedback WHERE session_id = ? ORDER BY knowledge_id, kind")
    .all(sessionId);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("unreported Knowledge on finalize", () => {
  it("lists the recalled Knowledge this work read but did not report, newest read first", () => {
    const { record, read, finalize, now } = setup();
    const [first, second, third] = [record("a"), record("b"), record("c")];
    const startedAt = now();
    read([first]);
    read([second, third]);
    read([second], { tool: "work_search_knowledge" });

    const result = finalize("three-read-one-reported", { startedAt, appliedKnowledgeIds: [first] });

    expect(result.knowledgeFeedback).toEqual({ applied: 1, contradicted: 0 });
    expect(result.unreportedKnowledge).toEqual({
      items: [
        { id: second, title: "Orchard rule b" },
        { id: third, title: "Orchard rule c" },
      ],
      total: 2,
    });
  });

  it("adds nothing when every read Knowledge was reported or nothing was read", () => {
    const { record, read, finalize, now } = setup();
    const [kept, wrong] = [record("kept"), record("wrong")];
    const quietStart = now();
    const quiet = finalize("nothing-read", { startedAt: quietStart });
    expect(quiet).not.toHaveProperty("unreportedKnowledge");
    expect(quiet).not.toHaveProperty("knowledgeFeedback");

    const startedAt = now();
    read([kept, wrong]);
    const reported = finalize("all-reported", {
      startedAt,
      appliedKnowledgeIds: [kept],
      contradictedKnowledgeIds: [wrong],
    });
    expect(reported).not.toHaveProperty("unreportedKnowledge");
    expect(reported.knowledgeFeedback).toEqual({ applied: 1, contradicted: 1 });
  });

  it("counts only full recall reads by the same client in this project during this work", () => {
    const { store, root, record, read, finalize, now, tick } = setup();
    const other = store.addProject("Vineyard", join(root, "vineyard"));
    store.updateProject(other.id, { status: "tracked" });
    const ids = Object.fromEntries(
      ["before", "previousSave", "otherClient", "compact", "history", "archived", "otherProject", "counted"].map(
        (name) => [name, record(name)],
      ),
    );
    const startedAt = now();
    read([ids.before!]);
    tick();
    const previous = finalize("previous-save", { startedAt });
    expect(previous.unreportedKnowledge?.items.map((item) => item.id)).toEqual([ids.before]);
    read([ids.previousSave!]);
    finalize("previous-save-2", { startedAt: now() });
    read([ids.otherClient!], { agentClient: "another-agent" });
    read([ids.compact!], { compact: true });
    read([ids.history!], { tool: "work_get_knowledge_history" });
    read([ids.archived!]);
    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: ids.archived!, status: "archived" });
    read([ids.otherProject!], { projectId: other.id });
    read([ids.counted!]);

    const result = finalize("scoped", { startedAt });

    expect(result.unreportedKnowledge).toEqual({
      items: [{ id: ids.counted, title: "Orchard rule counted" }],
      total: 1,
    });
  });

  it("skips backfills, Sessions without a start, and saves without a known client", () => {
    const { record, read, finalize, now } = setup();
    const knowledgeId = record("skip");
    const startedAt = now();
    read([knowledgeId]);

    expect(finalize("backfill", { startedAt, completedAt: now() })).not.toHaveProperty("unreportedKnowledge");
    expect(finalize("no-start")).not.toHaveProperty("unreportedKnowledge");
    expect(finalize("no-client", { startedAt }, undefined)).not.toHaveProperty("unreportedKnowledge");
  });

  it("lists at most three with the total, shortens long titles, and leaves out knowledgeToReview items", () => {
    const { record, read, finalize, now } = setup();
    const long = record("long", `${"Graft the long orchard row ".repeat(5)}carefully`);
    const reviewed = record("review", "Orchard path rule", ["src/orchard.ts"]);
    const others = [record("d"), record("e"), record("f")];
    const startedAt = now();
    read([reviewed, ...others]);
    read([long]);

    const result = finalize("capped", { startedAt, changedFiles: ["src/orchard.ts"] });

    expect(result.knowledgeToReview?.map((hint) => hint.id)).toEqual([reviewed]);
    expect(result.unreportedKnowledge?.total).toBe(4);
    expect(result.unreportedKnowledge?.items).toHaveLength(3);
    expect(result.unreportedKnowledge?.items[0]).toEqual({ id: long, title: expect.stringMatching(/^Graft.*…$/) });
    expect(result.unreportedKnowledge?.items[0]!.title).toHaveLength(80);
    expect(result.unreportedKnowledge?.items.map((item) => item.id)).not.toContain(reviewed);
  });

  it("keeps a committed finalize when the unreported lookup fails", () => {
    const { store, record, read, finalize, now } = setup();
    const knowledgeId = record("lookup");
    const startedAt = now();
    read([knowledgeId]);
    const db = databaseOf(store);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("WITH bounds")) throw new Error("lookup failed");
      return prepare(sql);
    });

    const result = finalize("lookup-failure", { startedAt });

    expect(result).toMatchObject({ outcome: "finalized", duplicate: false });
    expect(result).not.toHaveProperty("unreportedKnowledge");
  });
});

describe("unreported Knowledge of concurrent works on one client", () => {
  const idsOf = (result: ReturnType<ReturnType<typeof setup>["finalize"]>) =>
    result.unreportedKnowledge?.items.map((item) => item.id).sort();

  function interleave() {
    const env = setup();
    const { record, read, tick, now } = env;
    const ids = Object.fromEntries(["a1", "a2", "b1", "b2"].map((name) => [name, record(name)]));
    const startedA = now();
    read([ids.a1!], { connectionId: "connection-a" });
    tick();
    const startedB = now();
    read([ids.b1!], { connectionId: "connection-b" });
    read([ids.a2!], { connectionId: "connection-a" });
    read([ids.b2!], { connectionId: "connection-b" });
    return { ...env, ids, startedA, startedB };
  }

  it.each([
    ["A first", ["a", "b"]],
    ["B first", ["b", "a"]],
  ] as const)("lists only each connection's own reads when finalizing %s", (_name, order) => {
    const { finalize, ids, startedA, startedB } = interleave();
    const works = {
      a: { startedAt: startedA, connectionId: "connection-a", expected: [ids.a1, ids.a2] },
      b: { startedAt: startedB, connectionId: "connection-b", expected: [ids.b1, ids.b2] },
    };

    for (const key of order) {
      const work = works[key];
      const result = finalize(`work-${key}`, { startedAt: work.startedAt }, CLIENT, {
        connectionId: work.connectionId,
      });
      expect(idsOf(result)).toEqual([...work.expected].sort());
      expect(result.unreportedKnowledge?.total).toBe(2);
    }
  });

  it("starts the work window at the connection's previous save", () => {
    const { record, read, finalize, now, tick } = setup();
    const earlier = record("earlier");
    const later = record("later");
    const startedAt = now();
    read([earlier], { connectionId: "connection-a" });
    tick();
    const previousSaveAt = now();
    tick();
    read([later], { connectionId: "connection-a" });

    const result = finalize("second-work", { startedAt }, CLIENT, { connectionId: "connection-a", previousSaveAt });

    expect(idsOf(result)).toEqual([later]);
  });

  it("does not count audit rows without a connection id when a connection is given", () => {
    const { record, read, finalize, now } = setup();
    const legacy = record("legacy");
    const own = record("own");
    const startedAt = now();
    read([legacy]);
    read([own], { connectionId: "connection-a" });

    const result = finalize("connection-work", { startedAt }, CLIENT, { connectionId: "connection-a" });

    expect(idsOf(result)).toEqual([own]);
  });
});

describe("reporting Knowledge after the save", () => {
  it("records applied and contradicted Knowledge through a metadata update, once", () => {
    const { store, root, record, read, finalize, now, tick } = setup();
    const [used, wrong, unused] = [record("used"), record("wrong"), record("unused")];
    const startedAt = now();
    read([used, wrong, unused]);
    const saved = finalize("late-report", { startedAt });
    expect(saved.unreportedKnowledge?.total).toBe(3);
    const sessionId = saved.session.id;

    tick();
    const update = {
      sessionId,
      appliedKnowledgeIds: [used, "missing-knowledge"],
      contradictedKnowledgeIds: [wrong],
    };
    const first = store.updateSessionMetadata(update);
    expect(first).toMatchObject({
      outcome: "updated",
      knowledgeFeedback: { applied: 1, contradicted: 1 },
      knowledgeWarnings: ["missing-knowledge: Knowledge was not found in this project."],
    });
    const historyCount = (id: string) => {
      const history = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: id });
      return history.outcome === "knowledge_history" ? history.history.length + history.feedback.length : -1;
    };
    const historyBefore = [historyCount(used), historyCount(wrong)];
    const feedbackBefore = feedbackRows(store, sessionId);

    tick();
    const repeated = store.updateSessionMetadata(update);
    expect(repeated).toMatchObject({ outcome: "updated", knowledgeFeedback: { applied: 1, contradicted: 1 } });
    expect([historyCount(used), historyCount(wrong)]).toEqual(historyBefore);
    expect(feedbackRows(store, sessionId)).toEqual(feedbackBefore);
    expect(feedbackRows(store, sessionId)).toEqual(
      [
        { knowledge_id: used, kind: "applied" },
        { knowledge_id: wrong, kind: "contradicted" },
      ].sort((left, right) => left.knowledge_id.localeCompare(right.knowledge_id)),
    );

    const knowledge = store.searchKnowledge({ projectRoot: root, limit: 10 });
    expect(knowledge.outcome).toBe("knowledge");
    if (knowledge.outcome !== "knowledge") throw new Error("Expected Knowledge.");
    const byId = new Map(knowledge.items.map((item) => [item.id, item]));
    expect(byId.get(used)).toMatchObject({ lastConfirmedSessionId: sessionId });
    expect(byId.get(wrong)).toMatchObject({ review: { reason: "contradicted", sessionId } });

    const retry = finalize("late-report", { startedAt });
    expect(retry).toMatchObject({ duplicate: true, unreportedKnowledge: { items: [{ id: unused }], total: 1 } });
  });

  it("leaves an update without Knowledge ids unchanged in shape", () => {
    const { store, finalize, now } = setup();
    const saved = finalize("plain-update", { startedAt: now() });
    const result = store.updateSessionMetadata({ sessionId: saved.session.id, startedAt: saved.session.startedAt });
    expect(result).not.toHaveProperty("knowledgeFeedback");
    expect(result).not.toHaveProperty("knowledgeWarnings");
  });
});
