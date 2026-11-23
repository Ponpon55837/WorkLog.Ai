// Retrieval baseline runner.
//
// Usage:
//   pnpm build
//   node docs/experiments/retrieval-baseline/runner.mjs [--json <new file>] [--repeat 5]
//   node docs/experiments/retrieval-baseline/runner.mjs --prepare <K1..K5|BASE> --db <new path>
//
// It seeds the fictional fixture into a database inside an OS temp folder (never data/ or a real database), calls
// the store read functions that back the MCP tools directly, and measures local elapsed time, response size and
// whether the gold records were returned. Gold lives in questions.mjs and is never derived from these results.
//
// Response size = JSON.stringify(output).length, the number the MCP layer counts (apps/mcp/src/result.ts). The
// read tools work_recall, work_search, work_search_knowledge and work_get_context have no `present` step, but their
// `run` handlers reshape the store result; the same reshaping is mirrored in shape*() below. work_search's excerpt
// compaction is approximated by a 110-character cut, and work_get_context's added `server` key by a fixed object.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import console from "node:console";
import process from "node:process";
import { WorkIntelligenceStore } from "../../../packages/storage/dist/index.js";
import { clock, PAGE_SLUGS, seedFixture } from "./fixture.mjs";
import { CATEGORIES, KEY_KIND, policyCases, QUESTIONS, TOOL_RETURNS } from "./questions.mjs";

const TOP_N = 5;
const SERVER_KEY_APPROX = { restartRequired: false, updateAvailable: false, monitoringAvailable: true };

// ---------------------------------------------------------------------------------------------------------------
// MCP response shaping (mirrors apps/mcp/src/server.ts run handlers for the read tools)
// ---------------------------------------------------------------------------------------------------------------
const truncateText = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const withoutProjectFields = (record) => {
  const rest = { ...record };
  delete rest.projectId;
  delete rest.projectName;
  return rest;
};

function shapeRecall(store, root, args) {
  const result = store.recall({ ...args, projectRoot: root });
  if (result.outcome !== "recall") return result;
  const hits = result.hits.map((hit) => ({
    ...hit,
    matchedIn: hit.matchedIn.slice(0, 4),
    ...(hit.section ? { section: truncateText(hit.section, 24) } : {}),
    ...(hit.related ? { related: hit.related.map(({ id, relation }) => ({ id, relation })) } : {}),
  }));
  if (!result.project) return { ...result, hits };
  return {
    outcome: result.outcome,
    project: { id: result.project.id, name: result.project.name },
    confidence: result.confidence,
    knowledgeConfidence: result.knowledgeConfidence,
    hits: hits.map(withoutProjectFields),
    ...(result.termHits ? { termHits: result.termHits } : {}),
    ...(result.termHitsTruncated ? { termHitsTruncated: result.termHitsTruncated } : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

function shapeSearch(store, root, args) {
  const result = store.searchForAgent(args.q, root, { from: args.from, to: args.to });
  if (result.outcome !== "search") return result;
  const hits = result.hits.map(({ session, matchedIn, matchedVia, section, excerpt }) => ({
    id: session.id,
    title: session.title,
    date: session.completedAt,
    ...(matchedIn ? { matchedIn } : {}),
    ...(matchedVia ? { matchedVia } : {}),
    ...(section ? { section: truncateText(section, 80) } : {}),
    excerpt: truncateText(excerpt, 110),
    ...(excerpt.length > 110 ? { truncated: true } : {}),
    verificationStatus: session.verificationStatus,
  }));
  return {
    outcome: result.outcome,
    confidence: result.confidence,
    hits,
    ...(result.termHits ? { termHits: result.termHits } : {}),
    ...(result.termHitsTruncated ? { termHitsTruncated: result.termHitsTruncated } : {}),
  };
}

function shapeSearchKnowledge(store, root, args) {
  const result = store.searchKnowledgeForAgent({ ...args, projectRoot: root });
  if (result.outcome !== "knowledge" || !result.project) return result;
  return {
    outcome: result.outcome,
    project: { id: result.project.id, name: result.project.name, rootPath: result.project.rootPath },
    ...(result.match ? { match: result.match } : {}),
    items: result.items.map(withoutProjectFields),
    pageInfo: result.pageInfo,
    ...(result.relaxedMatches ? { relaxedMatches: result.relaxedMatches.map(withoutProjectFields) } : {}),
    ...(result.otherStatusMatches ? { otherStatusMatches: result.otherStatusMatches } : {}),
    ...(result.otherStatusFullMatches ? { otherStatusFullMatches: result.otherStatusFullMatches } : {}),
    ...(result.effectiveQuery ? { effectiveQuery: result.effectiveQuery } : {}),
    ...(result.termHits ? { termHits: result.termHits } : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.hint ? { hint: result.hint } : {}),
  };
}

function shapeContext(store, root, args) {
  const result = store.getContext(root, { task: args.task, paths: args.paths, linkedSessionIds: args.linkedSessionIds });
  return { ...result, server: SERVER_KEY_APPROX };
}

const CALLS = { recall: shapeRecall, search: shapeSearch, searchKnowledge: shapeSearchKnowledge, context: shapeContext };

// ---------------------------------------------------------------------------------------------------------------
// Reading the returned records
// ---------------------------------------------------------------------------------------------------------------
/**
 * Returned records, in the order the Agent sees them. `flags` are trust flags carried by the record; `labeledArchived`
 * is true only when the payload itself says status "archived" (only Knowledge search items carry a status).
 * `partial` marks relaxed Knowledge matches: labeled partial leads, not answers.
 */
function readReturned(tool, output) {
  const entry = (record, extra = {}) => ({
    id: record.id,
    flags: {
      needsReview: record.needsReview === true || Boolean(record.review),
    },
    labeledArchived: record.status === "archived",
    related: (record.related ?? []).map((link) => link.id),
    ...extra,
  });
  if (tool === "recall") {
    return { items: (output.hits ?? []).map((hit) => entry(hit)), confidence: output.confidence ?? "none" };
  }
  if (tool === "search") {
    return { items: (output.hits ?? []).map((hit) => entry(hit)), confidence: output.confidence ?? "none" };
  }
  if (tool === "searchKnowledge") {
    const strict = (output.items ?? []).map((item) => entry(item));
    const relaxed = (output.relaxedMatches ?? []).map((item) => entry(item, { partial: true }));
    return { items: [...strict, ...relaxed], confidence: output.match ?? "none", strictCount: strict.length };
  }
  const relevant = output.relevant;
  const items = [...(relevant?.knowledge ?? []), ...(relevant?.sessions ?? [])].map((record) => entry(record));
  return { items, confidence: relevant?.confidence ?? "none" };
}

function evaluate(question, output) {
  const { tool } = question.query;
  const { gold, category } = question;
  const returned = readReturned(tool, output);
  const ids = returned.items.map((item) => item.id);
  const idOf = (key) => globalIds[key];
  const hitSet = new Set(ids);
  const top = new Set(ids.slice(0, TOP_N));
  const relatedSet = new Set([...ids, ...returned.items.flatMap((item) => item.related)]);
  const fraction = (keys, set) => (keys.length === 0 ? null : keys.filter((key) => set.has(idOf(key))).length / keys.length);
  const citeRecall = fraction(gold.mustCite, hitSet);
  const citeRecallTop5 = fraction(gold.mustCite, top);
  const viaRelated = fraction(gold.mustCite, relatedSet);
  // Rule: a mustNotCite record returned as a result is a forbidden hit, unless its own payload labels it archived.
  const forbidden = gold.mustNotCite.filter((key) =>
    returned.items.some((item) => item.id === idOf(key) && !item.labeledArchived && !item.partial),
  );
  const partialForbidden = gold.mustNotCite.filter((key) =>
    returned.items.some((item) => item.id === idOf(key) && item.partial),
  );
  const flagsOk = Object.entries(gold.mustFlag ?? {}).every(([key, flag]) =>
    returned.items.some((item) => item.id === idOf(key) && item.flags[flag] === true),
  );
  let pass;
  if (category === "E") {
    // Negative: the API must not claim evidence (confidence none/low, or Knowledge match none/relaxed with no strict
    // item) and no look-alike may be returned as a result in the first TOP_N records.
    const weak = tool === "searchKnowledge" ? returned.strictCount === 0 : returned.confidence !== "high";
    // Relaxed Knowledge matches are labeled partial leads (match "relaxed"), so they do not count as a returned result.
    const lookAlike = returned.items.slice(0, TOP_N).some((item) => !item.partial && gold.mustNotCite.some((key) => idOf(key) === item.id));
    pass = weak && !lookAlike;
  } else if (category === "C") {
    pass = citeRecall >= 0.8 && forbidden.length === 0;
  } else if (category === "D") {
    pass = citeRecall === 1 && forbidden.length === 0 && flagsOk;
  } else {
    pass = citeRecall === 1 && forbidden.length === 0;
  }
  return {
    citeRecall,
    citeRecallTop5,
    viaRelated,
    forbiddenHit: forbidden.length > 0,
    forbiddenInPartial: partialForbidden.length > 0,
    flagsOk,
    confidence: returned.confidence,
    hits: ids.length,
    pass,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics and helpers
// ---------------------------------------------------------------------------------------------------------------
const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length ? sum(values) / values.length : 0);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

function measure(run, repeat) {
  run(); // warmup
  const samples = [];
  let output;
  for (let i = 0; i < repeat; i += 1) {
    const start = performance.now();
    output = run();
    samples.push(performance.now() - start);
  }
  return { ms: median(samples), output, chars: JSON.stringify(output).length };
}

function summarize(rows) {
  const ms = rows.map((row) => row.ms);
  const chars = rows.map((row) => row.chars);
  const recalls = rows.map((row) => row.citeRecall).filter((value) => value !== null);
  return {
    n: rows.length,
    passRate: round(rows.filter((row) => row.pass).length / rows.length, 3),
    meanCiteRecall: recalls.length ? round(mean(recalls), 3) : null,
    forbiddenHits: rows.filter((row) => row.forbiddenHit).length,
    ms: { mean: round(mean(ms)), median: round(median(ms)), p95: round(percentile(ms, 95)) },
    chars: { mean: Math.round(mean(chars)), median: Math.round(median(chars)), max: Math.max(...chars) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture databases
// ---------------------------------------------------------------------------------------------------------------
let globalIds = {};

function openFixture(directory, name = "fixture") {
  const root = join(directory, `${name}-project`);
  mkdirSync(root, { recursive: true });
  const store = new WorkIntelligenceStore(join(directory, `${name}.sqlite`));
  const seeded = seedFixture(store, root);
  return { store, root, ...seeded };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario preparation for knowledge-page-e2e.md
// ---------------------------------------------------------------------------------------------------------------
const SCENARIOS = {
  BASE: { page: "(none)", note: "只有 fixture，不做任何前置修改；供 30 題檢索題交給真實 Agent 使用。" },
  K1: { page: "in-progress", note: "頁面剛好是最新；加入 3 個與頁面主題無關的新 Session（CI 設定、README 錯字、lint 版本）。" },
  K2: { page: "architecture", note: "頁面落後約 50 個 Session，review 讀取會被截斷。" },
  K3: { page: "architecture + pitfalls", note: "兩頁落後同一批 Session。" },
  K4: { page: "architecture", note: "已對 architecture 提出更新請求，使用者要求完整改寫（full 模式）。" },
  K5: { page: "pitfalls", note: "pitfalls 引用的 Session「修正航班時間時區顯示錯誤」被作廢。" },
};

function prepareScenario(name, dbPath) {
  if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}; use ${Object.keys(SCENARIOS).join(", ")}`);
  if (existsSync(dbPath)) throw new Error(`${dbPath} already exists; --prepare needs a new path.`);
  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true });
  const root = `${dbPath}.project`;
  mkdirSync(root, { recursive: true });
  const store = new WorkIntelligenceStore(dbPath);
  const seeded = seedFixture(store, root);
  const { ids } = seeded;
  const extra = {};
  if (name === "K1") {
    const titles = ["更新 CI 快取設定", "修正 README 錯字", "升級 lint 規則版本"];
    extra.newSessionIds = titles.map((title, index) => {
      clock.advance(26 * 60);
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `k1.new-${index + 1}`,
        title,
        summary: `${title}，與座位、票價、付款與候補的行為無關。`,
        workSummary: { outcomes: [title], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [index === 0 ? ".ci/pipeline.yml" : index === 1 ? "README.md" : "eslint.config.js"],
        verification: { status: "passed" },
      });
      if (result.outcome !== "finalized") throw new Error(`K1 prepare failed: ${result.outcome}`);
      return result.session.id;
    });
  } else if (name === "K4") {
    const result = store.requestKnowledgePageUpdate({ projectRoot: root, slug: "architecture" });
    if (result.outcome !== "knowledge_page_update_requested") throw new Error(`K4 prepare failed: ${result.outcome}`);
  } else if (name === "K5") {
    const result = store.setSessionVoid({ sessionId: ids["s.tz-bug"], voided: true, reason: "時區問題的根因記錄有誤，需重新確認" });
    if (result.outcome === "not_found" || result.outcome === "skipped") throw new Error(`K5 prepare failed: ${result.outcome}`);
    extra.voidedSessionId = ids["s.tz-bug"];
  }
  const pages = store.listKnowledgePages({ projectRoot: root }).items.map((page) => ({
    slug: page.slug,
    version: page.version,
    status: page.status,
    newSessionCount: page.newSessionCount,
    needsReview: page.needsReview === true,
    updateRequested: Boolean(page.updateRequestedAt),
  }));
  store.close();
  clock.restore();
  console.log(
    JSON.stringify(
      { scenario: name, targetPage: SCENARIOS[name].page, note: SCENARIOS[name].note, db: dbPath, projectRoot: root, env: { WORK_INTELLIGENCE_DB: dbPath }, pages, ...extra, ids },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { repeat: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") args.json = argv[++i];
    else if (flag === "--repeat") args.repeat = Number(argv[++i]);
    else if (flag === "--prepare") args.prepare = argv[++i];
    else if (flag === "--db") args.db = argv[++i];
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error("--repeat must be a positive integer");
  if (args.prepare && !args.db) throw new Error("--prepare needs --db <new path>");
  return args;
}

function checkGoldShape() {
  for (const question of QUESTIONS) {
    const returns = TOOL_RETURNS[question.query.tool];
    for (const key of question.gold.mustCite) {
      if (!returns.includes(KEY_KIND(key))) throw new Error(`${question.id}: ${key} cannot be returned by ${question.query.tool}`);
    }
    if (question.category === "E" && question.gold.mustCite.length > 0) throw new Error(`${question.id}: negative questions cite nothing`);
  }
}

function runQuestions(fixture, repeat) {
  const rows = [];
  for (const question of QUESTIONS) {
    const call = CALLS[question.query.tool];
    const measured = measure(() => call(fixture.store, fixture.root, question.query.args), repeat);
    const result = measured.output?.outcome ? evaluate(question, measured.output) : null;
    rows.push({
      id: question.id,
      category: question.category,
      tool: question.query.tool,
      ms: round(measured.ms),
      chars: measured.chars,
      ...(result ?? { citeRecall: null, citeRecallTop5: null, viaRelated: null, forbiddenHit: false, hits: 0, pass: false }),
    });
  }
  return rows;
}

function readPages(fixture, repeat) {
  const read = (label, slug) => {
    const measured = measure(() => fixture.store.getKnowledgePageContext({ projectRoot: fixture.root, slug }), repeat);
    const output = measured.output;
    return {
      page: label,
      mode: output.mode,
      ms: round(measured.ms),
      chars: measured.chars,
      sessions: output.sessions.length,
      truncated: output.truncated,
      newSessionCount: output.page.newSessionCount,
      needsReview: output.page.needsReview === true,
    };
  };
  const rows = PAGE_SLUGS.map((slug) => read(slug, slug));
  // Full-mode read (an explicit update request) of the page, measured last because it changes that page's state.
  fixture.store.requestKnowledgePageUpdate({ projectRoot: fixture.root, slug: "architecture" });
  rows.push(read("architecture (update requested)", "architecture"));
  return rows;
}

function runPolicies(directory) {
  const results = [];
  for (const policy of policyCases) {
    const fixture = openFixture(directory, `policy-${policy.id}`);
    globalIds = fixture.ids;
    try {
      policy.run({ ...fixture, clock });
      results.push({ id: policy.id, pass: true });
    } catch (error) {
      results.push({ id: policy.id, pass: false, error: String(error?.message ?? error).split("\n")[0] });
    } finally {
      fixture.store.close();
    }
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prepare) {
    prepareScenario(args.prepare, args.db);
    return 0;
  }
  if (args.json && existsSync(args.json)) throw new Error(`${args.json} already exists; refusing to overwrite.`);
  checkGoldShape();
  const directory = mkdtempSync(join(tmpdir(), "wi-retrieval-baseline-"));
  try {
    const fixture = openFixture(directory);
    globalIds = fixture.ids;
    const rows = runQuestions(fixture, args.repeat);
    const pages = readPages(fixture, args.repeat);
    fixture.store.close();
    const policy = runPolicies(directory);
    clock.restore();

    const categories = {};
    for (const key of Object.keys(CATEGORIES)) {
      categories[key] = { name: CATEGORIES[key], ...summarize(rows.filter((row) => row.category === key)) };
    }
    const report = {
      meta: { repeat: args.repeat, topN: TOP_N, node: process.version, fixture: fixture.stats, readAt: fixture.readAt },
      overall: summarize(rows),
      categories,
      questions: rows,
      pages,
      policy,
    };
    printSummary(report);
    if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    return policy.every((item) => item.pass) ? 0 : 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function printSummary(report) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const line = (label, summary) =>
    `${label.padEnd(12)} n=${String(summary.n).padStart(2)}  pass ${pct(summary.passRate).padStart(4)}  citeRecall ${String(summary.meanCiteRecall).padEnd(5)}  forbidden ${summary.forbiddenHits}  ms mean/med/p95 ${summary.ms.mean}/${summary.ms.median}/${summary.ms.p95}  chars mean/med/max ${summary.chars.mean}/${summary.chars.median}/${summary.chars.max}`;
  console.log(`Fixture: ${JSON.stringify(report.meta.fixture)}`);
  console.log(`Repeat: ${report.meta.repeat} (median after one warmup)\n`);
  for (const [key, summary] of Object.entries(report.categories)) console.log(line(`${key} ${summary.name}`, summary));
  console.log(line("overall", report.overall));
  console.log("\nQuestions (id tool ms chars citeRecall pass):");
  for (const row of report.questions) {
    console.log(
      `  ${row.id.padEnd(3)} ${row.tool.padEnd(15)} ${String(row.ms).padStart(7)} ms ${String(row.chars).padStart(6)} chars  recall ${String(row.citeRecall).padEnd(5)}  ${row.pass ? "pass" : "FAIL"}${row.forbiddenHit ? "  forbidden-hit" : ""}`,
    );
  }
  console.log("\nKnowledge page context reads:");
  for (const page of report.pages) {
    console.log(
      `  ${page.page.padEnd(32)} ${page.mode.padEnd(6)} ${String(page.ms).padStart(7)} ms ${String(page.chars).padStart(6)} chars  sessions ${page.sessions}  truncated ${page.truncated}  new ${page.newSessionCount}${page.needsReview ? "  needsReview" : ""}`,
    );
  }
  console.log("\nPolicy cases (must all pass):");
  for (const item of report.policy) console.log(`  ${item.id} ${item.pass ? "pass" : `FAIL ${item.error}`}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error?.message ?? error);
  process.exitCode = 1;
}
