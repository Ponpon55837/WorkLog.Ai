import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

type ExpectedAnswerability = "supported" | "insufficient";
type RecallConfidence = "none" | "low" | "high";

interface AnswerabilityCase {
  name: string;
  query: string;
  expectedAnswerability: ExpectedAnswerability;
  baselineConfidence: RecallConfidence;
  baselineRanks: number[];
  seed: (store: WorkIntelligenceStore, projectRoot: string) => string[];
}

const temporaryDirectories: string[] = [];

function withSyntheticStore(assertion: (store: WorkIntelligenceStore, projectRoot: string) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), "work-intelligence-answerability-"));
  temporaryDirectories.push(projectRoot);
  const store = new WorkIntelligenceStore(":memory:");
  const project = store.addProject("Fictional Observatory", projectRoot);
  store.updateProject(project.id, { status: "tracked" });

  try {
    assertion(store, projectRoot);
  } finally {
    store.close();
  }
}

function createSession(
  store: WorkIntelligenceStore,
  projectRoot: string,
  key: string,
  title: string,
  summary: string,
  completedAt?: string,
): string {
  const result = store.finalizeSession({
    projectRoot,
    idempotencyKey: key,
    title,
    summary,
    ...(completedAt ? { completedAt } : {}),
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") throw new Error(`Expected synthetic Session ${key}; received ${result.outcome}.`);
  return result.session.id;
}

function createArchivedKnowledge(store: WorkIntelligenceStore, projectRoot: string): string {
  const result = store.recordKnowledge({
    projectRoot,
    idempotencyKey: "answerability-archived-knowledge",
    kind: "gotcha",
    title: "Copper queue retry limit",
    body: "The temporary retry limit is five attempts.",
    tags: ["copper", "queue", "retry", "limit"],
  });
  if (result.outcome !== "knowledge_recorded")
    throw new Error(`Expected synthetic Knowledge; received ${result.outcome}.`);

  const archived = store.updateKnowledge({
    projectRoot,
    knowledgeId: result.knowledge.id,
    status: "archived",
  });
  if (archived.outcome !== "knowledge_updated")
    throw new Error(`Expected archived Knowledge; received ${archived.outcome}.`);
  return result.knowledge.id;
}

// Answerability is a human-authored label. These tests lock the current retrieval confidence and candidate ranks;
// they do not score model answers or change retrieval behavior.
const answerabilityCases: AnswerabilityCase[] = [
  {
    name: "high lexical similarity without an answer",
    query: "amber battery temperature shutdown threshold",
    expectedAnswerability: "insufficient",
    baselineConfidence: "high",
    baselineRanks: [1],
    seed: (store, projectRoot) => [
      createSession(
        store,
        projectRoot,
        "answerability-high-overlap-miss",
        "Amber battery temperature shutdown check",
        "The amber battery temperature was checked before scheduled shutdown; no shutdown threshold was recorded.",
      ),
    ],
  },
  {
    name: "partially related evidence without the requested value",
    query: "cedar fan restart delay minutes after overheating",
    expectedAnswerability: "insufficient",
    baselineConfidence: "high",
    baselineRanks: [1],
    seed: (store, projectRoot) => [
      createSession(
        store,
        projectRoot,
        "answerability-partial-restart",
        "Cedar fan restart after overheating",
        "The cedar fan restarted after cooling from an overheating event, but the record does not state the delay in minutes.",
      ),
    ],
  },
  {
    name: "unresolved contradictory evidence",
    query: "violet valve automatically opens after reset",
    expectedAnswerability: "insufficient",
    baselineConfidence: "high",
    baselineRanks: [1, 2],
    seed: (store, projectRoot) => [
      createSession(
        store,
        projectRoot,
        "answerability-conflict-old",
        "Violet valve reset procedure",
        "The violet valve opens automatically after a sensor reset.",
        "2025-02-01T00:00:00.000Z",
      ),
      createSession(
        store,
        projectRoot,
        "answerability-conflict-new",
        "Violet valve reset procedure",
        "The violet valve remains closed after a sensor reset until manual approval.",
        "2026-02-01T00:00:00.000Z",
      ),
    ],
  },
  {
    name: "archived Knowledge is not an active answer",
    query: "copper queue retry limit",
    expectedAnswerability: "insufficient",
    baselineConfidence: "none",
    baselineRanks: [0],
    seed: (store, projectRoot) => [createArchivedKnowledge(store, projectRoot)],
  },
  {
    name: "voided Session is not an active answer",
    query: "marigold export checksum sha256",
    expectedAnswerability: "insufficient",
    baselineConfidence: "none",
    baselineRanks: [0],
    seed: (store, projectRoot) => {
      const sessionId = createSession(
        store,
        projectRoot,
        "answerability-voided-session",
        "Marigold export checksum digest",
        "The marigold export digest uses SHA-256.",
      );
      store.setSessionVoid({ sessionId, voided: true, reason: "Fictional source was voided for this fixture." });
      return [sessionId];
    },
  },
  {
    name: "restored Session supplies the answer again",
    query: "marigold export checksum sha256",
    expectedAnswerability: "supported",
    baselineConfidence: "low",
    baselineRanks: [1],
    seed: (store, projectRoot) => {
      const sessionId = createSession(
        store,
        projectRoot,
        "answerability-restored-session",
        "Marigold export checksum digest",
        "The marigold export digest uses SHA-256.",
      );
      store.setSessionVoid({ sessionId, voided: true, reason: "Fictional source was temporarily voided." });
      store.setSessionVoid({ sessionId, voided: false });
      return [sessionId];
    },
  },
  {
    name: "low lexical similarity still returns a supported answer",
    query: "bracken cadence",
    expectedAnswerability: "supported",
    baselineConfidence: "low",
    baselineRanks: [1],
    seed: (store, projectRoot) => [
      createSession(
        store,
        projectRoot,
        "answerability-low-overlap-hit",
        "Bracken valve timing note",
        "After priming the Bracken valve, wait twelve minutes before opening the outlet.",
      ),
    ],
  },
];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic answerability retrieval baselines", () => {
  it.each(answerabilityCases)(
    "$name (expected $expectedAnswerability; confidence $baselineConfidence; ranks $baselineRanks)",
    ({ query, baselineConfidence, baselineRanks, seed }) => {
      withSyntheticStore((store, projectRoot) => {
        const candidateIds = seed(store, projectRoot);
        const result = store.recall({ q: query, projectRoot, limit: 10 });
        if (result.outcome !== "recall") throw new Error("Expected synthetic recall to complete.");

        const ranks = candidateIds.map((id) => {
          const index = result.hits.findIndex((hit) => hit.id === id);
          return index < 0 ? 0 : index + 1;
        });
        expect(result.confidence).toBe(baselineConfidence);
        expect(ranks).toEqual(baselineRanks);
      });
    },
  );
});
