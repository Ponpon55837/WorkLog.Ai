import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { APP_VERSION } from "@work-intelligence/shared/app-version";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "@work-intelligence/storage";
import { createWorkIntelligenceMcpServer } from "./server.js";

type RecallConfidence = "none" | "low" | "high";

export type RecallEvaluationQuestion = {
  id: string;
  mode: "recall" | "context";
  query: string;
  projectRoot?: string;
  paths?: string[];
  from?: string;
  to?: string;
  expectedIds: string[];
  expectedNoHit: boolean;
  expectedConfidence?: RecallConfidence;
};

type EvalMode = RecallEvaluationQuestion["mode"];
type RankedRecord = { id: string; type: "session" | "knowledge"; rank: number };
type EvaluationStatus = "evaluated" | "skipped";
type MetricRate = { hits: number; total: number; rate: number | null };
type ModeMetrics = {
  positiveQuestions: number;
  hitAt1: MetricRate;
  hitAt5: MetricRate;
  mrr: number | null;
  mrrDefinition: string;
  expectedNoHitQuestions: number;
  unexpectedHighConfidenceNoHit: number;
  skippedQuestions: number;
};
type QuestionResult = {
  id: string;
  mode: EvalMode;
  status: EvaluationStatus;
  outcome: string;
  expectedIds: string[];
  expectedNoHit: boolean;
  expectedConfidence?: RecallConfidence;
  confidence?: RecallConfidence;
  confidenceMatchesExpectation: boolean | null;
  expectedIdRanks: Array<{ id: string; type: RankedRecord["type"] | null; rank: number | null }>;
  hitAt1: boolean | null;
  hitAt5: boolean | null;
  reciprocalRank: number | null;
  returnedHitCount: number;
  unexpectedHits: boolean;
  responseChars: number;
  elapsedMs: number;
  unexpectedHighConfidenceNoHit: boolean;
  passed: boolean;
};
export type RecallEvaluationReport = {
  version: 1;
  generatedAt: string;
  sourceOpenedReadOnly: true;
  questionCount: number;
  passed: boolean;
  metrics: Record<EvalMode, ModeMetrics>;
  questions: QuestionResult[];
  expectedNoHitWithHighConfidence: Array<{ id: string; mode: EvalMode; responseChars: number; elapsedMs: number }>;
  expectedNoHitWithHits: Array<{ id: string; mode: EvalMode; confidence?: RecallConfidence; returnedHitCount: number }>;
};

export type RecallEvaluationOptions = { temporaryParent?: string };
export type RecallEvaluationSnapshotOptions = { forceVacuumInto?: boolean };

const CONFIDENCE_VALUES = ["none", "low", "high"] as const;
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }, "Date must be a real calendar date.");
const questionSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    mode: z.enum(["recall", "context"]),
    query: z.string().trim().min(1).max(500),
    projectRoot: z.string().trim().min(1).max(1_000).optional(),
    paths: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    expectedIds: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    expectedNoHit: z.boolean().default(false),
    expectedConfidence: z.enum(CONFIDENCE_VALUES).optional(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.expectedNoHit && question.expectedIds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedIds"],
        message: "No-hit questions cannot list expectedIds.",
      });
    }
    if (!question.expectedNoHit && question.expectedIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedIds"],
        message: "Positive questions require at least one expected id.",
      });
    }
    if (question.from && question.to && question.to < question.from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "The end date must be on or after the start date.",
      });
    }
    if (question.mode === "context" && (question.from || question.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Context questions do not support date filters; use recall mode.",
      });
    }
  });

const questionFileSchema = z.union([
  z.array(questionSchema).min(1).max(200),
  z.object({ version: z.literal(1), questions: z.array(questionSchema).min(1).max(200) }).strict(),
]);

function parseMcpResult(result: Awaited<ReturnType<Client["callTool"]>>): {
  text: string;
  value: Record<string, unknown>;
} {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: unknown }>) : [];
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
  );
  if (!textBlock) {
    throw new Error("MCP evaluation response did not contain a text payload.");
  }
  if (result.isError) {
    throw new Error(`MCP evaluation request failed: ${textBlock.text}`);
  }
  const value: unknown = JSON.parse(textBlock.text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP evaluation response was not a JSON object.");
  }
  return { text: textBlock.text, value: value as Record<string, unknown> };
}

function confidenceValue(value: unknown): RecallConfidence | undefined {
  return value === "none" || value === "low" || value === "high" ? value : undefined;
}

function rankedRecords(mode: EvalMode, result: Record<string, unknown>): RankedRecord[] {
  if (mode === "recall") {
    const hits = Array.isArray(result.hits) ? result.hits : [];
    return hits.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || (record.type !== "session" && record.type !== "knowledge")) return [];
      return [{ id: record.id, type: record.type, rank: index + 1 }];
    });
  }

  const relevant = result.relevant;
  if (!relevant || typeof relevant !== "object" || Array.isArray(relevant)) return [];
  const context = relevant as Record<string, unknown>;
  const sessionHits = Array.isArray(context.sessions) ? context.sessions : [];
  const knowledgeHits = Array.isArray(context.knowledge) ? context.knowledge : [];
  const sessions = sessionHits.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" ? [{ id: record.id, type: "session" as const, rank: index + 1 }] : [];
  });
  const knowledge = knowledgeHits.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" ? [{ id: record.id, type: "knowledge" as const, rank: index + 1 }] : [];
  });
  return [...sessions, ...knowledge];
}

function rate(hits: number, total: number): MetricRate {
  return { hits, total, rate: total > 0 ? Number((hits / total).toFixed(4)) : null };
}

function summarizeMode(mode: EvalMode, results: QuestionResult[]): ModeMetrics {
  const modeResults = results.filter((result) => result.mode === mode);
  const evaluated = modeResults.filter((result) => result.status === "evaluated");
  const positives = evaluated.filter((result) => !result.expectedNoHit);
  const expectedNoHitQuestions = evaluated.filter((result) => result.expectedNoHit);
  const skippedQuestions = modeResults.filter((result) => result.status === "skipped").length;
  const hitsAt1 = positives.filter((result) => result.hitAt1).length;
  const hitsAt5 = positives.filter((result) => result.hitAt5).length;
  const mrr =
    positives.length > 0
      ? Number(
          (positives.reduce((total, result) => total + (result.reciprocalRank ?? 0), 0) / positives.length).toFixed(4),
        )
      : null;
  const unexpectedHighConfidenceNoHit = expectedNoHitQuestions.filter(
    (result) => result.unexpectedHighConfidenceNoHit,
  ).length;
  return {
    positiveQuestions: positives.length,
    hitAt1: rate(hitsAt1, positives.length),
    hitAt5: rate(hitsAt5, positives.length),
    mrr,
    mrrDefinition:
      mode === "recall"
        ? "MRR@30 over the returned recall order"
        : "Best reciprocal rank within each relevant type list (up to five per type)",
    expectedNoHitQuestions: expectedNoHitQuestions.length,
    unexpectedHighConfidenceNoHit,
    skippedQuestions,
  };
}

function questionArguments(question: RecallEvaluationQuestion): Record<string, unknown> {
  if (question.mode === "recall") {
    return {
      q: question.query,
      ...(question.projectRoot ? { projectRoot: question.projectRoot } : {}),
      ...(question.paths ? { paths: question.paths } : {}),
      ...(question.from ? { from: question.from } : {}),
      ...(question.to ? { to: question.to } : {}),
      limit: 30,
    };
  }
  return {
    task: question.query,
    ...(question.projectRoot ? { projectRoot: question.projectRoot } : {}),
    ...(question.paths ? { paths: question.paths } : {}),
  };
}

function isSkippedOutcome(value: unknown): boolean {
  return value === "skipped";
}

async function evaluateQuestion(client: Client, question: RecallEvaluationQuestion): Promise<QuestionResult> {
  const started = performance.now();
  const response = await client.callTool({
    name: "work_read",
    arguments: {
      operation: question.mode === "recall" ? "work_recall" : "work_get_context",
      arguments: questionArguments(question),
    },
  });
  const elapsedMs = Number((performance.now() - started).toFixed(2));
  const { text, value } = parseMcpResult(response);
  const outcome = typeof value.outcome === "string" ? value.outcome : "unknown";
  const skipped = isSkippedOutcome(value.outcome);
  if (!skipped && value.outcome !== (question.mode === "recall" ? "recall" : "context")) {
    throw new Error(`Question ${question.id} returned an unexpected MCP outcome.`);
  }
  const confidence =
    question.mode === "recall"
      ? confidenceValue(value.confidence)
      : confidenceValue((value.relevant as Record<string, unknown> | undefined)?.confidence);
  if (!skipped && !confidence) {
    throw new Error(`Question ${question.id} did not return a retrieval confidence.`);
  }
  const records = skipped ? [] : rankedRecords(question.mode, value);
  const byId = new Map(records.map((record) => [record.id, record]));
  const expectedIdRanks = question.expectedIds.map((id) => {
    const found = byId.get(id);
    return { id, type: found?.type ?? null, rank: found?.rank ?? null };
  });
  const bestRank = expectedIdRanks.reduce<number | null>((best, item) => {
    if (item.rank === null) return best;
    return best === null ? item.rank : Math.min(best, item.rank);
  }, null);
  const hitAt1 = skipped || question.expectedNoHit ? null : bestRank !== null && bestRank <= 1;
  const hitAt5 = skipped || question.expectedNoHit ? null : bestRank !== null && bestRank <= 5;
  const reciprocalRank =
    skipped || question.expectedNoHit ? null : bestRank === null ? 0 : Number((1 / bestRank).toFixed(4));
  const confidenceMatchesExpectation = question.expectedConfidence ? confidence === question.expectedConfidence : null;
  const unexpectedHighConfidenceNoHit = question.expectedNoHit && confidence === "high";
  const passed =
    !skipped &&
    (question.expectedNoHit ? !unexpectedHighConfidenceNoHit : bestRank !== null) &&
    confidenceMatchesExpectation !== false;
  return {
    id: question.id,
    mode: question.mode,
    status: skipped ? "skipped" : "evaluated",
    outcome,
    expectedIds: question.expectedIds,
    expectedNoHit: question.expectedNoHit,
    ...(question.expectedConfidence ? { expectedConfidence: question.expectedConfidence } : {}),
    ...(confidence ? { confidence } : {}),
    confidenceMatchesExpectation,
    expectedIdRanks,
    hitAt1,
    hitAt5,
    reciprocalRank,
    returnedHitCount: records.length,
    unexpectedHits: question.expectedNoHit && records.length > 0,
    responseChars: text.length,
    elapsedMs,
    unexpectedHighConfidenceNoHit,
    passed,
  };
}

function supportsReadOnlySqlite(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

function assertReadOnlySqliteSupport(): void {
  if (!supportsReadOnlySqlite()) {
    throw new Error("pnpm eval:recall requires Node.js 22.5 or later for SQLite read-only connections.");
  }
}

export async function createReadOnlySnapshot(
  sourcePath: string,
  snapshotPath: string,
  options: RecallEvaluationSnapshotOptions = {},
): Promise<void> {
  assertReadOnlySqliteSupport();
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON;");
    const sqlite = await import("node:sqlite");
    if (!options.forceVacuumInto && typeof sqlite.backup === "function") {
      await sqlite.backup(source, snapshotPath);
    } else {
      // Node 22.5–22.15 lack node:sqlite backup(); VACUUM INTO still writes only the scratch target.
      source.exec("PRAGMA query_only = OFF;");
      source.prepare("VACUUM INTO ?").run(snapshotPath);
      source.exec("PRAGMA query_only = ON;");
    }
    chmodSync(snapshotPath, 0o600);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const integrity = snapshot.prepare("PRAGMA quick_check;").get() as { quick_check?: string } | undefined;
      if (integrity?.quick_check !== "ok") throw new Error("SQLite evaluation snapshot failed quick_check.");
    } finally {
      snapshot.close();
    }
  } finally {
    source.close();
  }
}

export function parseRecallEvaluationQuestions(input: unknown): RecallEvaluationQuestion[] {
  const parsed = questionFileSchema.parse(input);
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  const seenIds = new Set<string>();
  return questions.map((question, index) => {
    const id = question.id ?? `question-${String(index + 1).padStart(2, "0")}`;
    if (seenIds.has(id)) throw new Error(`Duplicate question id: ${id}`);
    seenIds.add(id);
    if (new Set(question.expectedIds).size !== question.expectedIds.length) {
      throw new Error(`Question ${id} has duplicate expected ids.`);
    }
    return { ...question, id };
  });
}

export async function evaluateRecallQuestions(
  sourceDatabasePath: string,
  questions: RecallEvaluationQuestion[],
  options: RecallEvaluationOptions = {},
): Promise<RecallEvaluationReport> {
  assertReadOnlySqliteSupport();
  const temporaryRoot = mkdtempSync(join(options.temporaryParent ?? tmpdir(), "wi-recall-eval-"));
  const snapshotPath = join(temporaryRoot, "evaluation.sqlite");
  let store: WorkIntelligenceStore | undefined;
  let server: ReturnType<typeof createWorkIntelligenceMcpServer> | undefined;
  let client: Client | undefined;
  try {
    await createReadOnlySnapshot(sourceDatabasePath, snapshotPath);
    store = new WorkIntelligenceStore(snapshotPath, { backup: { directory: join(temporaryRoot, "backups") } });
    server = createWorkIntelligenceMcpServer(store, APP_VERSION, LATEST_SCHEMA_VERSION);
    client = new Client({ name: "work-intelligence-recall-evaluator", version: APP_VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const results: QuestionResult[] = [];
    for (const question of questions) {
      results.push(await evaluateQuestion(client, question));
    }
    const unexpectedHighConfidenceNoHit = results
      .filter((result) => result.unexpectedHighConfidenceNoHit)
      .map(({ id, mode, responseChars, elapsedMs }) => ({ id, mode, responseChars, elapsedMs }));
    const expectedNoHitWithHits = results
      .filter((result) => result.unexpectedHits)
      .map(({ id, mode, confidence, returnedHitCount }) => ({ id, mode, confidence, returnedHitCount }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      sourceOpenedReadOnly: true,
      questionCount: questions.length,
      passed: results.every((result) => result.passed),
      metrics: {
        recall: summarizeMode("recall", results),
        context: summarizeMode("context", results),
      },
      questions: results,
      expectedNoHitWithHighConfidence: unexpectedHighConfidenceNoHit,
      expectedNoHitWithHits,
    };
  } finally {
    try {
      if (client) await client.close().catch(() => undefined);
      if (server) await server.close().catch(() => undefined);
    } finally {
      try {
        store?.close();
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}
