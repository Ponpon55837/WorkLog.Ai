// Synthetic recall ranking under growing distractor data (knowledge-quality roadmap Phase 0, step 3).
//
// Usage:
//   pnpm build
//   node --experimental-sqlite packages/storage/bench/recall-scale.bench.mjs [scales] [--json <new file>]
//
// scales is a comma-separated list of Session counts (default 1000,5000,10000). One database grows through each
// scale, so every stage keeps the earlier distractors. The fictional targets are seeded first with the oldest
// dates; distractors are newer, reuse the target query words, and include near misses, outstanding items,
// Knowledge, and Evidence. Recall and context ranks come from the same evaluator as `pnpm eval:recall`, so the
// numbers compare with the private real-data baseline. Only synthetic data is written, inside an OS temp folder.
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../dist/index.js";
import { evaluateRecallQuestions, parseRecallEvaluationQuestions } from "../../../apps/mcp/dist/recall-evaluation.js";

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
if (jsonIndex >= 0 && !jsonPath) throw new Error("--json needs a file path.");
if (jsonPath && existsSync(jsonPath)) throw new Error("--json refuses to overwrite an existing file.");
const scaleArgument = args.find(
  (argument, index) => !argument.startsWith("--") && (jsonIndex < 0 || index !== jsonIndex + 1),
);
const scales = (scaleArgument ?? "1000,5000,10000").split(",").map(Number);
if (scales.some((scale) => !Number.isSafeInteger(scale) || scale < 1)) {
  throw new Error("Scales must be positive safe integers.");
}
for (let index = 1; index < scales.length; index += 1) {
  if (scales[index] <= scales[index - 1]) throw new Error("Scales must increase.");
}

// Fictional targets. Categories follow the roadmap E1 question types that synthetic data can express:
// K Knowledge, S structured Session fields, R raw handoff only, N natural-language question, P path, O outstanding
// item (context only), X no answer (every query word exists somewhere in the distractors).
const cases = [
  {
    key: "k-kiln-glaze",
    terms: ["kiln", "glaze", "crawling"],
    category: "K",
    query: "kiln glaze crawling",
    knowledge: {
      kind: "gotcha",
      title: "Gotcha: kiln glaze crawling",
      body: "Glaze crawls in the kiln when bisque dust is not wiped off before dipping.",
      tags: ["kiln", "glaze"],
    },
  },
  {
    key: "k-ferry-manifest",
    terms: ["ferry", "manifest", "checksum"],
    category: "K",
    query: "ferry manifest checksum",
    knowledge: {
      kind: "pattern",
      title: "Pattern: ferry manifest checksum",
      body: "Recompute the ferry manifest checksum after every cargo line edit, not only at departure.",
      tags: ["ferry", "manifest"],
    },
  },
  {
    key: "k-tea-humidity",
    terms: ["茶葉", "倉庫", "濕度"],
    category: "K",
    query: "茶葉倉庫濕度",
    knowledge: {
      kind: "gotcha",
      title: "Gotcha：茶葉倉庫濕度",
      body: "茶葉倉庫濕度超過六成時，先開除濕機再搬動木箱，避免受潮結塊。",
      tags: ["茶葉", "倉庫"],
    },
  },
  {
    key: "s-observatory-dome",
    terms: ["observatory", "dome", "rotation", "stall"],
    category: "S",
    query: "observatory dome rotation stall",
    session: {
      title: "Fix observatory dome rotation stall",
      summary: "The observatory dome rotation no longer stalls after the encoder reset was moved before homing.",
    },
  },
  {
    key: "s-bakery-proofing",
    terms: ["bakery", "proofing", "timer", "drift"],
    category: "S",
    query: "bakery proofing timer drift",
    session: {
      title: "Bakery proofing timer drift corrected",
      summary: "The bakery proofing timer drift came from a sleep timer that skipped suspended minutes.",
    },
  },
  {
    key: "s-library-barcode",
    terms: ["圖書館", "條碼", "重複", "借閱"],
    category: "S",
    query: "圖書館條碼重複借閱",
    session: {
      title: "修正圖書館條碼重複借閱",
      summary: "圖書館條碼掃描在網路重試時重複借閱，改為以借閱單號去重後解決。",
    },
  },
  {
    key: "r-harbor-crane",
    terms: ["harbor", "crane", "brake", "fade"],
    category: "R",
    query: "harbor crane brake fade",
    session: {
      title: "Imported handoff H1",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Harbor crane recovery\nThe harbor crane brake fade appeared after long lowering runs heated the pads.",
    },
  },
  {
    key: "r-vineyard-sensor",
    terms: ["vineyard", "sensor", "battery", "sag"],
    category: "R",
    query: "vineyard sensor battery sag",
    session: {
      title: "Imported handoff H2",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Vineyard telemetry\nThe vineyard sensor battery sag only showed on cold nights below four degrees.",
    },
  },
  {
    key: "n-tram-schedule",
    terms: ["tram", "schedule", "ghost", "departure", "timetable"],
    category: "N",
    query: "Why did the tram schedule show a ghost departure after the timetable import?",
    session: {
      title: "Tram schedule ghost departure",
      summary: "A timetable import kept a cancelled trip, so the tram schedule showed a ghost departure.",
    },
  },
  {
    key: "n-clinic-queue",
    terms: ["診所", "叫號", "換日", "跳號"],
    category: "N",
    query: "為什麼診所叫號系統在換日後會跳號？",
    session: {
      title: "診所叫號換日跳號",
      summary: "診所叫號系統換日時沒有重設序號快取，導致第一位病人被跳號。",
    },
  },
  {
    key: "p-ledger-rounding",
    terms: ["ledger", "rounding"],
    category: "P",
    query: "ledger rounding",
    paths: ["src/ledger/rounding-policy.ts"],
    session: {
      title: "Adjust rounding policy",
      summary: "Banker's rounding now applies to every currency in the settlement export.",
      changedFiles: ["src/ledger/rounding-policy.ts", "tests/ledger/rounding-policy.test.ts"],
    },
  },
  {
    key: "p-orbit-planner",
    terms: ["orbit", "planner"],
    category: "P",
    query: "orbit planner",
    paths: ["src/orbit/window-planner.ts"],
    session: {
      title: "Planner window clamp",
      summary: "Launch windows are clamped to the visible pass before they are offered.",
      changedFiles: ["src/orbit/window-planner.ts"],
    },
  },
  {
    key: "o-lighthouse-lens",
    terms: ["lighthouse", "lens", "rotation", "motor"],
    category: "O",
    query: "lighthouse lens rotation motor replacement",
    outstanding: "Lighthouse lens rotation motor replacement still needs a night test on the real tower.",
    session: {
      title: "Lighthouse beacon maintenance",
      summary: "Cleaned the beacon housing and logged the current lamp hours.",
    },
  },
  {
    key: "o-greenhouse-vent",
    terms: ["溫室", "天窗", "馬達", "校正"],
    category: "O",
    query: "溫室天窗馬達校正",
    outstanding: "溫室天窗馬達校正尚未在強風下驗證。",
    session: {
      title: "溫室環境巡檢",
      summary: "更新溫室溫度紀錄並清理排水孔。",
    },
  },
  { key: "x-kiln-ferry", category: "X", query: "kiln ferry checksum drift during departure" },
  { key: "x-tram-harbor", category: "X", query: "harbor tram crane timetable sensor" },
  { key: "x-bakery-observatory", category: "X", query: "bakery observatory barcode rotation" },
  { key: "x-tea-clinic", category: "X", query: "茶葉診所條碼濕度跳號" },
];

const fillerWords = [
  "audit",
  "batch",
  "cache",
  "dashboard",
  "export",
  "filter",
  "gateway",
  "handler",
  "index",
  "journal",
  "layout",
  "metric",
  "notice",
  "offline",
  "parser",
  "queue",
  "render",
  "schema",
  "sync",
  "token",
  "upload",
  "viewer",
  "worker",
  "archive",
  "billing",
  "cursor",
  "digest",
  "fallback",
  "locale",
  "preview",
  "報表",
  "匯出",
  "權限",
  "通知",
  "排程",
  "索引",
  "快取",
  "設定",
  "版面",
  "紀錄",
  "同步",
  "上傳",
  "預覽",
  "篩選",
  "帳單",
  "語系",
  "封存",
  "佇列",
  "驗證",
  "介面",
];
const pathDirectories = ["src/ledger", "src/orbit", "src/report", "src/sync", "tests/ledger", "src/ui"];
const pathNames = ["rounding", "policy", "window", "planner", "export", "index", "helpers", "settlement"];

// Content words of each answerable target; distractors reuse them so every query term has many competitors.
const caseWords = cases.filter((entry) => entry.terms).map((entry) => ({ key: entry.key, words: entry.terms }));

// Deterministic PRNG (mulberry32) so every run seeds the same data.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const random = createRandom(20261022);
const pick = (list) => list[Math.floor(random() * list.length)];
const join2 = (words) => (words.some((word) => /[一-鿿]/.test(word)) ? words.join("") : words.join(" "));

function emptyWorkSummary(nextSteps = []) {
  return { outcomes: [], scope: [], decisions: [], verification: [], nextSteps };
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "wi-recall-scale-"));
const projectRoot = join(temporaryRoot, "fictional-project");
mkdirSync(projectRoot);
const databasePath = join(temporaryRoot, "scale.sqlite");
const store = new WorkIntelligenceStore(databasePath);
const project = store.addProject("Fictional scale", projectRoot);
store.updateProject(project.id, { status: "tracked" });

const targetStart = Date.parse("2025-01-01T03:00:00.000Z");
const distractorStart = Date.parse("2025-03-01T00:00:00.000Z");
const distractorSpan = 540 * 24 * 3600 * 1000;
const expectedIds = new Map();
const outstandingTargets = new Map();

function finalize(key, fields, completedAt) {
  const result = store.finalizeSession({
    projectRoot,
    idempotencyKey: key,
    title: fields.title,
    summary: fields.summary,
    workSummary: emptyWorkSummary(fields.nextSteps ?? []),
    changedFiles: fields.changedFiles ?? [],
    ...(fields.handoffContent ? { handoffContent: fields.handoffContent } : {}),
    verification: { status: "passed" },
    completedAt,
  });
  if (result.outcome !== "finalized") throw new Error(`Could not seed ${key}: ${result.outcome}`);
  return result.session.id;
}

// Knowledge has no caller-supplied date, so move it to the same timeline as the Sessions before the search index
// reads it; otherwise every Knowledge record would get the full recency bonus that old target Sessions lack.
const dating = new DatabaseSync(databasePath);
const setKnowledgeDate = dating.prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?");
function recordKnowledge(key, fields, date) {
  const result = store.recordKnowledge({ projectRoot, idempotencyKey: key, ...fields });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Could not seed ${key}: ${result.outcome}`);
  setKnowledgeDate.run(date, date, result.knowledge.id);
  return result.knowledge.id;
}

function seedTargets() {
  for (const [index, entry] of cases.entries()) {
    if (entry.category === "X") continue;
    const completedAt = new Date(targetStart + index * 24 * 3600 * 1000).toISOString();
    if (entry.knowledge) {
      expectedIds.set(entry.key, recordKnowledge(entry.key, entry.knowledge, completedAt));
      continue;
    }
    const nextSteps = entry.outstanding ? [entry.outstanding] : [];
    const sessionId = finalize(entry.key, { ...entry.session, nextSteps }, completedAt);
    if (entry.outstanding) {
      const day = completedAt.slice(0, 10);
      const listed = store.listOutstandingItems({ projectRoot, from: day, to: day, pageSize: 50 });
      const item = listed.items?.find((candidate) => candidate.sourceSessionId === sessionId);
      if (!item) throw new Error(`Could not find the outstanding item for ${entry.key}.`);
      outstandingTargets.set(entry.key, item.id);
    } else {
      expectedIds.set(entry.key, sessionId);
    }
  }
}

// One distractor Session. Each distractor leaves out one content word of the target it imitates in every field,
// so no distractor answers that query. Every tenth one is a hard near miss: its title carries all the remaining
// words, which is the closest a non-answer gets to a structured match.
const HARD_NEAR_MISS_EVERY = 10;
const hardNearMisses = new Map();
function seedDistractor(index, total) {
  const completedAt = new Date(distractorStart + Math.floor((distractorSpan * index) / total)).toISOString();
  const target = pick(caseWords);
  const others = caseWords.filter((entry) => entry !== target);
  // One fixed word from another target, so the extra words never add up to a second answer.
  const otherWord = pick(pick(others).words);
  const dropped = Math.floor(random() * target.words.length);
  const words = target.words.filter((_, position) => position !== dropped);
  const hard = index % HARD_NEAR_MISS_EVERY === 0;
  if (hard) hardNearMisses.set(target.key, (hardNearMisses.get(target.key) ?? 0) + 1);
  const titleWords = hard ? words : [pick(words), pick(fillerWords), pick(fillerWords)];
  const nextSteps = random() < 0.3 ? [`${join2([otherWord, pick(fillerWords), pick(words)])} pending check`] : [];
  const changedFiles =
    random() < 0.5
      ? [`${pick(pathDirectories)}/${pick(pathNames)}-${pick(pathNames)}.ts`, `src/module-${index % 60}.ts`]
      : [`src/module-${index % 60}.ts`];
  const handoffContent =
    random() < 0.2
      ? `# Synthetic notes ${index}\n## ${pick(fillerWords)} follow-up\n${join2([
          pick(words),
          pick(words),
          pick(fillerWords),
          otherWord,
        ])} was discussed but not changed.`
      : undefined;
  const sessionId = finalize(
    `distractor-${index}`,
    {
      title: `${join2(titleWords)} ${pick(fillerWords)} ${index}`,
      summary: `Updated ${join2([pick(fillerWords), otherWord, pick(fillerWords)])} for task ${index}.`,
      nextSteps,
      changedFiles,
      handoffContent,
    },
    completedAt,
  );
  if (random() < 0.2) {
    const evidence = store.attachEvidence({
      sessionId,
      kind: pick(["test", "log", "screenshot"]),
      reference: `synthetic://evidence/${index}`,
      summary: `${pick(fillerWords)} ${pick(words)} result`,
    });
    if (evidence.outcome !== "evidence_attached") throw new Error(`Could not attach evidence ${index}.`);
  }
  if (index % 20 === 0 || index % 20 === 7) {
    recordKnowledge(
      `distractor-knowledge-${index}`,
      {
        kind: pick(["gotcha", "pattern", "decision"]),
        title: `${hard ? "Gotcha" : "Note"}: ${join2(titleWords)} ${pick(fillerWords)}`,
        body: `${join2([pick(words), pick(fillerWords), otherWord])} should be reviewed with the ${pick(fillerWords)} owner.`,
        tags: [pick(words), pick(fillerWords)],
        appliesTo: changedFiles.slice(0, 1),
      },
      completedAt,
    );
  }
}

const buildQuestions = () =>
  parseRecallEvaluationQuestions(
    cases.flatMap((entry) => {
      if (entry.category === "O") return [];
      const base = {
        query: entry.query,
        projectRoot,
        ...(entry.paths ? { paths: entry.paths.map((path) => join(projectRoot, path)) } : {}),
      };
      if (entry.category === "X") {
        return ["recall", "context"].map((mode) => ({
          ...base,
          id: `${entry.key}-${mode}`,
          mode,
          expectedNoHit: true,
        }));
      }
      return ["recall", "context"].map((mode) => ({
        ...base,
        id: `${entry.key}-${mode}`,
        mode,
        expectedIds: [expectedIds.get(entry.key)],
      }));
    }),
  );

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function outstandingRanks() {
  return cases
    .filter((entry) => entry.category === "O")
    .map((entry) => {
      const result = store.getContext(projectRoot, { task: entry.query });
      const items = result.relevant?.outstandingItems?.items ?? [];
      const rank = items.findIndex((item) => item.id === outstandingTargets.get(entry.key)) + 1;
      return {
        key: entry.key,
        rank: rank || null,
        shown: items.length,
        total: result.relevant?.outstandingItems?.total,
      };
    });
}

// For each recall question whose target is not first, the record that took first place, so a failure can be
// classified as candidate recall (target missing) or ranking (target present but outranked).
function recallLosses(report) {
  return report.questions
    .filter(
      (question) => question.mode === "recall" && !question.expectedNoHit && question.expectedIdRanks[0]?.rank !== 1,
    )
    .map((question) => {
      const entry = cases.find((candidate) => question.id === `${candidate.key}-recall`);
      const result = store.recall({
        q: entry.query,
        projectRoot,
        ...(entry.paths ? { paths: entry.paths.map((path) => join(projectRoot, path)) } : {}),
        limit: 1,
      });
      const top = result.hits?.[0];
      return {
        key: entry.key,
        rank: question.expectedIdRanks[0]?.rank ?? null,
        hardNearMisses: hardNearMisses.get(entry.key) ?? 0,
        topTitle: top?.title,
        topMatchedIn: top?.matchedIn,
      };
    });
}

function summarizeStage(report) {
  const byCategory = {};
  for (const question of report.questions) {
    const key = cases.find((entry) => question.id.startsWith(`${entry.key}-`)).category;
    const bucket = (byCategory[`${question.mode}:${key}`] ??= { ranks: [], confidences: {} });
    bucket.confidences[question.confidence] = (bucket.confidences[question.confidence] ?? 0) + 1;
    if (!question.expectedNoHit) bucket.ranks.push(question.expectedIdRanks[0]?.rank ?? null);
  }
  return Object.fromEntries(
    Object.entries(byCategory).map(([key, bucket]) => {
      const ranks = bucket.ranks;
      return [
        key,
        {
          ranks,
          hitAt1: ranks.length ? ranks.filter((rank) => rank === 1).length / ranks.length : null,
          hitAt5: ranks.length ? ranks.filter((rank) => rank !== null && rank <= 5).length / ranks.length : null,
          mrr: ranks.length ? ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length : null,
          confidences: bucket.confidences,
        },
      ];
    }),
  );
}

const stages = [];
try {
  seedTargets();
  const questions = buildQuestions();
  let seeded = 0;
  const finalScale = scales.at(-1);
  for (const scale of scales) {
    const started = performance.now();
    for (; seeded < scale; seeded += 1) seedDistractor(seeded, finalScale);
    const seedMs = performance.now() - started;
    const report = await evaluateRecallQuestions(databasePath, questions);
    const recallTimes = report.questions.filter((question) => question.mode === "recall").map((q) => q.elapsedMs);
    const contextTimes = report.questions.filter((question) => question.mode === "context").map((q) => q.elapsedMs);
    const contextChars = report.questions.filter((question) => question.mode === "context").map((q) => q.responseChars);
    const stage = {
      sessions: scale,
      seedMs: Math.round(seedMs),
      metrics: report.metrics,
      categories: summarizeStage(report),
      noHitWithHighConfidence: report.expectedNoHitWithHighConfidence.map((entry) => entry.id),
      outstanding: outstandingRanks(),
      recallLosses: recallLosses(report),
      latencyMs: {
        recallP50: percentile(recallTimes, 0.5),
        recallP95: percentile(recallTimes, 0.95),
        contextP50: percentile(contextTimes, 0.5),
        contextP95: percentile(contextTimes, 0.95),
      },
      contextCharsMax: Math.max(...contextChars),
    };
    stages.push(stage);
    const format = (value) => (value === null ? "—" : value.toFixed(2));
    console.log(`\n== ${scale} distractor Sessions (seeded in ${stage.seedMs} ms) ==`);
    for (const mode of ["recall", "context"]) {
      const metrics = report.metrics[mode];
      console.log(
        `${mode}: hit@1 ${format(metrics.hitAt1.rate)} hit@5 ${format(metrics.hitAt5.rate)} MRR ${format(metrics.mrr)}` +
          ` | no-answer questions at high: ${metrics.unexpectedHighConfidenceNoHit}/${metrics.expectedNoHitQuestions}`,
      );
    }
    for (const [key, bucket] of Object.entries(stage.categories)) {
      const confidences = Object.entries(bucket.confidences)
        .map(([name, count]) => `${name}=${count}`)
        .join(" ");
      console.log(
        `  ${key.padEnd(10)} ranks [${bucket.ranks.map((rank) => rank ?? "miss").join(", ")}] ${confidences}`,
      );
    }
    for (const entry of stage.outstanding) {
      console.log(`  context:O  ${entry.key} rank ${entry.rank ?? "miss"} (shown ${entry.shown} of ${entry.total})`);
    }
    for (const loss of stage.recallLosses) {
      console.log(
        `  recall loss ${loss.key}: rank ${loss.rank ?? "miss"}, ${loss.hardNearMisses} hard near misses,` +
          ` first "${loss.topTitle}" via ${loss.topMatchedIn}`,
      );
    }
    if (stage.noHitWithHighConfidence.length) {
      console.log(`  no-answer at high: ${stage.noHitWithHighConfidence.join(", ")}`);
    }
    console.log(
      `  latency ms: recall p50 ${stage.latencyMs.recallP50} p95 ${stage.latencyMs.recallP95};` +
        ` context p50 ${stage.latencyMs.contextP50} p95 ${stage.latencyMs.contextP95}; context max chars ${stage.contextCharsMax}`,
    );
  }
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), stages }, null, 2)}\n`,
      {
        flag: "wx",
      },
    );
  }
} finally {
  dating.close();
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
