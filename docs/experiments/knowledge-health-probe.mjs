// Knowledge Health gap probe (research experiment, read-only against product behavior).
//
// Usage:
//   pnpm build
//   node docs/experiments/knowledge-health-probe.mjs [--sessions 5000] [--instances 50] [--rounds 3] [--benign-touch-rate 0.1] [--json <new file>]
//   node docs/experiments/knowledge-health-probe.mjs --self-check      (small fixture, asserts the expected numbers)
//
// It writes a fictional database inside an OS temp folder, plants labelled problems and look-alike clean records
// (see scenarios below), then runs three things in separate processes: the shipped signals (needsReview,
// possiblyStale, review, archived), the read-only analyzer (knowledge-health-analyzer.mjs), and the evaluator that
// compares both with the planted labels. Only synthetic data is used; nothing touches data/ or a real database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RULES, analyzeKnowledgeHealth } from "./knowledge-health-analyzer.mjs";

const SELF = fileURLToPath(import.meta.url);
const SESSIONS_PER_INSTANCE = 12;

function rngFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ka", "lo", "mi", "ren", "tu", "sha", "vo", "ne", "pri", "dax", "oli", "bru", "fen", "gal", "hyo", "jum"];
function makeVocabulary(random, size) {
  const words = new Set();
  while (words.size < size) {
    const length = 2 + Math.floor(random() * 2);
    words.add(Array.from({ length }, () => SYLLABLES[Math.floor(random() * SYLLABLES.length)]).join(""));
  }
  return [...words];
}

function flagValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 1: seed (child process)
// ---------------------------------------------------------------------------------------------------------------
async function seed(databasePath, truthPath, sessionTotal, instances, benignTouchRate) {
  const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
  const random = rngFrom(20260101);
  const vocabulary = makeVocabulary(random, 900);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const sentence = (count) => Array.from({ length: count }, () => pick(vocabulary)).join(" ");

  const root = join(databasePath, "..", "fictional-project");
  mkdirSync(root, { recursive: true });
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Fictional health", root);
  store.updateProject(project.id, { status: "tracked" });
  const base = Date.parse("2025-01-01T00:00:00.000Z");
  const emptySummary = (nextSteps = []) => ({ outcomes: [], scope: [], decisions: [], verification: [], nextSteps });
  let sessionCounter = 0;
  const makeSession = (files, atOverride) => {
    const index = sessionCounter++;
    const completedAt = atOverride ?? new Date(base + index * 97 * 60 * 1000).toISOString();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `health-session-${index}`,
      title: `Session ${sentence(3)}`,
      summary: sentence(10),
      workSummary: emptySummary(),
      changedFiles: files,
      verification: { status: "passed" },
      completedAt,
    });
    if (result.outcome !== "finalized") throw new Error(`seed session failed: ${result.outcome}`);
    return result.session.id;
  };

  const reservedCount = instances * SESSIONS_PER_INSTANCE;
  if (sessionTotal < reservedCount + 50) throw new Error("Not enough Sessions for the requested instances.");
  const reserved = Array.from({ length: reservedCount }, () => makeSession([`src/reserved/file-${Math.floor(random() * 50)}.ts`]));
  const filler = Array.from({ length: sessionTotal - reservedCount }, () =>
    makeSession([`src/mod-${Math.floor(random() * 60)}/file-${Math.floor(random() * 30)}.ts`]),
  );

  const truth = [];
  const knowledgeOrder = [];
  let keyCounter = 0;
  const record = (fields) => {
    const result = store.recordKnowledge({ projectRoot: root, idempotencyKey: `health-k-${keyCounter++}`, ...fields });
    if (result.outcome !== "knowledge_recorded") throw new Error(`seed knowledge failed: ${result.outcome}`);
    knowledgeOrder.push({ id: result.knowledge.id, sessionId: fields.sessionId });
    return result.knowledge.id;
  };
  const plant = (rule, key, extra = {}) => truth.push({ rule, key, expectAnalyzer: true, ...extra });
  const pair = (left, right) => (left < right ? `${left}|${right}` : `${right}|${left}`);
  const later = [];
  const pageSpecs = [];
  const voidIds = [];
  const modifiedKnowledgeSessions = [];

  for (let i = 0; i < instances; i += 1) {
    const s = reserved.slice(i * SESSIONS_PER_INSTANCE, (i + 1) * SESSIONS_PER_INSTANCE);
    const zone = `zone${i}`;
    const body = () => `${sentence(14)}`;
    const title = (label) => `${label} ${sentence(3)}`;

    record({ kind: "pattern", title: title("Clean sourced"), body: body(), sessionId: s[0], tags: [sentence(1)] });
    // Valid manual Knowledge: no Session, optional free-text reference. Must never be reported as orphaned.
    record({ kind: "decision", title: title("Manual decision"), body: body() });
    record({ kind: "procedure", title: title("Manual procedure"), body: body(), references: [`docs/guide-${i}.md`] });

    const voidedKnowledge = record({ kind: "gotcha", title: title("Voided source"), body: body(), sessionId: s[2] });
    voidIds.push(s[2]);
    plant("source_invalid_cited", voidedKnowledge, { existingExpected: false });

    const modifiedKnowledge = record({ kind: "gotcha", title: title("Modified source"), body: body(), sessionId: s[7] });
    modifiedKnowledgeSessions.push(s[7]);
    plant("source_modified_after_creation", modifiedKnowledge, { existingExpected: false });

    const orphan = record({ kind: "pattern", title: title("Orphan"), body: body(), sessionId: s[8] });
    later.push(() => {
      // Same effect as deleting the Session: knowledge.session_id is ON DELETE SET NULL.
      const db = new DatabaseSync(databasePath);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("DELETE FROM search_dirty"); // synthetic DB: the index is never read, avoids a trigger key clash
      db.prepare("DELETE FROM sessions WHERE id = ?").run(s[8]);
      db.close();
    });
    plant("source_orphaned", orphan, { existingExpected: false });

    // Supersedes chain done correctly (old archived, new active): clean.
    const chainOld = record({ kind: "decision", title: title("Chain ok"), body: body() });
    record({ kind: "decision", title: title("Chain ok"), body: body(), supersedesId: chainOld });

    // Lifecycle contradiction: the archived predecessor is restored while its successor is active.
    const badOld = record({ kind: "decision", title: title("Lifecycle bad"), body: body() });
    const badNew = record({ kind: "decision", title: title("Lifecycle bad"), body: body(), supersedesId: badOld });
    later.push(() => store.updateKnowledge({ projectRoot: root, knowledgeId: badOld, status: "active" }));
    plant("lifecycle_supersede_conflict", badNew, { existingExpected: false });

    if (i % 5 === 0) {
      const dangling = record({ kind: "decision", title: title("Dangling"), body: body() });
      later.push(() => {
        const db = new DatabaseSync(databasePath);
        db.exec("DELETE FROM search_dirty");
        db.prepare("UPDATE knowledge SET supersedes_id = ? WHERE id = ?").run(randomUUID(), dangling);
        db.close();
      });
      plant("lifecycle_supersede_conflict", dangling, { existingExpected: false, apiReachable: false });
    }

    // Same topic, several active versions, no supersedes link. A same-title item of another kind is a look-alike.
    const topicTitle = title("Topic multi");
    const topicA = record({ kind: "pattern", title: topicTitle, body: body() });
    const topicB = record({ kind: "pattern", title: topicTitle, body: body() });
    record({ kind: "gotcha", title: topicTitle, body: body() });
    plant("topic_multiple_active", pair(topicA, topicB), { existingExpected: false });

    // Opposite instructions on the same tag, similar wording.
    const shared = sentence(8);
    const conflictA = record({ kind: "decision", title: title("Conflict a"), body: `always ${shared}`, tags: [zone] });
    const conflictB = record({ kind: "decision", title: title("Conflict b"), body: `never ${shared}`, tags: [zone] });
    plant("possible_conflict_negation", pair(conflictA, conflictB), { existingExpected: false });
    // Look-alikes: both negated with similar text; one negated but unrelated text. Neither is a conflict.
    const same = sentence(8);
    record({ kind: "decision", title: title("Both negative a"), body: `never ${same}`, tags: [zone] });
    record({ kind: "decision", title: title("Both negative b"), body: `do not ${same}`, tags: [zone] });
    record({ kind: "decision", title: title("Negative unrelated"), body: `never ${sentence(8)}`, tags: [zone] });

    // Duplicate with overlapping source and near-identical text; look-alike: same source, different text.
    const dupText = sentence(12);
    const dupA = record({ kind: "pattern", title: title("Dup"), body: dupText, sessionId: s[9] });
    const dupB = record({ kind: "pattern", title: title("Dup"), body: `${dupText} ${pick(vocabulary)}`, sessionId: s[9] });
    plant("duplicate_overlap", pair(dupA, dupB), { existingExpected: false });
    record({ kind: "pattern", title: title("Same source other text"), body: body(), sessionId: s[9] });
    // Text-only duplicate: identical wording, no shared source. The analyzer's source-overlap rule skips it by design.
    const textOnly = sentence(12);
    const textA = record({ kind: "procedure", title: title("Text only a"), body: textOnly });
    const textB = record({ kind: "procedure", title: title("Text only b"), body: textOnly });
    plant("duplicate_text_only", pair(textA, textB), { existingExpected: false, expectAnalyzer: false });

    // Already covered by shipped signals: possiblyStale (appliesTo path touched later) and contradicted review.
    const stale = record({ kind: "pattern", title: title("Stale"), body: body(), sessionId: s[10], appliesTo: [`src/${zone}/**`] });
    later.push(() => makeSession([`src/${zone}/changed.ts`], new Date(base + 400 * 24 * 3600 * 1000 + i * 60000).toISOString()));
    plant("existing_possibly_stale", stale, { existingExpected: true, expectAnalyzer: false });
    const contradicted = record({ kind: "gotcha", title: title("Contradicted"), body: body(), sessionId: s[11] });
    later.push(() => {
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `health-contradict-${i}`,
        title: `Session contradicts ${i}`,
        summary: sentence(8),
        workSummary: emptySummary(),
        changedFiles: [],
        verification: { status: "passed" },
        completedAt: new Date(base + 401 * 24 * 3600 * 1000 + i * 60000).toISOString(),
        contradictedKnowledgeIds: [contradicted],
      });
      if (result.outcome !== "finalized") throw new Error("contradiction session failed");
    });
    plant("existing_contradicted", contradicted, { existingExpected: true, expectAnalyzer: false });

    pageSpecs.push({ i, sessions: s });
  }

  // Filler Knowledge: clean, assorted, sharing tags / reference paths / sources at random.
  const fillerCount = Math.round(sessionTotal * 0.2);
  const tagPool = makeVocabulary(random, 40);
  for (let n = 0; n < fillerCount; n += 1) {
    const hasSource = random() < 0.7;
    record({
      kind: pick(["decision", "pattern", "gotcha", "procedure", "skill"]),
      title: `Filler ${sentence(4)}`,
      body: sentence(14),
      ...(hasSource ? { sessionId: pick(filler) } : {}),
      tags: [pick(tagPool), pick(tagPool)],
      references: random() < 0.3 ? [`docs/shared-${Math.floor(random() * 200)}.md`] : [],
      ...(random() < 0.15 ? { appliesTo: [`src/mod-${Math.floor(random() * 60)}/**`] } : {}),
    });
  }

  for (const run of later) run();

  // Normalize: Sessions look untouched since they were completed, Knowledge was created right after its source.
  const db = new DatabaseSync(databasePath);
  db.exec("UPDATE sessions SET updated_at = completed_at");
  const completedBySession = new Map(db.prepare("SELECT id, completed_at FROM sessions").all().map((row) => [row.id, row.completed_at]));
  const redate = db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?");
  db.exec("BEGIN");
  knowledgeOrder.forEach((item, index) => {
    const origin = item.sessionId && completedBySession.get(item.sessionId) ? Date.parse(completedBySession.get(item.sessionId)) + 60_000 : base;
    const stamp = new Date(origin + index * 1000).toISOString();
    redate.run(stamp, stamp, item.id);
  });
  db.exec("COMMIT");
  // Benign touches: link / evidence / title edits also bump sessions.updated_at (touchSession), so a share of
  // ordinary source Sessions look "modified" after their Knowledge was written. Planted truth never includes them.
  const touch = db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
  for (const sessionId of filler) {
    if (random() < benignTouchRate) touch.run(new Date(Date.parse(completedBySession.get(sessionId)) + 3 * 24 * 3600 * 1000).toISOString(), sessionId);
  }
  // Orphaned Knowledge lost its Session before the redate above could read it; its stamp used `base`. Keep it.
  db.close();

  // Pages are saved last so `sourced_through` is after every normalized Session timestamp.
  const savedPages = [];
  for (const spec of pageSpecs) {
    const { i, sessions: s } = spec;
    const save = (slug, sections) => {
      store.requestKnowledgePageUpdate({ projectRoot: root, slug, title: `Page ${slug}`, question: `What is ${slug}?` });
      const result = store.saveKnowledgePage({ projectRoot: root, slug, idempotencyKey: `health-page-${slug}`, sections });
      if (result.outcome !== "knowledge_page_saved") throw new Error(`page save failed: ${result.outcome}`);
      return result.page.id;
    };
    const section = (heading, ids) => ({ heading, content: sentence(12), sourceSessionIds: ids });
    save(`clean-${i}`, [section("A", [s[0]]), section("B", [s[1]])]);
    const voidedPage = save(`voided-${i}`, [section("A", [s[3]]), section("B", [s[4]])]);
    const modifiedPage = save(`modified-${i}`, [section("A", [s[5]]), section("B", [s[6]])]);
    savedPages.push({ voidedPage, modifiedPage, voidSource: s[3], modifiedSource: s[5] });
  }
  await sleep(20);
  for (const sessionId of voidIds) {
    const result = store.setSessionVoid({ sessionId, voided: true, reason: "synthetic invalid source" });
    if (result.outcome !== "session_void_updated") throw new Error(`void failed: ${result.outcome}`);
  }
  for (const page of savedPages) {
    const result = store.setSessionVoid({ sessionId: page.voidSource, voided: true, reason: "synthetic invalid source" });
    if (result.outcome !== "session_void_updated") throw new Error(`void failed: ${result.outcome}`);
    plant("source_invalid_cited", `${page.voidedPage}:${page.voidSource}`, { existingExpected: true });
    plant("source_modified_after_creation", `${page.modifiedPage}:${page.modifiedSource}`, { existingExpected: true });
  }
  store.close();

  // Source modified after the fact: a later edit to the Session (Knowledge) or after the page save (Page).
  const mutate = new DatabaseSync(databasePath);
  const modifiedAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  for (const page of savedPages) mutate.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(modifiedAt, page.modifiedSource);
  for (const sessionId of modifiedKnowledgeSessions) {
    mutate.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date(Date.parse(completedBySession.get(sessionId)) + 2 * 24 * 3600 * 1000).toISOString(), sessionId);
  }
  mutate.close();

  writeFileSync(truthPath, JSON.stringify({ truth, sessionTotal, instances }));
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2a: shipped signals (child process, runs against a copy because opening a store may write)
// ---------------------------------------------------------------------------------------------------------------
async function existingSignals(databasePath) {
  const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
  const store = new WorkIntelligenceStore(databasePath);
  const started = performance.now();
  const projectId = store.listProjects()[0].id;
  const flagged = { needsReviewPages: [], possiblyStale: [], reviewed: [], archived: [] };
  const pages = store.listKnowledgePages({ projectId });
  for (const page of pages.items) {
    if (page.needsReview) {
      for (const section of page.reviewSections ?? []) {
        for (const source of section.sources) flagged.needsReviewPages.push({ pageId: page.id, sourceId: source.sourceSessionId, reasons: source.reasons });
      }
    }
  }
  const pageSize = 200;
  for (const status of ["active", "archived"]) {
    for (let page = 1; ; page += 1) {
      const result = store.searchKnowledge({ projectId, status, page, pageSize });
      for (const item of result.items) {
        if (item.status === "archived") flagged.archived.push(item.id);
        if (item.possiblyStale) flagged.possiblyStale.push(item.id);
        if (item.review) flagged.reviewed.push(item.id);
      }
      if (page >= result.pageInfo.totalPages) break;
    }
  }
  const elapsedMs = performance.now() - started;
  store.close();
  return { flagged, elapsedMs, rssMb: process.memoryUsage().rss / 1048576 };
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2b: analyzer (child process so RSS is measured without the seed's footprint)
// ---------------------------------------------------------------------------------------------------------------
function runAnalyzer(databasePath) {
  const before = process.memoryUsage();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const result = analyzeKnowledgeHealth(db);
  db.close();
  const after = process.memoryUsage();
  return {
    ...result,
    rssBeforeMb: before.rss / 1048576,
    rssAfterMb: after.rss / 1048576,
    peakRssMb: process.resourceUsage().maxRSS / 1024,
    heapDeltaMb: (after.heapUsed - before.heapUsed) / 1048576,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestrator and evaluation
// ---------------------------------------------------------------------------------------------------------------
function child(mode, args) {
  const result = spawnSync(process.execPath, ["--no-warnings", SELF, `--child-${mode}`, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${mode} child failed: ${result.stderr}`);
  return result.stdout;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function evaluate(truth, analyzed, existing) {
  const pagesFlagged = new Set(existing.flagged.needsReviewPages.map((entry) => `${entry.pageId}:${entry.sourceId}`));
  const pagesAny = new Set(existing.flagged.needsReviewPages.map((entry) => entry.pageId));
  const knowledgeFlagged = new Set([...existing.flagged.possiblyStale, ...existing.flagged.reviewed, ...existing.flagged.archived]);
  const isFlagged = (key) => {
    if (key.includes(":")) return pagesFlagged.has(key);
    return key.split("|").some((id) => knowledgeFlagged.has(id));
  };
  const rows = [];
  for (const rule of [...RULES, "duplicate_text_only", "existing_possibly_stale", "existing_contradicted"]) {
    const planted = truth.filter((item) => item.rule === rule);
    const targeted = planted.filter((item) => item.expectAnalyzer);
    const found = analyzed.findings.filter((entry) => entry.rule === rule);
    const plantedKeys = new Set(targeted.map((item) => item.key));
    const foundKeys = new Set(found.map((entry) => entry.key));
    const truePositives = [...foundKeys].filter((key) => plantedKeys.has(key));
    const falsePositives = [...foundKeys].filter((key) => !plantedKeys.has(key));
    rows.push({
      rule,
      planted: planted.length,
      analyzerTargets: targeted.length,
      findings: foundKeys.size,
      truePositives: truePositives.length,
      falsePositives: falsePositives.length,
      precision: foundKeys.size ? truePositives.length / foundKeys.size : null,
      recall: targeted.length ? truePositives.length / targeted.length : null,
      existingCaught: planted.filter((item) => isFlagged(item.key)).length,
      analyzerFindingsAlsoFlaggedByExisting: [...foundKeys].filter(isFlagged).length,
      newTruePositives: truePositives.filter((key) => !isFlagged(key)).length,
    });
  }
  const totals = rows.reduce(
    (sum, row) => {
      sum.findings += row.findings;
      sum.truePositives += row.truePositives;
      sum.falsePositives += row.falsePositives;
      sum.overlap += row.analyzerFindingsAlsoFlaggedByExisting;
      sum.newTruePositives += row.newTruePositives;
      return sum;
    },
    { findings: 0, truePositives: 0, falsePositives: 0, overlap: 0, newTruePositives: 0 },
  );
  const plantedProblems = truth.filter((item) => item.rule !== "duplicate_text_only");
  const existingRecall = plantedProblems.filter((item) => isFlagged(item.key)).length;
  return { rows, totals, existingRecall: { caught: existingRecall, planted: plantedProblems.length }, pagesAny: pagesAny.size };
}

function table(rows) {
  const header = ["rule", "planted", "findings", "TP", "FP", "precision", "recall", "existing caught", "overlap", "new TP"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  const fmt = (value) => (value === null ? "n/a" : value.toFixed(3));
  for (const row of rows) {
    lines.push(
      `| ${row.rule} | ${row.planted} | ${row.findings} | ${row.truePositives} | ${row.falsePositives} | ${fmt(row.precision)} | ${fmt(row.recall)} | ${row.existingCaught} | ${row.analyzerFindingsAlsoFlaggedByExisting} | ${row.newTruePositives} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child-seed") {
    await seed(args[1], args[2], Number(args[3]), Number(args[4]), Number(args[5]));
    return;
  }
  if (args[0] === "--child-existing") {
    process.stdout.write(JSON.stringify(await existingSignals(args[1])));
    return;
  }
  if (args[0] === "--child-analyze") {
    process.stdout.write(JSON.stringify(runAnalyzer(args[1])));
    return;
  }

  const selfCheck = args.includes("--self-check");
  const sessions = Number(flagValue(args, "--sessions", selfCheck ? 300 : 5000));
  const instances = Number(flagValue(args, "--instances", selfCheck ? 4 : 50));
  const rounds = Number(flagValue(args, "--rounds", selfCheck ? 1 : 3));
  const benignTouchRate = Number(flagValue(args, "--benign-touch-rate", selfCheck ? "0" : "0.1"));
  const jsonPath = flagValue(args, "--json", undefined);
  if (jsonPath && existsSync(jsonPath)) throw new Error("--json refuses to overwrite an existing file.");

  const temp = mkdtempSync(join(tmpdir(), "wi-knowledge-health-"));
  try {
    const databasePath = join(temp, "health.sqlite");
    const truthPath = join(temp, "truth.json");
    const seedStarted = performance.now();
    child("seed", [databasePath, truthPath, String(sessions), String(instances), String(benignTouchRate)]);
    const seedMs = performance.now() - seedStarted;
    const { truth } = JSON.parse(readFileSync(truthPath, "utf8"));

    const copyPath = join(temp, "existing.sqlite");
    copyFileSync(databasePath, copyPath);
    const existing = JSON.parse(child("existing", [copyPath]));

    const runs = [];
    for (let round = 0; round < rounds; round += 1) runs.push(JSON.parse(child("analyze", [databasePath])));
    const analyzed = runs[0];
    for (const run of runs) assert.deepEqual(run.findings, analyzed.findings, "analyzer output must be deterministic");

    const counts = new DatabaseSync(databasePath, { readOnly: true });
    const sizes = {
      sessions: counts.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
      knowledge: counts.prepare("SELECT COUNT(*) AS n FROM knowledge").get().n,
      activeKnowledge: counts.prepare("SELECT COUNT(*) AS n FROM knowledge WHERE status = 'active'").get().n,
      pages: counts.prepare("SELECT COUNT(*) AS n FROM knowledge_pages").get().n,
    };
    counts.close();

    const evaluation = evaluate(truth, analyzed, existing);
    const report = {
      sizes,
      benignTouchRate,
      seedMs: Math.round(seedMs),
      analyzer: {
        medianMs: Number(median(runs.map((run) => run.elapsedMs)).toFixed(1)),
        runsMs: runs.map((run) => Number(run.elapsedMs.toFixed(1))),
        rssBeforeMb: Number(median(runs.map((run) => run.rssBeforeMb)).toFixed(1)),
        rssAfterMb: Number(median(runs.map((run) => run.rssAfterMb)).toFixed(1)),
        peakRssMb: Number(median(runs.map((run) => run.peakRssMb)).toFixed(1)),
        heapDeltaMb: Number(median(runs.map((run) => run.heapDeltaMb)).toFixed(1)),
        skippedBuckets: analyzed.skippedBuckets.length,
      },
      existingSignals: {
        elapsedMs: Number(existing.elapsedMs.toFixed(1)),
        rssMb: Number(existing.rssMb.toFixed(1)),
        needsReviewPages: new Set(existing.flagged.needsReviewPages.map((entry) => entry.pageId)).size,
        needsReviewSources: existing.flagged.needsReviewPages.length,
        possiblyStale: existing.flagged.possiblyStale.length,
        reviewedContradicted: existing.flagged.reviewed.length,
        archived: existing.flagged.archived.length,
      },
      evaluation,
      sampleFindings: Object.fromEntries(RULES.map((rule) => [rule, analyzed.findings.filter((entry) => entry.rule === rule).slice(0, 1)])),
    };
    console.log(JSON.stringify({ sizes: report.sizes, analyzer: report.analyzer, existingSignals: report.existingSignals, totals: evaluation.totals, existingRecall: evaluation.existingRecall }, null, 2));
    console.log(table(evaluation.rows));
    if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

    if (selfCheck) {
      const byRule = new Map(evaluation.rows.map((row) => [row.rule, row]));
      for (const rule of RULES) {
        const row = byRule.get(rule);
        assert.equal(row.recall, 1, `${rule} must find every planted case`);
        assert.equal(row.falsePositives, 0, `${rule} must not flag look-alike clean records`);
      }
      assert.equal(byRule.get("duplicate_overlap").planted, instances);
      assert.equal(byRule.get("duplicate_text_only").findings, 0);
      assert.equal(byRule.get("source_orphaned").existingCaught, 0);
      assert.equal(byRule.get("existing_possibly_stale").existingCaught, instances);
      assert.equal(byRule.get("existing_contradicted").existingCaught, instances);
      console.log("self-check passed");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
