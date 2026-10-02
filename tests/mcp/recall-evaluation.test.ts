import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import {
  createReadOnlySnapshot,
  evaluateRecallQuestions,
  parseRecallEvaluationQuestions,
} from "../../apps/mcp/src/recall-evaluation.js";

const stores: WorkIntelligenceStore[] = [];
const temporaryRoots: string[] = [];

function setupFileStore(): {
  databasePath: string;
  projectRoot: string;
  store: WorkIntelligenceStore;
  temporaryRoot: string;
} {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "wi-recall-eval-test-"));
  temporaryRoots.push(temporaryRoot);
  const databasePath = join(temporaryRoot, "source.sqlite");
  const projectRoot = join(temporaryRoot, "synthetic-project");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Synthetic recall project", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  return { databasePath, projectRoot, store, temporaryRoot };
}

function createRecallFixtures(
  store: WorkIntelligenceStore,
  projectRoot: string,
): { knowledgeId: string; sessionId: string } {
  const session = store.finalizeSession({
    projectRoot,
    idempotencyKey: "recall-evaluation-session",
    title: "Aurora moss relay calibration",
    summary: "Validated the aurora moss irrigation relay startup calibration after a cold restart.",
    workSummary: {
      outcomes: ["Verified stable startup calibration."],
      scope: ["src/relay.ts"],
      decisions: [],
      verification: ["Synthetic relay restart passed."],
      nextSteps: [],
    },
    changedFiles: ["src/relay.ts"],
    verification: { status: "passed" },
  });
  if (session.outcome !== "finalized") throw new Error("Expected the synthetic Session to finalize.");
  const knowledge = store.recordKnowledge({
    projectRoot,
    idempotencyKey: "recall-evaluation-knowledge",
    kind: "gotcha",
    title: "Aurora moss relay restart drift",
    body: "After restart, verify the aurora moss relay before repeating calibration.",
  });
  if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected synthetic Knowledge to be recorded.");
  return { sessionId: session.session.id, knowledgeId: knowledge.knowledge.id };
}

function readDatabaseState(databasePath: string): Record<string, unknown> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      sessions: database.prepare("SELECT id, title, summary FROM sessions ORDER BY id").all(),
      knowledge: database.prepare("SELECT id, title, body FROM knowledge ORDER BY id").all(),
      searchChunks: database.prepare("SELECT doc_type, doc_id, field, content FROM search_chunks ORDER BY id").all(),
      searchDirty: database.prepare("SELECT doc_type, doc_id FROM search_dirty ORDER BY doc_type, doc_id").all(),
      searchPaths: database.prepare("SELECT doc_type, doc_id, path FROM search_paths ORDER BY doc_id, path").all(),
      ftsRows: database.prepare("SELECT rowid, tokens FROM search_fts ORDER BY rowid").all(),
    };
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("recall evaluator", () => {
  it("runs recall and context through MCP using a read-only source snapshot and keeps WAL/index state unchanged", async () => {
    const { databasePath, projectRoot, store, temporaryRoot } = setupFileStore();
    const { knowledgeId, sessionId } = createRecallFixtures(store, projectRoot);
    const scratchParent = join(temporaryRoot, "scratch");
    mkdirSync(scratchParent);

    const beforeState = readDatabaseState(databasePath);
    const beforeDatabase = readFileSync(databasePath);
    const walPath = `${databasePath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const beforeWal = readFileSync(walPath);
    const dirty = beforeState.searchDirty as Array<{ doc_type: string; doc_id: string }>;
    expect(dirty).toContainEqual({ doc_type: "session", doc_id: sessionId });
    expect(dirty).toContainEqual({ doc_type: "knowledge", doc_id: knowledgeId });
    expect(beforeState.searchChunks).toEqual([]);

    const questions = parseRecallEvaluationQuestions([
      {
        id: "recall-positive",
        mode: "recall",
        query: "aurora moss relay",
        projectRoot,
        expectedIds: [sessionId, knowledgeId],
        expectedConfidence: "high",
      },
      {
        id: "context-positive",
        mode: "context",
        query: "aurora moss relay",
        projectRoot,
        expectedIds: [sessionId, knowledgeId],
      },
      {
        id: "no-hit",
        mode: "recall",
        query: "lunar glass metronome",
        projectRoot,
        expectedNoHit: true,
        expectedConfidence: "none",
      },
      {
        id: "context-no-hit",
        mode: "context",
        query: "lunar glass metronome",
        projectRoot,
        expectedNoHit: true,
        expectedConfidence: "none",
      },
    ]);
    const report = await evaluateRecallQuestions(databasePath, questions, { temporaryParent: scratchParent });

    expect(report.passed).toBe(true);
    expect(report.metrics.recall).toMatchObject({
      positiveQuestions: 1,
      hitAt1: { hits: 1, total: 1 },
      hitAt5: { hits: 1, total: 1 },
    });
    expect(report.metrics.context).toMatchObject({
      positiveQuestions: 1,
      hitAt1: { hits: 1, total: 1 },
      hitAt5: { hits: 1, total: 1 },
    });
    expect(report.questions[0]).toMatchObject({
      id: "recall-positive",
      confidence: "high",
      confidenceMatchesExpectation: true,
    });
    expect(report.questions[0]?.expectedIdRanks.map((item) => item.id)).toEqual([sessionId, knowledgeId]);
    expect(report.questions[1]?.confidenceMatchesExpectation).toBeNull();
    expect(report.questions[1]?.expectedIdRanks.map((item) => item.id)).toEqual([sessionId, knowledgeId]);
    expect(report.questions[2]).toMatchObject({ confidence: "none", expectedNoHit: true, passed: true });
    expect(report.questions[2]?.returnedHitCount).toBe(0);
    expect(report.questions[3]).toMatchObject({
      confidence: "none",
      expectedNoHit: true,
      returnedHitCount: 0,
      passed: true,
    });
    expect(report.metrics.context.expectedNoHitQuestions).toBe(1);
    expect(report.expectedNoHitWithHighConfidence).toEqual([]);
    expect(report.questions.every((question) => question.responseChars > 0 && question.elapsedMs >= 0)).toBe(true);
    expect(readdirSync(scratchParent)).toEqual([]);

    expect(readDatabaseState(databasePath)).toEqual(beforeState);
    expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    expect(readFileSync(walPath)).toEqual(beforeWal);
  }, 15_000);

  // File-backed snapshot setup can exceed Vitest's default 5 seconds under Windows coverage.
  it("fails a no-hit question when a strong MCP match exists and reports the false positive", async () => {
    const { databasePath, projectRoot, store } = setupFileStore();
    createRecallFixtures(store, projectRoot);
    const questions = parseRecallEvaluationQuestions([
      {
        id: "false-positive",
        mode: "recall",
        query: "aurora moss relay",
        projectRoot,
        expectedNoHit: true,
      },
    ]);

    const report = await evaluateRecallQuestions(databasePath, questions);

    expect(report.passed).toBe(false);
    expect(report.questions[0]).toMatchObject({
      confidence: "high",
      expectedNoHit: true,
      unexpectedHits: true,
      unexpectedHighConfidenceNoHit: true,
      passed: false,
    });
    expect(report.questions[0]?.returnedHitCount).toBeGreaterThan(0);
    expect(report.expectedNoHitWithHighConfidence).toHaveLength(1);
    expect(report.expectedNoHitWithHits).toEqual([
      expect.objectContaining({ id: "false-positive", mode: "recall", returnedHitCount: expect.any(Number) }),
    ]);
  }, 15_000);

  it("does not count a skipped untracked project as an expected no-hit", async () => {
    const { databasePath, temporaryRoot, store } = setupFileStore();
    const untrackedRoot = join(temporaryRoot, "untracked-project");
    mkdirSync(untrackedRoot);
    store.addProject("Untracked fixture", untrackedRoot);
    const questions = parseRecallEvaluationQuestions([
      {
        id: "untracked-scope",
        mode: "recall",
        query: "aurora moss relay",
        projectRoot: untrackedRoot,
        expectedNoHit: true,
      },
    ]);

    const report = await evaluateRecallQuestions(databasePath, questions);

    expect(report.passed).toBe(false);
    expect(report.questions[0]).toMatchObject({ status: "skipped", passed: false, expectedNoHit: true });
    expect(report.metrics.recall).toMatchObject({ expectedNoHitQuestions: 0, skippedQuestions: 1 });
  });

  it("uses a read-only VACUUM INTO fallback without changing the source or omitting WAL records", async () => {
    const { databasePath, projectRoot, store, temporaryRoot } = setupFileStore();
    const { knowledgeId, sessionId } = createRecallFixtures(store, projectRoot);
    const scratchPath = join(temporaryRoot, "fallback-snapshot.sqlite");
    const beforeState = readDatabaseState(databasePath);
    const beforeDatabase = readFileSync(databasePath);
    const walPath = `${databasePath}-wal`;
    const beforeWal = readFileSync(walPath);

    await createReadOnlySnapshot(databasePath, scratchPath, { forceVacuumInto: true });

    expect(readDatabaseState(databasePath)).toEqual(beforeState);
    expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    expect(readFileSync(walPath)).toEqual(beforeWal);
    const snapshotState = readDatabaseState(scratchPath);
    expect(snapshotState.sessions).toContainEqual(expect.objectContaining({ id: sessionId }));
    expect(snapshotState.knowledge).toContainEqual(expect.objectContaining({ id: knowledgeId }));
    expect(snapshotState.searchDirty).toEqual(beforeState.searchDirty);
    if (process.platform !== "win32") expect(statSync(scratchPath).mode & 0o077).toBe(0);
  }, 15_000);

  it("rejects invalid dates, context date filters, duplicate ids, and oversized question sets", () => {
    expect(() =>
      parseRecallEvaluationQuestions([
        { mode: "recall", query: "test", from: "2026-02-30", expectedIds: ["session-1"] },
      ]),
    ).toThrow();
    expect(() =>
      parseRecallEvaluationQuestions([
        { mode: "context", query: "test", from: "2026-02-28", expectedIds: ["session-1"] },
      ]),
    ).toThrow();
    expect(() =>
      parseRecallEvaluationQuestions([
        { id: "same", mode: "recall", query: "test", expectedIds: ["session-1"] },
        { id: "same", mode: "recall", query: "test", expectedIds: ["session-2"] },
      ]),
    ).toThrow("Duplicate question id");
    expect(() =>
      parseRecallEvaluationQuestions(
        Array.from({ length: 201 }, () => ({
          mode: "recall",
          query: "test",
          expectedIds: ["session-1"],
        })),
      ),
    ).toThrow();
  });
});
