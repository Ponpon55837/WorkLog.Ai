// Knowledge reuse attribution experiment (read-only replay; research tool, not a product feature).
//
// Question: when a Session could have reused a Knowledge item (same project, the Knowledge existed and was active,
// its appliesTo covers a file the Session changed) but did not report it as applied, was the Knowledge ever offered
// to that Session by the product, and if not, why not?
//
// Usage:
//   pnpm build
//   node docs/experiments/knowledge-reuse-attribution.mjs --db <path to a database> [--limit 500] [--json <new file>]
//   node docs/experiments/knowledge-reuse-attribution.mjs --self-check     (also the default without --db)
//
// Definitions
//   Opportunity = (Session S, Knowledge K): same tracked project; S not voided; K.created_at < S.started_at (falls back
//   to completed_at); K was active at S's time (active now, or archived/restored per knowledge_audit: an archive after
//   S still counts, an unexplained archived row is `excluded_not_active`); K.appliesTo covers at least one changed file
//   of S (the product's appliesToStrength > 0); and S is not K's own source Session.
//   Reported = knowledge_feedback(K, S, 'applied'); `contradicted` is counted separately.
//
// Replay: for each Session with at least one opportunity, getContext() runs for {task}, {paths} and {task, paths}
// (task = Session title, paths = first 20 changed files) and every K is classified full / pointer_only / absent.
// For K absent from the combined variant, work_recall(limit 30) tells why: budget_trimmed (K is among the first five
// Knowledge hits yet missing), ranked_behind (K is beyond the fifth), or no_match (K not recalled; applies_to_only when
// no changed file appears in K.references).
//
// Safety: the source database is opened read-only and snapshotted with VACUUM INTO a temp folder; the store runs on
// the copy only (it may migrate it) and the folder is removed afterwards. Output is aggregate counts only, never ids,
// titles, paths, project names or record text.
//
// Known biases (also printed): the replay uses the CURRENT database, so later Sessions and Knowledge compete in the
// ranking and recency differs from the real moment; S itself is in the index and can be recalled, and supplements
// sourced from S's own applied Knowledge are not counted as "offered" (they are counted as selfSupplementLeak).
import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
const { appliesToStrength, compileAppliesToEntry } = await import("../../packages/storage/dist/applies-to-match.js");
const { normalizePath } = await import("../../packages/storage/dist/search-text.js");

const REPLAY_PATH_LIMIT = 20;
const RELEVANT_LIMIT = 5;
const CLASSES = ["full", "pointer_only", "absent"];
const VARIANTS = ["task", "paths", "both"];
const NOTES = [
  "Replay uses the current database state: Sessions and Knowledge created after S compete in ranking and recency.",
  "S itself is indexed and can be recalled; supplements sourced from S's own applied Knowledge are not counted as offered (selfSupplementLeak).",
  "Context and recall also match Knowledge appliesTo against queried paths (here the first 20 changed files), so no_match/applies_to_only now means the matching file lies beyond those paths or the match budget ran out. Older builds did not match appliesTo there.",
];

function flagValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function cell() {
  return { pairs: 0, reported: 0, unreported: 0, contradicted: 0 };
}

function bump(target, opportunity) {
  target.pairs += 1;
  if (opportunity.reported) target.reported += 1;
  else target.unreported += 1;
  if (opportunity.contradicted) target.contradicted += 1;
}

function parseList(text) {
  try {
    const value = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function timeOf(...values) {
  for (const value of values) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(time)) return time;
  }
  return Number.NaN;
}

function pathMatchesReference(path, reference) {
  return path === reference || path.endsWith(`/${reference}`) || reference.endsWith(`/${path}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Context classification
// ---------------------------------------------------------------------------------------------------------------
function findRecords(node, knowledgeId, channel, found) {
  if (Array.isArray(node)) {
    for (const item of node) findRecords(item, knowledgeId, channel, found);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.id === knowledgeId && (node.title !== undefined || node.excerpt !== undefined)) {
    found.push({ channel, record: node });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "omitted") continue;
    findRecords(value, knowledgeId, channel ? `${channel}.${key}` : key, found);
  }
}

function classifyContext(context, knowledgeId, sessionId) {
  if (context.outcome !== "context") return { cls: "absent", via: "error" };
  const found = [];
  findRecords(context, knowledgeId, "", found);
  let leak = false;
  const vias = [];
  for (const { channel, record } of found) {
    if (channel === "relevant.supplements") {
      if (record.includedBecause?.sourceSessionId === sessionId) {
        leak = true;
        continue;
      }
      vias.push("supplement");
    } else if (channel === "relevant.knowledge") vias.push("relevant");
    else if (channel === "recentKnowledge") vias.push("recent");
    else vias.push("other");
  }
  if (vias.length > 0) {
    const via = vias.includes("relevant") ? "relevant" : vias.includes("recent") ? "recent_only" : "supplement_only";
    return { cls: "full", via, leak };
  }
  const pointer = (context.omitted ?? []).some(
    (omission) =>
      (omission.ids ?? []).includes(knowledgeId) || (omission.entries ?? []).some((entry) => entry.id === knowledgeId),
  );
  return { cls: pointer ? "pointer_only" : "absent", leak };
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------
function snapshot(sourcePath, copyPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

function loadRows(db) {
  const projects = db.prepare("SELECT id, name, root_path FROM projects WHERE status = 'tracked'").all();
  const sessions = db
    .prepare(
      `SELECT id, project_id, title, started_at, completed_at, changed_files_json
       FROM sessions WHERE voided_at IS NULL ORDER BY id`,
    )
    .all();
  const knowledge = db
    .prepare(
      `SELECT id, project_id, session_id, status, created_at, references_json, applies_to_json
       FROM knowledge ORDER BY created_at, id`,
    )
    .all();
  const audit = db
    .prepare(
      `SELECT knowledge_id, action, occurred_at FROM knowledge_audit
       WHERE action IN ('archived', 'restored') ORDER BY occurred_at, rowid`,
    )
    .all();
  const feedback = db
    .prepare("SELECT knowledge_id, session_id, kind FROM knowledge_feedback WHERE session_id IS NOT NULL")
    .all();
  return { projects, sessions, knowledge, audit, feedback };
}

/** Inactive intervals per Knowledge from its archive/restore audit; an archived row without audit is `unknown`. */
function inactiveIntervals(knowledge, audit) {
  const byKnowledge = new Map();
  for (const row of audit) {
    const list = byKnowledge.get(row.knowledge_id) ?? [];
    list.push(row);
    byKnowledge.set(row.knowledge_id, list);
  }
  const result = new Map();
  for (const item of knowledge) {
    const intervals = [];
    let open;
    for (const row of byKnowledge.get(item.id) ?? []) {
      const time = Date.parse(row.occurred_at);
      if (row.action === "archived" && open === undefined) open = time;
      else if (row.action === "restored" && open !== undefined) {
        intervals.push([open, time]);
        open = undefined;
      }
    }
    if (open !== undefined) intervals.push([open, Number.POSITIVE_INFINITY]);
    result.set(item.id, { intervals, unknown: item.status === "archived" && intervals.length === 0 });
  }
  return result;
}

function compileKnowledge(item, project) {
  const contexts = [{ name: project.name, rootPath: project.root_path }];
  const matchers = [];
  for (const raw of parseList(item.applies_to_json)) {
    const pattern = normalizePath(raw, contexts);
    if (!pattern) continue;
    const compiled = compileAppliesToEntry(pattern);
    if (compiled.never) continue;
    matchers.push(compiled.glob ? (path) => compiled.matches(path) : (path) => appliesToStrength(pattern, path) > 0);
  }
  return matchers;
}

function buildOpportunities(rows, totals) {
  const { projects, sessions, knowledge, audit, feedback } = rows;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const inactive = inactiveIntervals(knowledge, audit);
  const keyOf = (row) => `${row.knowledge_id}|${row.session_id}`;
  const applied = new Set(feedback.filter((row) => row.kind === "applied").map(keyOf));
  const contradicted = new Set(feedback.filter((row) => row.kind === "contradicted").map(keyOf));

  // Each Knowledge's appliesTo is compiled once; only Knowledge with a usable appliesTo can form an opportunity.
  const candidatesByProject = new Map();
  for (const item of knowledge) {
    const project = projectById.get(item.project_id);
    if (!project) continue;
    const matchers = compileKnowledge(item, project);
    if (matchers.length === 0) continue;
    const list = candidatesByProject.get(item.project_id) ?? [];
    list.push({ item, createdAt: Date.parse(item.created_at), matchers, references: parseList(item.references_json) });
    candidatesByProject.set(item.project_id, list);
  }

  const opportunities = [];
  for (const session of sessions) {
    const project = projectById.get(session.project_id);
    if (!project) continue;
    totals.sessions += 1;
    const candidates = candidatesByProject.get(session.project_id);
    if (!candidates) continue;
    const contexts = [{ name: project.name, rootPath: project.root_path }];
    const normalized = parseList(session.changed_files_json)
      .map((file) => normalizePath(file, contexts))
      .filter(Boolean);
    const time = timeOf(session.started_at, session.completed_at);
    if (normalized.length === 0 || Number.isNaN(time)) continue;
    for (const entry of candidates) {
      if (!(entry.createdAt < time)) continue;
      const matchedFiles = normalized.filter((path) => entry.matchers.some((matches) => matches(path)));
      if (matchedFiles.length === 0) continue;
      if (entry.item.session_id === session.id) {
        totals.excluded_source_session += 1;
        continue;
      }
      const state = inactive.get(entry.item.id);
      if (state.unknown || state.intervals.some(([from, to]) => time >= from && time < to)) {
        totals.excluded_not_active += 1;
        continue;
      }
      const key = `${entry.item.id}|${session.id}`;
      const references = entry.references.map((reference) => normalizePath(reference, contexts));
      opportunities.push({
        knowledgeId: entry.item.id,
        sessionId: session.id,
        matchedFiles,
        inReferences: normalized.some((path) => references.some((reference) => pathMatchesReference(path, reference))),
        reported: applied.has(key),
        contradicted: contradicted.has(key),
      });
    }
  }
  const inOpportunities = opportunities.filter((opportunity) => opportunity.reported).length;
  totals.applied_rows_total = applied.size;
  totals.applied_rows_outside_opportunities = applied.size - inOpportunities;
  return { opportunities, projectById, sessionById: new Map(sessions.map((session) => [session.id, session])) };
}

function sample(opportunities, limit) {
  if (!limit || opportunities.length <= limit) return opportunities;
  const step = Math.ceil(opportunities.length / limit);
  return opportunities.filter((_, index) => index % step === 0);
}

export async function analyzeDatabase(sourcePath, { limit } = {}) {
  const started = performance.now();
  const temp = mkdtempSync(join(tmpdir(), "wi-reuse-attribution-"));
  try {
    const copyPath = join(temp, "copy.sqlite");
    snapshot(sourcePath, copyPath);
    // The store may migrate the copy; the source was only ever opened read-only.
    const store = new WorkIntelligenceStore(copyPath);
    try {
      const reader = new DatabaseSync(copyPath, { readOnly: true });
      let rows;
      try {
        rows = loadRows(reader);
      } finally {
        reader.close();
      }
      return replay(store, rows, limit, started);
    } finally {
      store.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Sum, mean and percentiles of a list of lengths, for comparing the size of context responses between builds. */
function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    sum,
    mean: sorted.length === 0 ? 0 : Math.round(sum / sorted.length),
    p50: at(0.5),
    p90: at(0.9),
  };
}

function replay(store, rows, limit, started) {
  const totals = {
    projectsTracked: rows.projects.length,
    sessions: 0,
    knowledge: rows.knowledge.length,
    excluded_source_session: 0,
    excluded_not_active: 0,
  };
  const { opportunities: all, projectById, sessionById } = buildOpportunities(rows, totals);
  const chosen = sample(all, limit);
  const bySession = new Map();
  for (const opportunity of chosen) {
    const list = bySession.get(opportunity.sessionId) ?? [];
    list.push(opportunity);
    bySession.set(opportunity.sessionId, list);
  }

  const variants = Object.fromEntries(
    VARIANTS.map((name) => [name, Object.fromEntries(CLASSES.map((cls) => [cls, cell()]))]),
  );
  const fullVia = { relevant: 0, recent_only: 0, supplement_only: 0 };
  const causes = {
    budget_trimmed: cell(),
    ranked_behind: cell(),
    no_match: { applies_to_only: cell(), other: cell() },
  };
  const checks = {
    total: cell(),
    in_recall: cell(),
    not_in_recall: cell(),
    in_file_history: cell(),
    not_in_file_history: cell(),
  };
  let selfSupplementLeak = 0;
  let contextErrors = 0;
  const contextChars = [];

  for (const [sessionId, list] of bySession) {
    const session = sessionById.get(sessionId);
    const root = projectById.get(session.project_id).root_path;
    const task = session.title;
    const paths = parseList(session.changed_files_json).slice(0, REPLAY_PATH_LIMIT);
    // One call per Session and variant, however many Knowledge items it has opportunities for.
    const contexts = {
      task: store.getContext(root, { task }),
      paths: store.getContext(root, { paths }),
      both: store.getContext(root, { task, paths }),
    };
    contextChars.push(JSON.stringify(contexts.both).length);
    const hitsOf = (result) => (result.outcome === "recall" ? result.hits : []);
    const cache = { history: new Map() };
    const recall30 = () => (cache.recall30 ??= hitsOf(store.recall({ q: task, paths, projectRoot: root, limit: 30 })));
    const recallDefault = () => (cache.recallDefault ??= hitsOf(store.recall({ q: task, paths, projectRoot: root })));
    const fileHistory = (files) => {
      const key = files.join("\u0000");
      if (!cache.history.has(key)) {
        const result = store.getFileHistory({ projectRoot: root, paths: files });
        cache.history.set(
          key,
          result.outcome === "file_history" ? new Set(result.knowledge.map((item) => item.id)) : new Set(),
        );
      }
      return cache.history.get(key);
    };

    for (const opportunity of list) {
      const classes = {};
      for (const variant of VARIANTS) {
        const result = classifyContext(contexts[variant], opportunity.knowledgeId, sessionId);
        if (result.via === "error") contextErrors += 1;
        classes[variant] = result;
        bump(variants[variant][result.cls], opportunity);
        if (result.leak) selfSupplementLeak += 1;
        if (variant === "both" && result.cls === "full") fullVia[result.via] += 1;
      }
      if (classes.both.cls !== "absent") continue;
      bump(checks.total, opportunity);
      const knowledgeHits = recall30().filter((hit) => hit.type === "knowledge");
      const rank = knowledgeHits.findIndex((hit) => hit.id === opportunity.knowledgeId);
      if (rank >= 0 && rank < RELEVANT_LIMIT) bump(causes.budget_trimmed, opportunity);
      else if (rank >= RELEVANT_LIMIT) bump(causes.ranked_behind, opportunity);
      else bump(causes.no_match[opportunity.inReferences ? "other" : "applies_to_only"], opportunity);
      const inRecall = recallDefault().some((hit) => hit.type === "knowledge" && hit.id === opportunity.knowledgeId);
      bump(inRecall ? checks.in_recall : checks.not_in_recall, opportunity);
      const inHistory = fileHistory(opportunity.matchedFiles.slice(0, 3)).has(opportunity.knowledgeId);
      bump(inHistory ? checks.in_file_history : checks.not_in_file_history, opportunity);
    }
  }

  const reportState = cell();
  for (const opportunity of chosen) bump(reportState, opportunity);
  return {
    totals: {
      ...totals,
      opportunities: all.length,
      opportunitiesReplayed: chosen.length,
      sessionsWithOpportunity: new Set(all.map((item) => item.sessionId)).size,
      sessionsReplayed: bySession.size,
      distinctKnowledgeInOpportunities: new Set(all.map((item) => item.knowledgeId)).size,
    },
    reportState,
    variants,
    combined: { fullVia, absentCauses: causes, absentChecks: checks },
    selfSupplementLeak,
    contextErrors,
    contextResponseChars: summarize(contextChars),
    elapsedMs: Math.round(performance.now() - started),
    notes: NOTES,
  };
}

function printReport(report) {
  const line = (label, value) => `${label.padEnd(36)} ${value}`;
  const fmt = (item) =>
    `${item.pairs} (reported ${item.reported}, unreported ${item.unreported}, contradicted ${item.contradicted})`;
  const out = ["Totals"];
  for (const [key, value] of Object.entries(report.totals)) out.push(`  ${line(key, value)}`);
  out.push(`  ${line("report state of replayed", fmt(report.reportState))}`);
  for (const variant of VARIANTS) {
    out.push(`Variant ${variant}`);
    for (const cls of CLASSES) out.push(`  ${line(cls, fmt(report.variants[variant][cls]))}`);
  }
  out.push("Combined variant");
  for (const [key, value] of Object.entries(report.combined.fullVia)) out.push(`  ${line(`full via ${key}`, value)}`);
  const { absentCauses, absentChecks } = report.combined;
  out.push(`  ${line("absent: budget_trimmed", fmt(absentCauses.budget_trimmed))}`);
  out.push(`  ${line("absent: ranked_behind", fmt(absentCauses.ranked_behind))}`);
  out.push(`  ${line("absent: no_match/applies_to_only", fmt(absentCauses.no_match.applies_to_only))}`);
  out.push(`  ${line("absent: no_match/other", fmt(absentCauses.no_match.other))}`);
  for (const [key, value] of Object.entries(absentChecks)) out.push(`  ${line(`absent, ${key}`, fmt(value))}`);
  out.push(line("selfSupplementLeak", report.selfSupplementLeak));
  out.push(line("contextErrors", report.contextErrors));
  const size = report.contextResponseChars;
  out.push(
    line(
      "context response characters",
      `n ${size.count}, sum ${size.sum}, mean ${size.mean}, p50 ${size.p50}, p90 ${size.p90} (both variant)`,
    ),
  );
  out.push(line("elapsedMs", report.elapsedMs));
  out.push("Notes");
  for (const note of report.notes) out.push(`  - ${note}`);
  console.log(out.join("\n"));
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic database (self-check). Fictional names only.
// ---------------------------------------------------------------------------------------------------------------
// Waits until the wall clock reads a later millisecond, so every record gets a strictly newer timestamp than the one
// before even on machines with a coarse clock (a fixed 4 ms sleep left equal timestamps and a different replay).
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const tick = () => {
  const start = Date.now();
  do Atomics.wait(sleepCell, 0, 0, 2);
  while (Date.now() <= start);
};
const longText = (word) => Array.from({ length: 40 }, (_, index) => `${word}${index % 7}`).join(" ");

function seedSyntheticDatabase(databasePath, root) {
  mkdirSync(root, { recursive: true });
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Fictional reuse", root);
  store.updateProject(project.id, { status: "tracked" });
  let counter = 0;
  const session = (title, files, extra = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `reuse-session-${counter++}`,
      title,
      summary: `${title}. ${longText("tidewrack")}`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: files,
      verification: { status: "passed" },
      ...extra,
    });
    if (result.outcome !== "finalized") throw new Error(`session failed: ${result.outcome}`);
    return result.session.id;
  };
  const knowledge = (title, body, extra = {}) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `reuse-knowledge-${counter++}`,
      kind: "pattern",
      title,
      body,
      ...extra,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error(`knowledge failed: ${result.outcome}`);
    return result.knowledge.id;
  };
  const ids = {};

  // Heavy history for the Zephyrmoss task: long decisions and next steps of the best-ranked Sessions fill the relevant
  // part of the context so that the budget has to drop ranked Knowledge.
  for (let index = 0; index < 6; index += 1) {
    const heavy = (label) => `Zephyrmoss ledger reconcile batch ${label} ${index}: ${longText("zephyrmoss")}`;
    session(`Reconcile zephyrmoss ledger batch history ${index}`, [`src/zhistory/part-${index}.ts`], {
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [heavy("decision a"), heavy("decision b"), heavy("decision c")],
        verification: [],
        nextSteps: [heavy("step a"), heavy("step b"), heavy("step c")],
      },
    });
  }

  // K created after S: not an opportunity for the only Session that touched its files.
  session("Early lateonly tidy", ["src/lateonly/a.ts"]);
  knowledge("Lateonly rule", "A rule written after the only Session that touched lateonly.", {
    appliesTo: ["src/lateonly/**"],
  });

  // Archived after S_before (still an opportunity) and before S_after (excluded_not_active).
  ids.arch = knowledge("Archzone legacy note", "Archzone legacy handling note.", { appliesTo: ["src/archzone/**"] });
  session("Archzone before change", ["src/archzone/a.ts"]);
  tick();
  const archived = store.updateKnowledge({ projectRoot: root, knowledgeId: ids.arch, status: "archived" });
  if (archived.outcome !== "knowledge_updated") throw new Error(`archive failed: ${archived.outcome}`);
  session("Archzone after change", ["src/archzone/b.ts"]);

  // K whose own source Session is the only one touching its files (retimed below to predate that Session).
  ids.sourceSession = session("Srczone origin work", ["src/srczone/a.ts"]);
  ids.src = knowledge("Srczone origin rule", "Srczone origin rule text.", {
    sessionId: ids.sourceSession,
    appliesTo: ["src/srczone/**"],
  });

  ids.quill = knowledge(
    "Quillfox cache invalidation pitfall",
    "Quillfox cache invalidation must clear the shard map before the warm pass.",
    { appliesTo: ["src/quillfox/**"] },
  );
  ids.zephyr = [];
  for (let index = 0; index < 5; index += 1) {
    ids.zephyr.push(knowledge(
      `Zephyrmoss ledger reconcile batch rule ${index}`,
      "Zephyrmoss ledger reconcile batch ordering. Zephyrmoss ledger reconcile batch retries need idempotent keys.",
      { appliesTo: ["src/zephyrmoss/**"] },
    ));
  }
  knowledge("Bookkeeping aside", "One ledger remark.", { appliesTo: ["src/zephyrmoss/**"] });
  knowledge("Obsidian harbor lantern", "Obsidian harbor lantern wiring note.", { appliesTo: ["src/harbor/**"] });
  knowledge("Cobalt dock mooring", "Cobalt dock mooring wiring note.", {
    appliesTo: ["src/dockyard/**"],
    references: ["src/dockyard/dock.ts"],
  });
  // Linked to files only through appliesTo, and the later Session's files are all within the replayed paths.
  knowledge("Fernbrook gasket rule", "Fernbrook gasket torque rule text.", { appliesTo: ["src/fernbrook/**"] });
  // The twelfth newest Knowledge at replay time: the tail of recentKnowledge, covered only for a file beyond the
  // 20 replayed paths.
  knowledge("Ambergris pier rule", "Ambergris pier rule text.", { appliesTo: ["src/pier/**"] });
  for (let index = 0; index < 11; index += 1) {
    knowledge(`Tidewrack filler ${index}`, longText(`tidewrack${index}`).repeat(3));
  }

  const miscFiles = Array.from({ length: 20 }, (_, index) => `src/misc/file-${String(index).padStart(2, "0")}.ts`);
  session("Tune quillfox cache invalidation", ["src/quillfox/cache.ts"], { appliedKnowledgeIds: [ids.quill] });
  session("Adjust quillfox cache eviction order", ["src/quillfox/evict.ts"]);
  session("Revisit quillfox cache invalidation", ["src/quillfox/warm.ts"], { contradictedKnowledgeIds: [ids.quill] });
  // Applying the five strong rules confirms them, so they are not possiblyStale when the budget drops them (a stale
  // item keeps its id in the omission pointer; a plain one keeps at most three ids).
  session("Reconcile zephyrmoss ledger batch again", ["src/zephyrmoss/retry.ts"]);
  session("Reconcile zephyrmoss ledger batch", ["src/zephyrmoss/ledger.ts"], { appliedKnowledgeIds: ids.zephyr });
  session("Rewire unrelated gadget cabling", [...miscFiles, "src/harbor/dock.ts"]);
  session("Rewire unrelated gizmo cabling", [...miscFiles, "src/dockyard/dock.ts"]);
  session("Replace unrelated sprocket lining", ["src/fernbrook/a.ts"]);
  session("Rewire unrelated widget cabling", [...miscFiles, "src/pier/end.ts"]);
  store.close();

  const db = new DatabaseSync(databasePath);
  try {
    const source = db.prepare("SELECT completed_at FROM sessions WHERE id = ?").get(ids.sourceSession);
    const earlier = new Date(Date.parse(source.completed_at) - 3_600_000).toISOString();
    db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?").run(earlier, earlier, ids.src);
  } finally {
    db.close();
  }
  return ids;
}

function assertSelfCheck(report) {
  const dump = JSON.stringify(report, null, 2);
  const expect = (actual, expected, label) => assert.deepEqual(actual, expected, `${label}\n${dump}`);
  const counts = (item) => [item.pairs, item.reported, item.unreported, item.contradicted];
  const { totals, variants, combined } = report;
  expect(report.contextErrors, 0, "context errors");
  expect(report.selfSupplementLeak, 0, "self supplement leak");
  // Not opportunities: K after S (lateonly), K archived before S, K's own source Session.
  expect(totals.excluded_source_session, 1, "source Session exclusion");
  expect(totals.excluded_not_active, 1, "archived-before-Session exclusion");
  expect(totals.opportunities, 20, "opportunities");
  expect(totals.opportunitiesReplayed, 20, "replayed opportunities");
  expect(totals.sessionsWithOpportunity, 10, "Sessions with an opportunity");
  expect(totals.distinctKnowledgeInOpportunities, 12, "distinct Knowledge");
  expect(totals.applied_rows_total, 6, "applied rows");
  expect(totals.applied_rows_outside_opportunities, 0, "applied rows outside opportunities");
  expect(counts(report.reportState), [20, 6, 14, 1], "report state");
  // Combined variant: [pairs, reported, unreported, contradicted].
  expect(counts(variants.both.full), [7, 2, 5, 1], "full: reported, unreported and contradicted");
  expect(counts(variants.both.pointer_only), [7, 3, 4, 0], "pointer_only");
  expect(counts(variants.both.absent), [6, 1, 5, 0], "absent");
  // Paths alone now reach Knowledge through appliesTo: appliesTo-only opportunities within the replayed paths are full
  // relevant records, not only a budget pointer.
  expect(variants.paths.full.pairs, 14, "paths-only variant offers appliesTo-matched records");
  const { absentCauses, absentChecks } = combined;
  expect(counts(absentCauses.budget_trimmed), [1, 1, 0, 0], "budget_trimmed");
  expect(counts(absentCauses.ranked_behind), [2, 0, 2, 0], "ranked_behind");
  expect(counts(absentCauses.no_match.applies_to_only), [2, 0, 2, 0], "no_match / applies_to_only");
  expect(counts(absentCauses.no_match.other), [1, 0, 1, 0], "no_match / other");
  expect(counts(absentChecks.in_recall), [1, 1, 0, 0], "absent but in default recall");
  expect([absentChecks.in_file_history.pairs, absentChecks.not_in_file_history.pairs], [5, 1], "file history");
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dbPath = flagValue(args, "--db", undefined);
  const selfCheck = args.includes("--self-check") || !dbPath;
  const jsonPath = flagValue(args, "--json", undefined);
  const limit = flagValue(args, "--limit", undefined);
  if (jsonPath && existsSync(jsonPath)) throw new Error("--json refuses to overwrite an existing file.");
  if (limit !== undefined && !(Number(limit) > 0)) throw new Error("--limit must be a positive number.");
  if (dbPath && !selfCheck && !existsSync(dbPath)) throw new Error("--db file not found.");

  const temp = mkdtempSync(join(tmpdir(), "wi-reuse-selfcheck-"));
  try {
    let target = dbPath;
    if (selfCheck) {
      target = join(temp, "synthetic.sqlite");
      seedSyntheticDatabase(target, join(temp, "fictional-root"));
    }
    const report = await analyzeDatabase(target, { limit: limit ? Number(limit) : undefined });
    printReport(report);
    if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    if (selfCheck) {
      assertSelfCheck(report);
      console.log("self-check passed");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
