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
// Denominator: opportunities split into `active_now` (K is still active) and `inactive_now` (K was active at S's time
// but is archived or superseded now). The replay runs on the current state and the product only ever offers active
// Knowledge (recall, file history and context scan `status = 'active'`), so an inactive_now K can never be offered.
// Every main class, cause and check below uses the active_now denominator; inactive_now is a separate block.
//
// Replay: for each Session with at least one opportunity (active_now or inactive_now), getContext() runs for {task}, {paths} and {task, paths}
// (task = Session title, paths = first 20 changed files) and every K is classified full / pointer_only / absent.
// For K absent from the combined variant, work_recall(limit 30) tells why: budget_trimmed (K is among the first five
// Knowledge hits yet missing), ranked_behind (K is beyond the fifth), or no_match (K not recalled; applies_to_only when
// no changed file appears in K.references).
//
// Diagnostics A-D (see docs/testing.md) split the remaining causes: appliesTo-only misses, pointer_only placement,
// opportunities per Session and file-history misses.
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
const { APPLIES_TO_SCAN_LIMIT, appliesToEntries, appliesToStrength, compileAppliesToEntry, createAppliesToBudget } =
  await import("../../packages/storage/dist/applies-to-match.js");
const { normalizePath } = await import("../../packages/storage/dist/search-text.js");

const REPLAY_PATH_LIMIT = 20;
const RELEVANT_LIMIT = 5;
const FILE_HISTORY_KNOWLEDGE_LIMIT = 5; // file-history-service.ts KNOWLEDGE_LIMIT
const FILE_HISTORY_SINGLE_CAP = 10;
const BUDGET_REASON_PREFIX = "預算限制";
const DUPLICATE_REASON_PREFIX = "已列於";
const BEYOND_LIMIT_REASON_PREFIX = "超出相關"; // ranked beyond the five relevant slots, listed as a path pointer
const SESSION_BUCKETS = ["1", "2-3", "4-5", "6-10", ">10"];
const CLASSES = ["full", "pointer_only", "absent"];
const VARIANTS = ["task", "paths", "both"];
const NOTES = [
  "Replay uses the current database state: Sessions and Knowledge created after S compete in ranking and recency.",
  "S itself is indexed and can be recalled; supplements sourced from S's own applied Knowledge are not counted as offered (selfSupplementLeak).",
  "Context and recall also match Knowledge appliesTo against queried paths (here the first 20 changed files), so no_match/applies_to_only now means the matching file lies beyond those paths or the match budget ran out. Older builds did not match appliesTo there.",
  "Opportunities are split by the Knowledge's CURRENT status: active_now is the denominator of every main class, cause and check; inactive_now (active at S, archived or superseded since) is reported separately because the product never offers inactive Knowledge.",
  "Diagnostic causes are verified directly with the product's exported matching functions and first match wins; file-history crowding and pattern-type counts are independent tallies as labelled.",
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
  // The rows every appliesTo scan reads: active, non-empty appliesTo, newest first, at most APPLIES_TO_SCAN_LIMIT per
  // project (recall, file history and context scope to one project).
  const scanned = new Map();
  const scanRows = db
    .prepare(
      `SELECT id, project_id FROM knowledge WHERE status = 'active' AND applies_to_json <> '[]'
       ORDER BY updated_at DESC, id ASC`,
    )
    .all();
  for (const row of scanRows) {
    const set = scanned.get(row.project_id) ?? new Set();
    if (set.size < APPLIES_TO_SCAN_LIMIT) set.add(row.id);
    scanned.set(row.project_id, set);
  }
  return { projects, sessions, knowledge, audit, feedback, scanned };
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
    matchers.push({
      isGlob: /[*?]/.test(pattern),
      matches: compiled.glob ? (path) => compiled.matches(path) : (path) => appliesToStrength(pattern, path) > 0,
    });
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
      const matchedFiles = normalized.filter((path) => entry.matchers.some((matcher) => matcher.matches(path)));
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
      const matching = entry.matchers.filter((matcher) => matchedFiles.some((path) => matcher.matches(path)));
      const globs = matching.filter((matcher) => matcher.isGlob).length;
      opportunities.push({
        knowledgeId: entry.item.id,
        sessionId: session.id,
        projectId: session.project_id,
        appliesToJson: entry.item.applies_to_json,
        patternType: globs === 0 ? "plain" : globs === matching.length ? "glob" : "mixed",
        matchedFiles,
        inReferences: normalized.some((path) => references.some((reference) => pathMatchesReference(path, reference))),
        activeNow: entry.item.status === "active",
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

function tally(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function sessionBucket(count) {
  if (count <= 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 5) return "4-5";
  if (count <= 10) return "6-10";
  return ">10";
}

/**
 * The product's own recall/file-history matching steps for one Knowledge row: its stored appliesTo is normalized
 * against the row's project (appliesToEntries) and each pattern is scored against the queried, already normalized
 * paths with appliesToStrength, as scoreAppliesTo and FileHistoryService.applicableKnowledge do.
 */
function productMatches(appliesToJson, project, queried) {
  const budget = createAppliesToBudget();
  const patterns = appliesToEntries(appliesToJson, [{ name: project.name, rootPath: project.root_path }], budget);
  for (const pattern of patterns) {
    for (const path of queried) if (appliesToStrength(pattern, path, budget) > 0) return true;
  }
  return false;
}

/** Where a context left a Knowledge id as a pointer: section group, reason kind and the possiblyStale flag. */
function pointerProfile(context, knowledgeId) {
  const omissions = (context.omitted ?? []).filter(
    (omission) =>
      (omission.ids ?? []).includes(knowledgeId) || (omission.entries ?? []).some((entry) => entry.id === knowledgeId),
  );
  const rank = (omission) =>
    omission.section === "relevant.knowledge" ? 0 : omission.section === "recentKnowledge" ? 1 : 2;
  const omission = [...omissions].sort((left, right) => rank(left) - rank(right))[0];
  if (!omission) return { section: "other", reason: "other", stale: false, path: false };
  const reasons = omission.reasons ?? [];
  const budget = reasons.some((reason) => reason.startsWith(BUDGET_REASON_PREFIX));
  const duplicate = (omission.duplicates ?? 0) > 0 || reasons.some((reason) => reason.includes(DUPLICATE_REASON_PREFIX));
  const beyondLimit = reasons.some((reason) => reason.startsWith(BEYOND_LIMIT_REASON_PREFIX));
  const entry = (omission.entries ?? []).find((candidate) => candidate.id === knowledgeId);
  return {
    section: ["relevant.knowledge", "recentKnowledge"].includes(omission.section) ? omission.section : "other",
    // Reasons belong to the section, so an id in a section with both reasons counts as budget.
    reason:
      budget && duplicate
        ? "budget+duplicate"
        : budget
          ? "budget"
          : duplicate
            ? "duplicate"
            : beyondLimit
              ? "beyond_limit"
              : "other",
    stale: Boolean(entry?.possiblyStale),
    // The pointer says which file the Knowledge covers: an entry with a title and one path.
    path: entry?.path !== undefined,
  };
}

function shapeOfPaths(rawPaths, project, shapes) {
  const contexts = [{ name: project.name, rootPath: project.root_path }];
  const root = project.root_path.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  const name = project.name.toLowerCase();
  for (const raw of rawPaths) {
    const value = raw.trim();
    const lower = value.replaceAll("\\", "/").toLowerCase();
    shapes.total += 1;
    if (value.includes("\\")) shapes.backslash += 1;
    if (value.startsWith("./")) shapes.dot_slash += 1;
    if (/:\d+(?::\d+)?$/.test(value)) shapes.line_anchor += 1;
    if (value !== value.toLowerCase()) shapes.has_uppercase += 1;
    if (lower.startsWith("/") || /^[a-z]:\//.test(lower)) {
      shapes.absolute += 1;
      if (root && (lower === root || lower.startsWith(`${root}/`))) shapes.absolute_under_root += 1;
      else shapes.absolute_outside_root += 1;
    } else {
      shapes.relative += 1;
      if (name && lower.startsWith(`${name}/`)) shapes.project_name_prefix += 1;
    }
    const normalized = normalizePath(raw, contexts);
    if (!normalized) shapes.empty_after_normalization += 1;
    else if (normalized !== value) shapes.changed_by_normalization += 1;
  }
}

function replay(store, rows, limit, started) {
  const totals = {
    projectsTracked: rows.projects.length,
    sessions: 0,
    knowledge: rows.knowledge.length,
    excluded_source_session: 0,
    excluded_not_active: 0,
  };
  const { opportunities: everything, projectById, sessionById } = buildOpportunities(rows, totals);
  const all = everything.filter((opportunity) => opportunity.activeNow);
  const allInactive = everything.filter((opportunity) => !opportunity.activeNow);
  const chosen = sample(all, limit);
  const chosenInactive = sample(allInactive, limit);
  const bySession = new Map();
  for (const opportunity of [...chosen, ...chosenInactive]) {
    const list = bySession.get(opportunity.sessionId) ?? [];
    list.push(opportunity);
    bySession.set(opportunity.sessionId, list);
  }

  const variants = Object.fromEntries(
    VARIANTS.map((name) => [name, Object.fromEntries(CLASSES.map((cls) => [cls, cell()]))]),
  );
  const inactiveVariants = Object.fromEntries(
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
  // A: why an absent, unrecalled appliesTo-only Knowledge was missed (first match wins).
  const appliesToOnly = {
    beyond_replayed_paths: cell(),
    applies_to_budget_or_scan: cell(),
    product_matcher_mismatch: cell(),
    reserve_crowded: cell(),
    unknown: cell(),
  };
  const scanDetail = { not_in_scan_set: 0, truncated_warning: 0 };
  // B: where a pointer_only Knowledge pointer sits.
  const pointerOnly = {
    total: 0,
    bySection: {},
    byReason: {},
    possiblyStale: {},
    withPath: {},
    inRecall20Top5: {},
    profile: {},
  };
  // C: opportunity Knowledge per replayed Session against the combined variant's result.
  const perSession = Object.fromEntries(
    SESSION_BUCKETS.map((bucket) => [bucket, { sessions: 0, opportunities: 0, full: 0, pointer_only: 0, absent: 0 }]),
  );
  // D: why an absent Knowledge is not in getFileHistory of its first three matched files.
  const fileHistoryMisses = {
    total: 0,
    causes: {
      outside_scan_set: 0,
      scan_truncated: 0,
      matcher_mismatch: 0,
      crowding_limit5: 0,
      unknown: 0,
    },
    single_file_finds: { yes: 0, no: 0 },
    pattern_type: {},
    profile: {},
  };
  const pathShapes = {
    total: 0,
    relative: 0,
    absolute: 0,
    absolute_under_root: 0,
    absolute_outside_root: 0,
    backslash: 0,
    dot_slash: 0,
    line_anchor: 0,
    has_uppercase: 0,
    project_name_prefix: 0,
    changed_by_normalization: 0,
    empty_after_normalization: 0,
  };
  let possiblyHiddenByMoreIds = 0;
  let selfSupplementLeak = 0;
  let contextErrors = 0;
  const contextChars = [];

  for (const [sessionId, fullList] of bySession) {
    const list = fullList.filter((opportunity) => opportunity.activeNow);
    const inactiveList = fullList.filter((opportunity) => !opportunity.activeNow);
    const session = sessionById.get(sessionId);
    const project = projectById.get(session.project_id);
    const root = project.root_path;
    const task = session.title;
    const paths = parseList(session.changed_files_json).slice(0, REPLAY_PATH_LIMIT);
    // The queried paths the product derives from the raw strings passed as `paths` (recall normalizes them itself).
    const queried = [
      ...new Set(paths.map((path) => normalizePath(path, [{ name: project.name, rootPath: root }])).filter(Boolean)),
    ];
    const scanned = rows.scanned.get(session.project_id) ?? new Set();
    shapeOfPaths(paths, project, pathShapes);
    // One call per Session and variant, however many Knowledge items it has opportunities for.
    const contexts = {
      task: store.getContext(root, { task }),
      paths: store.getContext(root, { paths }),
      both: store.getContext(root, { task, paths }),
    };
    if (list.length > 0) contextChars.push(JSON.stringify(contexts.both).length);
    for (const opportunity of inactiveList) {
      for (const variant of VARIANTS) {
        const result = classifyContext(contexts[variant], opportunity.knowledgeId, sessionId);
        if (result.via === "error") contextErrors += 1;
        bump(inactiveVariants[variant][result.cls], opportunity);
      }
    }
    const hitsOf = (result) => (result.outcome === "recall" ? result.hits : []);
    const cache = { history: new Map() };
    const recall30Result = () => (cache.recall30 ??= store.recall({ q: task, paths, projectRoot: root, limit: 30 }));
    const recall30 = () => hitsOf(recall30Result());
    const recall20 = () => (cache.recall20 ??= hitsOf(store.recall({ q: task, paths, projectRoot: root, limit: 20 })));
    // The Knowledge-only ranking at the same limit, straight from the search index (no public option for `types`).
    const recallKnowledge30 = () =>
      (cache.recallKnowledge30 ??= store.searchIndex
        .recall({ q: task, paths, projectId: session.project_id, types: ["knowledge"], limit: 30 })
        .hits.filter((hit) => hit.type === "knowledge"));
    const recallDefault = () => (cache.recallDefault ??= hitsOf(store.recall({ q: task, paths, projectRoot: root })));
    const fileHistory = (files) => {
      const key = files.join("\u0000");
      if (!cache.history.has(key)) {
        const result = store.getFileHistory({ projectRoot: root, paths: files });
        cache.history.set(
          key,
          result.outcome === "file_history"
            ? {
                ids: new Set(result.knowledge.map((item) => item.id)),
                count: result.knowledge.length,
                omitted: result.knowledgeOmitted ?? 0,
                truncated: result.appliesToScanTruncated === true,
              }
            : { ids: new Set(), count: 0, omitted: 0, truncated: false },
        );
      }
      return cache.history.get(key);
    };
    const bucketCounts = { full: 0, pointer_only: 0, absent: 0 };

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
      bucketCounts[classes.both.cls] += 1;
      if (classes.both.cls === "pointer_only") {
        const profile = pointerProfile(contexts.both, opportunity.knowledgeId);
        const top5 = recall20()
          .filter((hit) => hit.type === "knowledge")
          .slice(0, RELEVANT_LIMIT)
          .some((hit) => hit.id === opportunity.knowledgeId);
        pointerOnly.total += 1;
        tally(pointerOnly.bySection, profile.section);
        tally(pointerOnly.byReason, profile.reason);
        tally(pointerOnly.possiblyStale, profile.stale ? "possiblyStale" : "not_stale");
        tally(pointerOnly.withPath, profile.path ? "with_title_and_path" : "id_only");
        tally(pointerOnly.inRecall20Top5, top5 ? "in_top5" : "not_in_top5");
        tally(
          pointerOnly.profile,
          `${profile.section} / ${profile.reason} / ${profile.stale ? "stale" : "not_stale"} / ${profile.path ? "path" : "id_only"} / ${top5 ? "in_top5" : "not_in_top5"}`,
        );
      }
      if (classes.both.cls !== "absent") continue;
      bump(checks.total, opportunity);
      if (
        (contexts.both.omitted ?? []).some(
          (omission) => ["relevant.knowledge", "recentKnowledge"].includes(omission.section) && omission.moreIds > 0,
        )
      ) {
        possiblyHiddenByMoreIds += 1;
      }
      const knowledgeHits = recall30().filter((hit) => hit.type === "knowledge");
      const rank = knowledgeHits.findIndex((hit) => hit.id === opportunity.knowledgeId);
      if (rank >= 0 && rank < RELEVANT_LIMIT) bump(causes.budget_trimmed, opportunity);
      else if (rank >= RELEVANT_LIMIT) bump(causes.ranked_behind, opportunity);
      else bump(causes.no_match[opportunity.inReferences ? "other" : "applies_to_only"], opportunity);
      if (rank < 0 && !opportunity.inReferences) {
        const warnings = recall30Result().warnings ?? [];
        const truncated = warnings.some((warning) => warning.includes("appliesTo"));
        const outside = !scanned.has(opportunity.knowledgeId);
        const script = opportunity.matchedFiles.filter((path) => queried.includes(path));
        let cause;
        if (script.length === 0) cause = "beyond_replayed_paths";
        else if (outside || truncated) {
          cause = "applies_to_budget_or_scan";
          if (outside) scanDetail.not_in_scan_set += 1;
          if (truncated) scanDetail.truncated_warning += 1;
        } else if (!productMatches(opportunity.appliesToJson, project, queried)) cause = "product_matcher_mismatch";
        else if (recallKnowledge30().some((hit) => hit.id === opportunity.knowledgeId)) cause = "reserve_crowded";
        else cause = "unknown";
        bump(appliesToOnly[cause], opportunity);
      }
      const inRecall = recallDefault().some((hit) => hit.type === "knowledge" && hit.id === opportunity.knowledgeId);
      bump(inRecall ? checks.in_recall : checks.not_in_recall, opportunity);
      const files = opportunity.matchedFiles.slice(0, 3);
      const history = fileHistory(files);
      const inHistory = history.ids.has(opportunity.knowledgeId);
      bump(inHistory ? checks.in_file_history : checks.not_in_file_history, opportunity);
      if (!inHistory) {
        fileHistoryMisses.total += 1;
        const single = opportunity.matchedFiles
          .slice(0, FILE_HISTORY_SINGLE_CAP)
          .some((file) => fileHistory([file]).ids.has(opportunity.knowledgeId));
        let cause;
        if (!scanned.has(opportunity.knowledgeId)) cause = "outside_scan_set";
        else if (history.truncated) cause = "scan_truncated";
        else if (!productMatches(opportunity.appliesToJson, project, files)) cause = "matcher_mismatch";
        else if (history.omitted > 0 || history.count >= FILE_HISTORY_KNOWLEDGE_LIMIT) cause = "crowding_limit5";
        else cause = "unknown";
        fileHistoryMisses.causes[cause] += 1;
        fileHistoryMisses.single_file_finds[single ? "yes" : "no"] += 1;
        tally(fileHistoryMisses.pattern_type, opportunity.patternType);
        tally(
          fileHistoryMisses.profile,
          `${cause} / ${single ? "single_file_finds" : "single_file_misses"} / ${opportunity.patternType}`,
        );
      }
    }
    if (list.length === 0) continue;
    const bucket = perSession[sessionBucket(list.length)];
    bucket.sessions += 1;
    bucket.opportunities += list.length;
    for (const cls of Object.keys(bucketCounts)) bucket[cls] += bucketCounts[cls];
  }

  const reportState = cell();
  for (const opportunity of chosen) bump(reportState, opportunity);
  const inactiveReportState = cell();
  for (const opportunity of chosenInactive) bump(inactiveReportState, opportunity);
  const provisionRate = Object.fromEntries(
    VARIANTS.map((name) => {
      const pairs = CLASSES.reduce((total, cls) => total + variants[name][cls].pairs, 0);
      const percent = (cls) => (pairs === 0 ? 0 : Math.round((variants[name][cls].pairs / pairs) * 1000) / 10);
      return [name, { pairs, full: percent("full"), pointer_only: percent("pointer_only"), absent: percent("absent") }];
    }),
  );
  return {
    totals: {
      ...totals,
      opportunities: all.length,
      opportunitiesReplayed: chosen.length,
      sessionsWithOpportunity: new Set(all.map((item) => item.sessionId)).size,
      sessionsReplayed: new Set(chosen.map((item) => item.sessionId)).size,
      distinctKnowledgeInOpportunities: new Set(all.map((item) => item.knowledgeId)).size,
      opportunitiesInactiveNow: allInactive.length,
    },
    reportState,
    variants,
    provisionRate,
    inactiveNow: {
      pairs: chosenInactive.length,
      sessions: new Set(allInactive.map((item) => item.sessionId)).size,
      distinctKnowledge: new Set(allInactive.map((item) => item.knowledgeId)).size,
      reportState: inactiveReportState,
      variants: inactiveVariants,
    },
    combined: {
      fullVia,
      absentCauses: causes,
      absentChecks: checks,
      appliesToOnly,
      appliesToScanDetail: scanDetail,
      pointerOnly,
      perSession,
      fileHistoryMisses,
      possiblyHiddenByMoreIds,
      replayedPathShapes: pathShapes,
    },
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
    out.push(`Variant ${variant} (active_now)`);
    for (const cls of CLASSES) out.push(`  ${line(cls, fmt(report.variants[variant][cls]))}`);
  }
  out.push("provision rate (active_now)");
  for (const [variant, rate] of Object.entries(report.provisionRate)) {
    out.push(
      `  ${line(variant, `full ${rate.full}%, pointer_only ${rate.pointer_only}%, absent ${rate.absent}% of ${rate.pairs}`)}`,
    );
  }
  const { inactiveNow } = report;
  out.push("inactive_now (archived/superseded after S; the product never offers these)");
  out.push(`  ${line("pairs / Sessions / distinct K", `${inactiveNow.pairs} / ${inactiveNow.sessions} / ${inactiveNow.distinctKnowledge}`)}`);
  out.push(`  ${line("report state", fmt(inactiveNow.reportState))}`);
  for (const variant of VARIANTS) {
    for (const cls of CLASSES) out.push(`  ${line(`${variant}: ${cls}`, fmt(inactiveNow.variants[variant][cls]))}`);
  }
  out.push("Combined variant");
  for (const [key, value] of Object.entries(report.combined.fullVia)) out.push(`  ${line(`full via ${key}`, value)}`);
  const { absentCauses, absentChecks } = report.combined;
  out.push(`  ${line("absent: budget_trimmed", fmt(absentCauses.budget_trimmed))}`);
  out.push(`  ${line("absent: ranked_behind", fmt(absentCauses.ranked_behind))}`);
  out.push(`  ${line("absent: no_match/applies_to_only", fmt(absentCauses.no_match.applies_to_only))}`);
  out.push(`  ${line("absent: no_match/other", fmt(absentCauses.no_match.other))}`);
  for (const [key, value] of Object.entries(absentChecks)) out.push(`  ${line(`absent, ${key}`, fmt(value))}`);
  out.push(`  ${line("absent, maybe hidden by moreIds", report.combined.possiblyHiddenByMoreIds)}`);
  const sorted = (map) =>
    Object.entries(map)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key, value]) => `${key} ${value}`)
      .join(", ") || "none";
  const { appliesToOnly, appliesToScanDetail, pointerOnly, perSession, fileHistoryMisses, replayedPathShapes } =
    report.combined;
  out.push("A. absent, applies_to_only, not in recall@30 (first match wins)");
  for (const [key, value] of Object.entries(appliesToOnly)) out.push(`  ${line(key, fmt(value))}`);
  out.push(`  ${line("scan detail (can overlap)", sorted(appliesToScanDetail))}`);
  out.push(`B. pointer_only in the combined variant (${pointerOnly.total})`);
  out.push(`  ${line("by section", sorted(pointerOnly.bySection))}`);
  out.push(`  ${line("by reason", sorted(pointerOnly.byReason))}`);
  out.push(`  ${line("possiblyStale", sorted(pointerOnly.possiblyStale))}`);
  out.push(`  ${line("pointer shape", sorted(pointerOnly.withPath))}`);
  out.push(`  ${line("in recall@20 Knowledge top 5", sorted(pointerOnly.inRecall20Top5))}`);
  for (const [key, value] of Object.entries(pointerOnly.profile)) out.push(`  profile ${key}: ${value}`);
  out.push("C. opportunity Knowledge per replayed Session (combined variant)");
  for (const [bucket, item] of Object.entries(perSession)) {
    out.push(
      `  ${line(`bucket ${bucket}`, `sessions ${item.sessions}, opportunities ${item.opportunities}, full ${item.full}, pointer_only ${item.pointer_only}, absent ${item.absent}`)}`,
    );
  }
  out.push(`D. absent and not in getFileHistory(first 3 matched files) (${fileHistoryMisses.total}; first match wins)`);
  for (const [key, value] of Object.entries(fileHistoryMisses.causes)) out.push(`  ${line(key, value)}`);
  out.push(`  ${line("single file call finds it (indep.)", sorted(fileHistoryMisses.single_file_finds))}`);
  out.push(`  ${line("pattern type (indep.)", sorted(fileHistoryMisses.pattern_type))}`);
  for (const [key, value] of Object.entries(fileHistoryMisses.profile)) out.push(`  profile ${key}: ${value}`);
  out.push("Replayed raw changed-file path shapes (first 20 per Session)");
  for (const [key, value] of Object.entries(replayedPathShapes)) out.push(`  ${line(key, value)}`);
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

  // Seven Knowledge items on one file, the oldest records: file history lists only five of them, so two are left out
  // by its KNOWLEDGE_LIMIT, and the context's five relevant slots leave the same two out.
  ids.crowd = [];
  for (let index = 0; index < 14; index += 1) {
    ids.crowd.push(
      knowledge(`Marlinspike hatch rule ${index}`, `Marlinspike hatch ${index} note.`, { appliesTo: ["src/crowd/**"] }),
    );
  }

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
  session("Adjust crowd lane wiring", ["src/crowd/a.ts"]);
  // A later Session confirms the crowd rules (applied evidence newer than the change), so none is possiblyStale and
  // the pointers cannot rely on the always-kept flagged entries: the entry cap and moreIds are exercised.
  session("Confirm hatchway tally", ["src/hatchway/tally.ts"], { appliedKnowledgeIds: ids.crowd });
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
  // The archived-after-S rule is the one inactive_now opportunity; the 33 others are active_now.
  expect(totals.opportunities, 33, "active_now opportunities");
  expect(totals.opportunitiesReplayed, 33, "replayed active_now opportunities");
  expect(totals.opportunitiesInactiveNow, 1, "inactive_now opportunities");
  expect(totals.sessionsWithOpportunity, 10, "Sessions with an active_now opportunity");
  expect(totals.sessionsReplayed, 10, "replayed Sessions");
  expect(totals.distinctKnowledgeInOpportunities, 25, "distinct active_now Knowledge");
  // Six applied rows on opportunity pairs; fourteen more come from the Session that confirms the crowd rules and is
  // not an opportunity itself.
  expect(totals.applied_rows_total, 20, "applied rows");
  expect(totals.applied_rows_outside_opportunities, 14, "applied rows outside opportunities");
  expect(counts(report.reportState), [33, 6, 27, 1], "report state");
  // inactive_now: never offered in any variant, so every pair is absent; it stays out of the active_now classes.
  const inactive = report.inactiveNow;
  expect([inactive.pairs, inactive.sessions, inactive.distinctKnowledge], [1, 1, 1], "inactive_now size");
  expect(counts(inactive.reportState), [1, 0, 1, 0], "inactive_now report state");
  for (const variant of ["task", "paths", "both"]) {
    expect(counts(inactive.variants[variant].absent), [1, 0, 1, 0], `inactive_now ${variant} absent`);
    expect(
      inactive.variants[variant].full.pairs + inactive.variants[variant].pointer_only.pairs,
      0,
      `inactive_now ${variant} offered`,
    );
  }
  // Provision rate on the active_now denominator: percentages of each variant's 33 pairs.
  expect(
    report.provisionRate.both,
    { pairs: 33, full: 33.3, pointer_only: 57.6, absent: 9.1 },
    "provision rate (both)",
  );
  expect(
    report.provisionRate.paths,
    { pairs: 33, full: 57.6, pointer_only: 33.3, absent: 9.1 },
    "provision rate (paths)",
  );
  expect(
    report.provisionRate.task,
    { pairs: 33, full: 21.2, pointer_only: 18.2, absent: 60.6 },
    "provision rate (task)",
  );
  // Combined variant: [pairs, reported, unreported, contradicted].
  expect(counts(variants.both.full), [11, 2, 9, 1], "full: reported, unreported and contradicted");
  expect(counts(variants.both.pointer_only), [19, 4, 15, 0], "pointer_only");
  expect(counts(variants.both.absent), [3, 0, 3, 0], "absent");
  // Paths alone reach Knowledge through appliesTo: appliesTo-only opportunities within the replayed paths are full
  // relevant records or path pointers.
  expect(variants.paths.full.pairs, 19, "paths-only variant offers appliesTo-matched records");
  const { absentCauses, absentChecks } = combined;
  // Path-matched Knowledge that the budget trims or that ranks beyond the five relevant slots now survives as a
  // pointer, so nothing is budget_trimmed; one of the fourteen crowd rules is past the entry cap and the id slots.
  expect(counts(absentCauses.budget_trimmed), [0, 0, 0, 0], "budget_trimmed");
  expect(counts(absentCauses.ranked_behind), [1, 0, 1, 0], "ranked_behind");
  expect(counts(absentCauses.no_match.applies_to_only), [1, 0, 1, 0], "no_match / applies_to_only");
  expect(counts(absentCauses.no_match.other), [1, 0, 1, 0], "no_match / other");
  expect(counts(absentChecks.in_recall), [0, 0, 0, 0], "absent but in default recall");
  expect([absentChecks.in_file_history.pairs, absentChecks.not_in_file_history.pairs], [2, 1], "file history");

  // A: the Ambergris rule's only matching file is the 21st changed file. The archived rule is no longer an active_now
  // opportunity, so no active_now Knowledge may fall outside the scan set (a hit here would be a real scan bug).
  const split = combined.appliesToOnly;
  expect(counts(split.beyond_replayed_paths), [1, 0, 1, 0], "beyond_replayed_paths");
  expect(counts(split.applies_to_budget_or_scan), [0, 0, 0, 0], "applies_to_budget_or_scan");
  expect(combined.appliesToScanDetail, { not_in_scan_set: 0, truncated_warning: 0 }, "scan detail");
  expect(counts(split.product_matcher_mismatch), [0, 0, 0, 0], "product_matcher_mismatch");
  expect(counts(split.reserve_crowded), [0, 0, 0, 0], "reserve_crowded");
  expect(counts(split.unknown), [0, 0, 0, 0], "unknown");
  expect(
    split.beyond_replayed_paths.pairs +
      split.applies_to_budget_or_scan.pairs +
      split.product_matcher_mismatch.pairs +
      split.reserve_crowded.pairs +
      split.unknown.pairs,
    absentCauses.no_match.applies_to_only.pairs,
    "A partitions applies_to_only",
  );
  // B: eight pointers are budget-trimmed top-5 records (title and path), three crowd rules ranked beyond the five
  // relevant slots and the entry cap keep only an id, five more beyond-the-limit rules keep title and path, and two
  // stale budget-trimmed rules and one stale recent tail keep their flagged entry.
  const pointers = combined.pointerOnly;
  expect(pointers.total, variants.both.pointer_only.pairs, "pointer_only total");
  expect(pointers.bySection, { "relevant.knowledge": 18, recentKnowledge: 1 }, "pointer sections");
  expect(pointers.byReason, { budget: 11, beyond_limit: 8 }, "pointer reasons");
  expect(pointers.possiblyStale, { not_stale: 16, possiblyStale: 3 }, "pointer staleness");
  expect(pointers.withPath, { with_title_and_path: 15, id_only: 4 }, "pointer shape");
  expect(pointers.inRecall20Top5, { in_top5: 8, not_in_top5: 11 }, "pointer recall top 5");
  // C: seven Sessions with one opportunity, two with six to nine, one with fourteen; buckets partition the pairs.
  const buckets = combined.perSession;
  expect([buckets["1"].sessions, buckets["6-10"].sessions, buckets[">10"].sessions], [7, 2, 1], "Session buckets");
  expect(
    Object.values(buckets).reduce((total, item) => total + item.full + item.pointer_only + item.absent, 0),
    totals.opportunitiesReplayed,
    "bucket pairs",
  );
  // D: fourteen Knowledge on one file, file history lists five; the one rule the context cannot point to is also
  // crowded out of file history. No active_now Knowledge is outside the scanned set.
  const misses = combined.fileHistoryMisses;
  expect(misses.total, absentChecks.not_in_file_history.pairs, "file history misses");
  expect(misses.causes.crowding_limit5, 1, "file-history crowding");
  expect(misses.causes.outside_scan_set, 0, "file history outside scan set");
  expect(misses.causes.matcher_mismatch + misses.causes.scan_truncated + misses.causes.unknown, 0, "other causes");
  expect(misses.pattern_type, { glob: 1 }, "file history pattern types");
  expect(misses.single_file_finds, { yes: 0, no: 1 }, "single file finds");
  // Every fictional changed file is a plain relative path, so normalization changes nothing.
  expect(combined.replayedPathShapes.total, combined.replayedPathShapes.relative, "path shapes");
  expect(combined.replayedPathShapes.changed_by_normalization, 0, "normalization changes");
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
