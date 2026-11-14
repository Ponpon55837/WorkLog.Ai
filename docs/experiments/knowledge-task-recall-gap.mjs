// Knowledge task-recall gap probe (read-only replay; research tool, not a product feature).
//
// Question: when an Agent gives only a task title, why is a Knowledge item that WAS applicable at that moment not
// found, and how many of those misses would (a) document expansion, (c) a learned symptom lexicon or (d) file
// co-change expansion have recovered in a time-ordered replay, at what false-positive price?
//
// Usage:
//   pnpm build                                   (only the real run imports packages/storage/dist)
//   node docs/experiments/knowledge-task-recall-gap.mjs [database] [--root <tracked project root>]
//   node docs/experiments/knowledge-task-recall-gap.mjs --self-check     (pure functions only; no dist, no database)
//
// Ground truth ("task x applicable Knowledge" pairs) follows docs/experiments/task-path-replay.mjs, whose `targets`
// set (`tally.pairs`) is the pair count the 221 figure refers to:
//   question = a non-voided Session with a start time and at least one changed file; task = its title with explicit
//   file/path tokens removed; known Knowledge = knowledge_audit revisions older than the question's start; active
//   Knowledge = status active, not sourced from the question itself, with appliesTo; target = active Knowledge whose
//   appliesTo covers at least one changed file of the question (the product's appliesToStrength > 0).
// That definition can only contain Knowledge WITH a matching appliesTo, so causes (iii) and (iv) could never occur in
// it. This script therefore reports two groups and their sum:
//   scoped       = exactly the task-path-replay target pairs (the 221-style set).
//   applied_only = active Knowledge the question reported as applied (knowledge_feedback kind applied) whose
//                  appliesTo does NOT cover its changed files, or that has no appliesTo at all.
// History visible to a question is cut at its start (Sessions by availability, Knowledge revisions, feedback), like
// task-path-replay.mjs; the applied_only ground truth uses the question's own later feedback by definition.
//
// "Found by title only" = the product's getContext({ task }) on an in-memory replay store shows the Knowledge in
// relevant.knowledge or relevant.supplements. Appearing only in recentKnowledge is NOT found (it is listed under
// recent_only): that list is shown whatever the task says.
//
// Miss causes (mutually exclusive, first match wins):
//   no_applies_to          (iii) Knowledge has no appliesTo.
//   applies_to_mismatch    (iv)  appliesTo exists but covers none of the question's changed files.
//   vocab_gap_expandable   (i)   task terms and the Knowledge's own text (title, body, tags, references) share no term,
//                                but the task shares a term with the title of its source Session or of an earlier
//                                Session that applied it (what document expansion would index).
//   vocab_gap_unrescuable  (ii)  no shared term even after that expansion.
//   ranked_outside_budget  (v)   a shared term exists, yet the product did not show it.
//
// Estimates use a deterministic IDF-coverage ranker over the active Knowledge of that moment (top RELEVANT_LIMIT,
// coverage floor like the product), compared before and after expansion; (d) matches appliesTo against the paths a
// P5-like predictor (similar Session titles -> their changed files, as in task-path-replay.mjs) names, then against
// those paths widened by files that changed together in earlier Sessions.
//
// Output: aggregate numbers only (counts, ratios, quantiles) plus fixed constant notes. No titles, paths, ids, project
// names or record text is ever printed; --self-check asserts that on a synthetic dataset.
import assert from "node:assert/strict";
import console from "node:console";
import { resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const RELEVANT_LIMIT = 5;
const RECENT_LIMIT = 12;
const MIN_COVERAGE = 0.1;
const PREDICT_SESSIONS = 5;
const PREDICT_PATHS = 3;
const COCHANGE_NEIGHBORS = 5;
const COCHANGE_MAX_FILES = 20;
const LEXICON_SUPPORTS = [1, 2];
const GENERIC_TITLE_DF_SHARE = 0.2;
const GROUPS = ["all", "scoped", "applied_only"];
const CAUSES = [
  "no_applies_to",
  "applies_to_mismatch",
  "vocab_gap_expandable",
  "vocab_gap_unrescuable",
  "ranked_outside_budget",
];
const RANK_BUCKETS = ["1-5", "6-12", "13-30", ">30", "below_coverage_floor"];
const NOTES = [
  "scoped is the task-path-replay target set; applied_only is Knowledge the question reported as applied that appliesTo does not cover.",
  "found means relevant.knowledge or relevant.supplements of getContext({ task }); recent_only is the fixed newest-12 list.",
  "Estimates rank with a simplified IDF-coverage model over Knowledge only; the product also ranks Sessions in the same pool, so estimates are optimistic.",
  "Replay uses the current store contents cut at each question start; manual_confirm feedback is not replayed.",
];

const EMPTY = new Set();

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (also used by --self-check)
// ---------------------------------------------------------------------------------------------------------------
const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const TOKEN_RUN = new RegExp(`([${CJK_CLASS}]+)|((?:(?![${CJK_CLASS}])[\\p{L}\\p{N}])+)`, "gu");
const LOCAL_STOPWORDS = new Set(
  "a an and are as at be by can do does for from how in is it of on or that the this to was what when where which why with".split(
    " ",
  ),
);

/** A copy of the product tokenizer's behaviour, used only when dist is unavailable (self-check). */
function localTokenize(text) {
  const tokens = [];
  for (const match of text.normalize("NFKC").matchAll(TOKEN_RUN)) {
    const [, cjk, word] = match;
    if (cjk) {
      const chars = Array.from(cjk);
      if (chars.length === 1) tokens.push(cjk);
      for (let index = 0; index < chars.length - 1; index += 1) tokens.push(`${chars[index]}${chars[index + 1]}`);
    } else if (word) {
      if (word.length >= 2) tokens.push(word.toLowerCase());
      const parts = word
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
        .split(" ");
      if (parts.length > 1) for (const part of parts) if (part.length >= 2) tokens.push(part.toLowerCase());
    }
  }
  return tokens;
}

function localTermsOf(text) {
  const terms = new Set();
  for (const word of text.split(/[\s,;，；、。]+/u)) {
    for (const term of localTokenize(word)) if (!LOCAL_STOPWORDS.has(term) && !/^\d+$/.test(term)) terms.add(term);
  }
  return terms;
}

function localNormalize(path) {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function localPathMatches(pattern, file) {
  return (
    pattern === file || file.endsWith(`/${pattern}`) || pattern.endsWith(`/${file}`) || file.startsWith(`${pattern}/`)
  );
}

// Remove explicit file/path tokens without consulting the answer files (same expression as task-path-replay.mjs).
function hidePaths(text) {
  return text.replace(
    /(?:[A-Za-z]:)?(?:[\w@.~-]+[/\\])+[\w@./\\~-]+|[\w@-]+(?:\.[\w-]+)*\.(?:[cm]?[jt]sx?|vue|json|md|sql|ya?ml|toml|css|html|py|sh|ps1|sqlite)\b/giu,
    " ",
  );
}

/** replay() annotates the Sessions it reads, so each run gets its own copy. */
function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(items) {
  return [...new Set(items)];
}

function increment(map, key, value = 1) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function intersects(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function union(...sets) {
  const result = new Set();
  for (const set of sets) for (const item of set) result.add(item);
  return result;
}

function parseList(text) {
  try {
    const value = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function ratio(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : 0);
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

/** Why a task found nothing on a Knowledge item that applied; the order is the precedence (see the file header). */
function classifyMiss({ hasAppliesTo, appliesToCovers, taskTerms, textTerms, sourceTerms, appliedTerms }) {
  if (!hasAppliesTo) return "no_applies_to";
  if (!appliesToCovers) return "applies_to_mismatch";
  if (intersects(taskTerms, textTerms)) return "ranked_outside_budget";
  if (intersects(taskTerms, sourceTerms) || intersects(taskTerms, appliedTerms)) return "vocab_gap_expandable";
  return "vocab_gap_unrescuable";
}

function rankBucket(rank) {
  if (rank === undefined) return "below_coverage_floor";
  if (rank <= 5) return "1-5";
  if (rank <= 12) return "6-12";
  return rank <= 30 ? "13-30" : ">30";
}

/**
 * Ranks docs ({ id, terms, extra?, updatedAt }) by IDF-weighted share of the task terms they contain, dropping those
 * under MIN_COVERAGE, newest first on ties. `extra` holds expansion terms indexed beside the record's own text.
 */
function simulate(taskTerms, docs) {
  const total = docs.length;
  const has = (doc, term) => doc.terms.has(term) || (doc.extra?.has(term) ?? false);
  const idf = new Map();
  let totalIdf = 0;
  for (const term of taskTerms) {
    const count = docs.reduce((sum, doc) => sum + (has(doc, term) ? 1 : 0), 0);
    const value = Math.log(1 + (total - count + 0.5) / (count + 0.5));
    idf.set(term, value);
    totalIdf += value;
  }
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of taskTerms) if (has(doc, term)) score += idf.get(term);
    if (score > 0 && totalIdf > 0 && score / totalIdf >= MIN_COVERAGE) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt || a.doc.id.localeCompare(b.doc.id));
  const rankOf = new Map(scored.map(({ doc }, index) => [doc.id, index + 1]));
  return {
    ranked: scored.map(({ doc }) => doc.id),
    rankOf,
    top: new Set(scored.slice(0, RELEVANT_LIMIT).map(({ doc }) => doc.id)),
  };
}

/** The P5-like predictor of task-path-replay.mjs: files of the most title-similar earlier Sessions, IDF weighted. */
function predictPaths(taskTerms, past) {
  const df = new Map();
  for (const session of past) for (const term of session.terms) increment(df, term);
  const related = [];
  for (const session of past) {
    if (!session.files.length) continue;
    let weight = 0;
    for (const term of taskTerms) {
      if (session.terms.has(term)) weight += Math.log((past.length + 1) / (df.get(term) + 0.5));
    }
    if (weight > 0) related.push({ session, score: weight / Math.sqrt(Math.max(1, session.terms.size)) });
  }
  related.sort((a, b) => b.score - a.score || b.session.available - a.session.available);
  const scores = new Map();
  for (const { session, score } of related.slice(0, PREDICT_SESSIONS)) {
    for (const file of session.files) increment(scores, file, score / Math.sqrt(session.files.length));
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PREDICT_PATHS)
    .map(([path]) => path);
}

/** Adds, for each predicted file, the files that most often changed in the same earlier Session. */
function expandByCochange(predicted, cochange) {
  const expanded = new Set(predicted);
  for (const file of predicted) {
    const neighbours = [...(cochange.get(file) ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [neighbour] of neighbours.slice(0, COCHANGE_NEIGHBORS)) expanded.add(neighbour);
  }
  return [...expanded];
}

function addCochange(cochange, files) {
  if (files.length < 2 || files.length > COCHANGE_MAX_FILES) return;
  for (const left of files) {
    for (const right of files) {
      if (left === right) continue;
      const row = cochange.get(left) ?? new Map();
      cochange.set(left, row);
      increment(row, right);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Replay (pure over a dataset; the product store is reached only through deps.sink)
// ---------------------------------------------------------------------------------------------------------------
function groupCounters() {
  return {
    total: 0,
    found: 0,
    recent_only: 0,
    absent: 0,
    notFound: 0,
  };
}

function variantCounters() {
  return {
    ceiling: 0,
    rescued: 0,
    rescued_scoped: 0,
    rescued_applied_only: 0,
    displacedTargets: 0,
    extraOnNegatives: 0,
    negativeTasksWithExtra: 0,
    extraNonTargetOnPositives: 0,
    extraPerNegativeTask: [],
  };
}

function replay(data, deps) {
  const { termsOf, pathMatches, sink } = deps;
  const history = data.sessions.filter((s) => Number.isFinite(s.available)).sort((a, b) => a.available - b.available);
  const questions = data.sessions
    .filter((s) => Number.isFinite(s.start) && s.files.length)
    .sort((a, b) => a.start - b.start);
  const revisions = data.revisions.filter((r) => Number.isFinite(r.time)).sort((a, b) => a.time - b.time);
  const pending = data.feedback.filter((f) => Number.isFinite(f.time)).sort((a, b) => a.time - b.time);
  // Ground truth only: every applied report of a question, including its own later ones.
  const appliedByQuestion = new Map();
  for (const f of data.feedback) {
    if (f.kind !== "applied") continue;
    const set = appliedByQuestion.get(f.sessionId) ?? new Set();
    appliedByQuestion.set(f.sessionId, set);
    set.add(f.knowledgeId);
  }

  const past = [];
  const pastById = new Map();
  const known = new Map();
  const appliers = new Map(); // Knowledge id -> Sessions that applied it before the question
  const lexicon = new Map(); // title term -> Knowledge id -> applying Sessions with that term
  const titleDf = new Map();
  const cochange = new Map();
  let si = 0;
  let ri = 0;
  let waiting = pending;

  const tally = {
    sessions: data.sessions.length,
    questions: 0,
    noTaskText: 0,
    skippedSelfInHistory: 0,
    emptyTaskTerms: 0,
    noActiveKnowledge: 0,
    withActiveKnowledge: 0,
    withTargets: 0,
    withScopedTargets: 0,
    negatives: 0,
  };
  const pairs = Object.fromEntries(GROUPS.map((g) => [g, groupCounters()]));
  const causes = Object.fromEntries(GROUPS.map((g) => [g, Object.fromEntries(CAUSES.map((c) => [c, 0]))]));
  const recentCauses = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  const expandableVia = { source_only: 0, applied_only: 0, both: 0 };
  const rankBuckets = Object.fromEntries(RANK_BUCKETS.map((b) => [b, 0]));
  const noAppliesToOrMismatchText = { text_overlap: 0, no_text_overlap: 0 };
  const calibration = { found_and_sim_top5: 0, found_not_sim_top5: 0, notfound_but_sim_top5: 0, neither: 0 };
  const negativeShown = { product: 0, simulated: 0 };
  const a = variantCounters();
  const c = Object.fromEntries(LEXICON_SUPPORTS.map((m) => [m, variantCounters()]));
  const d = {
    p5: { rescued: 0, rescued_scoped: 0, rescued_applied_only: 0 },
    cochange: { rescued: 0, rescued_scoped: 0, rescued_applied_only: 0 },
  };
  const dFalse = {
    p5ExtraOnNegatives: 0,
    p5NegativeTasksWithExtra: 0,
    cochangeExtraOnNegatives: 0,
    cochangeNegativeTasksWithExtra: 0,
    p5NonTargetOnPositives: 0,
    cochangeExtraNonTargetOnPositives: 0,
  };
  let unionRescued = 0;
  let unionC2Rescued = 0;
  const matchedPerTask = { p5: [], cochange: [] };
  let predictedFileHitTasks = 0;
  const targetsPerTask = [];
  const taskTermCounts = [];
  const sharedTermCounts = [];

  for (const q of questions) {
    while (si < history.length && history[si].available < q.start) {
      const s = history[si];
      si += 1;
      s.terms ??= termsOf(s.title);
      past.push(s);
      pastById.set(s.id, s);
      for (const term of s.terms) increment(titleDf, term);
      addCochange(cochange, s.files);
      sink.addSession(s);
    }
    while (ri < revisions.length && revisions[ri].time < q.start) {
      const k = { ...revisions[ri].k };
      ri += 1;
      k.appliesNorm = (k.appliesTo ?? []).map(deps.norm).filter(Boolean);
      k.textTerms = termsOf([k.title, k.body, ...(k.tags ?? []), ...(k.references ?? [])].join(" "));
      k.updatedMs = Date.parse(k.updatedAt) || 0;
      known.set(k.id, k);
      sink.upsertKnowledge(k);
    }
    // Feedback is replayed only once both its Session and its Knowledge exist at this moment.
    const stillWaiting = [];
    for (const f of waiting) {
      if (f.time >= q.start || !pastById.has(f.sessionId) || !known.has(f.knowledgeId)) {
        stillWaiting.push(f);
        continue;
      }
      sink.addFeedback(f);
      if (f.kind !== "applied") continue;
      const session = pastById.get(f.sessionId);
      const list = appliers.get(f.knowledgeId) ?? [];
      appliers.set(f.knowledgeId, list);
      list.push(session);
      for (const term of session.terms) {
        const row = lexicon.get(term) ?? new Map();
        lexicon.set(term, row);
        increment(row, f.knowledgeId);
      }
    }
    waiting = stillWaiting;

    if (pastById.has(q.id)) {
      tally.skippedSelfInHistory += 1;
      continue;
    }
    const task = hidePaths(q.title).trim();
    if (!task) {
      tally.noTaskText += 1;
      continue;
    }
    tally.questions += 1;
    const taskTerms = termsOf(task);
    if (taskTerms.size === 0) tally.emptyTaskTerms += 1;
    const active = [...known.values()].filter((k) => k.status === "active" && k.sessionId !== q.id);
    if (active.length === 0) {
      tally.noActiveKnowledge += 1;
      continue;
    }
    tally.withActiveKnowledge += 1;

    const covers = (k) => k.appliesNorm.some((p) => q.files.some((f) => pathMatches(p, f)));
    const scoped = new Set(active.filter(covers).map((k) => k.id));
    const reported = appliedByQuestion.get(q.id) ?? EMPTY;
    const appliedOnly = new Set(active.filter((k) => !scoped.has(k.id) && reported.has(k.id)).map((k) => k.id));
    const targets = union(scoped, appliedOnly);
    const negative = targets.size === 0;
    if (negative) tally.negatives += 1;
    else tally.withTargets += 1;
    if (scoped.size > 0) tally.withScopedTargets += 1;
    targetsPerTask.push(targets.size);
    taskTermCounts.push(taskTerms.size);

    const { found, recent } = sink.taskContext(task, q, active);
    if (negative) negativeShown.product += found.size;

    // Expansion material of this moment, per Knowledge.
    const sourceTermsOf = (k) => (k.sessionId ? (pastById.get(k.sessionId)?.terms ?? EMPTY) : EMPTY);
    const appliedTermsOf = (k) => union(...(appliers.get(k.id) ?? []).map((s) => s.terms));
    const lexiconTermsOf = (k, support) => {
      const terms = new Set();
      for (const term of taskTerms) {
        const generic = (titleDf.get(term) ?? 0) > Math.max(2, GENERIC_TITLE_DF_SHARE * past.length);
        if (!generic && (lexicon.get(term)?.get(k.id) ?? 0) >= support) terms.add(term);
      }
      return terms;
    };
    const docs = (extraOf) =>
      active.map((k) => ({ id: k.id, terms: k.textTerms, extra: extraOf?.(k), updatedAt: k.updatedMs }));
    const base = simulate(taskTerms, docs());
    const expanded = {
      a: simulate(
        taskTerms,
        docs((k) => union(sourceTermsOf(k), appliedTermsOf(k))),
      ),
      ...Object.fromEntries(
        LEXICON_SUPPORTS.map((m) => [
          `c${m}`,
          simulate(
            taskTerms,
            docs((k) => lexiconTermsOf(k, m)),
          ),
        ]),
      ),
    };
    const predicted = predictPaths(taskTerms, past);
    const widened = expandByCochange(predicted, cochange);
    const matching = (files) =>
      new Set(active.filter((k) => k.appliesNorm.some((p) => files.some((f) => pathMatches(p, f)))).map((k) => k.id));
    const matchedP5 = matching(predicted);
    const matchedCochange = matching(widened);
    matchedPerTask.p5.push(matchedP5.size);
    matchedPerTask.cochange.push(matchedCochange.size);
    if (predicted.some((file) => q.files.includes(file))) predictedFileHitTasks += 1;
    if (negative) negativeShown.simulated += base.top.size;

    // False-positive price of each variant: what enters the top slots that the baseline did not show.
    const variants = [["a", a, expanded.a], ...LEXICON_SUPPORTS.map((m) => [`c${m}`, c[m], expanded[`c${m}`]])];
    for (const [, counters, sim] of variants) {
      const extras = [...sim.top].filter((id) => !base.top.has(id));
      if (negative) {
        counters.extraOnNegatives += extras.length;
        counters.extraPerNegativeTask.push(extras.length);
        if (extras.length > 0) counters.negativeTasksWithExtra += 1;
      } else {
        counters.extraNonTargetOnPositives += extras.filter((id) => !targets.has(id)).length;
        for (const id of base.top) if (targets.has(id) && !sim.top.has(id)) counters.displacedTargets += 1;
      }
    }
    const p5Extra = negative ? matchedP5.size : [...matchedP5].filter((id) => !targets.has(id)).length;
    const coExtra = [...matchedCochange].filter((id) => !matchedP5.has(id) && (negative || !targets.has(id))).length;
    if (negative) {
      dFalse.p5ExtraOnNegatives += p5Extra;
      if (p5Extra > 0) dFalse.p5NegativeTasksWithExtra += 1;
      dFalse.cochangeExtraOnNegatives += coExtra;
      if (coExtra > 0) dFalse.cochangeNegativeTasksWithExtra += 1;
    } else {
      dFalse.p5NonTargetOnPositives += p5Extra;
      dFalse.cochangeExtraNonTargetOnPositives += coExtra;
    }

    const tasksPairs = [
      ...[...scoped].map((id) => [id, "scoped"]),
      ...[...appliedOnly].map((id) => [id, "applied_only"]),
    ];
    for (const [id, group] of tasksPairs) {
      const k = known.get(id);
      const status = found.has(id) ? "found" : recent.has(id) ? "recent_only" : "absent";
      const simBase = base.rankOf.get(id) !== undefined && base.rankOf.get(id) <= RELEVANT_LIMIT;
      for (const g of ["all", group]) {
        pairs[g].total += 1;
        pairs[g][status] += 1;
        if (status !== "found") pairs[g].notFound += 1;
      }
      if (status === "found") {
        calibration[simBase ? "found_and_sim_top5" : "found_not_sim_top5"] += 1;
        continue;
      }
      calibration[simBase ? "notfound_but_sim_top5" : "neither"] += 1;
      const sourceTerms = sourceTermsOf(k);
      const appliedTerms = appliedTermsOf(k);
      const cause = classifyMiss({
        hasAppliesTo: k.appliesNorm.length > 0,
        appliesToCovers: group === "scoped",
        taskTerms,
        textTerms: k.textTerms,
        sourceTerms,
        appliedTerms,
      });
      for (const g of ["all", group]) causes[g][cause] += 1;
      if (status === "recent_only") recentCauses[cause] += 1;
      const shared = [...taskTerms].filter((t) => k.textTerms.has(t)).length;
      sharedTermCounts.push(shared);
      if (cause === "no_applies_to" || cause === "applies_to_mismatch") {
        noAppliesToOrMismatchText[shared > 0 ? "text_overlap" : "no_text_overlap"] += 1;
      }
      if (cause === "vocab_gap_expandable") {
        const viaSource = intersects(taskTerms, sourceTerms);
        const viaApplied = intersects(taskTerms, appliedTerms);
        expandableVia[viaSource && viaApplied ? "both" : viaSource ? "source_only" : "applied_only"] += 1;
      }
      if (cause === "ranked_outside_budget") rankBuckets[rankBucket(base.rankOf.get(id))] += 1;

      // Recoverable by each approach? Rescue = not shown today, not in the simulated baseline top slots, in the new top slots.
      const textOverlap = intersects(taskTerms, k.textTerms);
      const rescue = (counters, sim, ceiling) => {
        if (ceiling) counters.ceiling += 1;
        const rank = sim.rankOf.get(id);
        if (!simBase && rank !== undefined && rank <= RELEVANT_LIMIT) {
          counters.rescued += 1;
          counters[`rescued_${group}`] += 1;
          return true;
        }
        return false;
      };
      const rescuedA = rescue(
        a,
        expanded.a,
        !textOverlap && (intersects(taskTerms, sourceTerms) || intersects(taskTerms, appliedTerms)),
      );
      const rescuedC = LEXICON_SUPPORTS.map((m) =>
        rescue(c[m], expanded[`c${m}`], !textOverlap && intersects(taskTerms, lexiconTermsOf(k, m))),
      );
      const rescuedP5 = matchedP5.has(id);
      const rescuedCo = matchedCochange.has(id) && !matchedP5.has(id);
      if (rescuedP5) {
        d.p5.rescued += 1;
        d.p5[`rescued_${group}`] += 1;
      }
      if (rescuedCo) {
        d.cochange.rescued += 1;
        d.cochange[`rescued_${group}`] += 1;
      }
      if (rescuedA || rescuedC.some(Boolean) || rescuedP5 || rescuedCo) unionRescued += 1;
      if (rescuedA || rescuedC[LEXICON_SUPPORTS.length - 1] || rescuedP5 || rescuedCo) unionC2Rescued += 1;
    }
  }

  for (const g of GROUPS) {
    assert.equal(pairs[g].found + pairs[g].recent_only + pairs[g].absent, pairs[g].total);
    assert.equal(
      Object.values(causes[g]).reduce((sum, n) => sum + n, 0),
      pairs[g].notFound,
    );
  }
  assert.equal(pairs.all.total, pairs.scoped.total + pairs.applied_only.total);

  const finish = (counters) => {
    const { extraPerNegativeTask, ...rest } = counters;
    return { ...rest, extraPerNegativeTask: quantiles(extraPerNegativeTask) };
  };
  const groupReport = (g) => ({
    ...pairs[g],
    foundShare: ratio(pairs[g].found, pairs[g].total),
    recentOnlyShare: ratio(pairs[g].recent_only, pairs[g].total),
    absentShare: ratio(pairs[g].absent, pairs[g].total),
    causes: causes[g],
    causeShareOfNotFound: Object.fromEntries(
      CAUSES.map((cause) => [cause, ratio(causes[g][cause], pairs[g].notFound)]),
    ),
  });
  return {
    params: {
      relevantLimit: RELEVANT_LIMIT,
      recentLimit: RECENT_LIMIT,
      minCoverageTenthPercent: MIN_COVERAGE * 1000,
      predictSessions: PREDICT_SESSIONS,
      predictPaths: PREDICT_PATHS,
      cochangeNeighbours: COCHANGE_NEIGHBORS,
      cochangeMaxFiles: COCHANGE_MAX_FILES,
      genericTitleDfPercent: GENERIC_TITLE_DF_SHARE * 100,
    },
    tasks: tally,
    pairs: Object.fromEntries(GROUPS.map((g) => [g, groupReport(g)])),
    recentOnlyCauses: recentCauses,
    vocabGapExpandableVia: expandableVia,
    rankedOutsideBudgetBySimulatedRank: rankBuckets,
    noAppliesToOrMismatchTextOverlap: noAppliesToOrMismatchText,
    estimates: {
      a_documentExpansion: finish(a),
      c_lexicon_support1: finish(c[1]),
      c_lexicon_support2: finish(c[2]),
      d_p5Like: d.p5,
      d_cochangeBeyondP5: d.cochange,
      d_falsePositives: dFalse,
      union_a_c1_d: unionRescued,
      union_a_c2_d: unionC2Rescued,
    },
    calibration: { ...calibration, negativeTasksShown: negativeShown },
    distributions: {
      targetsPerTask: quantiles(targetsPerTask),
      taskTerms: quantiles(taskTermCounts),
      sharedTermsOnMissedPairs: quantiles(sharedTermCounts),
      d_matchedKnowledgePerTask_p5: quantiles(matchedPerTask.p5),
      d_matchedKnowledgePerTask_cochange: quantiles(matchedPerTask.cochange),
      d_predictedFileHitTasks: predictedFileHitTasks,
    },
    notes: NOTES,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Output safety
// ---------------------------------------------------------------------------------------------------------------
const KEY_PATTERN = /^[A-Za-z0-9_<>.-]+$/;

/** Throws unless the report holds only finite numbers, fixed constant notes and plain enumeration keys. */
function assertAggregateOnly(value, path = "report") {
  if (typeof value === "number") {
    assert(Number.isFinite(value), `non-finite number at ${path}`);
  } else if (typeof value === "string") {
    assert(NOTES.includes(value), `unexpected string at ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertAggregateOnly(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert(KEY_PATTERN.test(key), `unexpected key at ${path}`);
      assertAggregateOnly(child, `${path}.${key}`);
    }
  } else {
    assert.fail(`unexpected value type at ${path}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Real run: read-only database -> dataset, product store as the title-only oracle
// ---------------------------------------------------------------------------------------------------------------
function loadRows(dbPath, root) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    db.exec("BEGIN");
    const project = db.prepare("SELECT * FROM projects WHERE lower(root_path)=lower(?) AND status='tracked'").get(root);
    if (!project) return undefined;
    const sessions = db.prepare("SELECT * FROM sessions WHERE project_id=? AND voided_at IS NULL").all(project.id);
    const audits = db
      .prepare(
        "SELECT occurred_at, after_json FROM knowledge_audit WHERE project_id=? ORDER BY julianday(occurred_at), rowid",
      )
      .all(project.id);
    let feedback = [];
    try {
      feedback = db
        .prepare(
          "SELECT knowledge_id, session_id, kind, occurred_at FROM knowledge_feedback WHERE project_id=? AND session_id IS NOT NULL",
        )
        .all(project.id);
    } catch {
      // Older databases have no feedback table.
    }
    return { project, sessions, audits, feedback };
  } finally {
    db.close();
  }
}

function toDataset(rows, norm) {
  const sessions = rows.sessions.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    start: Date.parse(row.started_at),
    available: Math.max(...[row.completed_at, row.created_at, row.updated_at ?? row.created_at].map(Date.parse)),
    files: unique(parseList(row.changed_files_json).map(norm).filter(Boolean)),
    raw: row,
  }));
  const revisions = rows.audits.flatMap((row) => {
    try {
      const k = JSON.parse(row.after_json);
      return [
        {
          time: Date.parse(row.occurred_at),
          k: {
            id: k.id,
            title: k.title ?? "",
            body: k.body ?? "",
            kind: k.kind,
            status: k.status,
            createdAt: k.createdAt,
            updatedAt: k.updatedAt,
            references: k.references ?? [],
            tags: k.tags ?? [],
            appliesTo: k.appliesTo ?? [],
            sessionId: k.sessionId,
          },
        },
      ];
    } catch {
      return [];
    }
  });
  const feedback = rows.feedback.map((row) => ({
    knowledgeId: row.knowledge_id,
    sessionId: row.session_id,
    kind: row.kind,
    time: Date.parse(row.occurred_at),
  }));
  return { sessions, revisions, feedback };
}

async function createProductSink(project) {
  const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
  const store = new WorkIntelligenceStore(":memory:");
  const scratch = store.db;
  const insert = (table, fields) =>
    scratch.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`);
  const projectFields = ["id", "name", "root_path", "status", "created_at", "updated_at"];
  insert("projects", projectFields).run(...projectFields.map((key) => project[key]));
  const sessionFields = [
    "id",
    "project_id",
    "idempotency_key",
    "title",
    "summary",
    "work_summary_json",
    "status",
    "execution_status",
    "completed_at",
    "created_at",
    "started_at",
    "updated_at",
    "changed_files_json",
    "changed_files_confirmed",
    "verification_json",
  ];
  const addSession = insert("sessions", sessionFields);
  const kFields = [
    "title",
    "body",
    "kind",
    "status",
    "created_at",
    "updated_at",
    "references_json",
    "tags_json",
    "applies_to_json",
    "session_id",
  ];
  const addKnowledge = insert("knowledge", ["id", "project_id", "idempotency_key", ...kFields]);
  const updateKnowledge = scratch.prepare(
    `UPDATE knowledge SET ${kFields.map((key) => `${key}=?`).join(",")} WHERE id=?`,
  );
  const addFeedback = scratch.prepare(
    "INSERT OR IGNORE INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at) VALUES (?,?,?,?,?,?)",
  );
  const inStore = new Set();
  const stored = new Set();
  let feedbackCount = 0;
  return {
    addSession(session) {
      addSession.run(...sessionFields.map((key) => session.raw[key]));
      inStore.add(session.id);
    },
    upsertKnowledge(k) {
      const fields = [
        k.title,
        k.body,
        k.kind,
        k.status,
        k.createdAt,
        k.updatedAt,
        JSON.stringify(k.references ?? []),
        JSON.stringify(k.tags ?? []),
        JSON.stringify(k.appliesTo ?? []),
        k.sessionId && inStore.has(k.sessionId) ? k.sessionId : null,
      ];
      if (stored.has(k.id)) updateKnowledge.run(...fields, k.id);
      else addKnowledge.run(k.id, project.id, k.id, ...fields);
      stored.add(k.id);
    },
    addFeedback(f) {
      feedbackCount += 1;
      addFeedback.run(
        `replay-${feedbackCount}`,
        f.knowledgeId,
        project.id,
        f.sessionId,
        f.kind,
        new Date(f.time).toISOString(),
      );
    },
    taskContext(task) {
      const context = store.getContext(project.root_path, { task });
      assert.equal(context.outcome, "context");
      const found = new Set();
      for (const item of context.relevant?.knowledge ?? []) found.add(item.id);
      for (const item of context.relevant?.supplements ?? []) if (item.type === "knowledge") found.add(item.id);
      return { found, recent: new Set((context.recentKnowledge ?? []).map((item) => item.id)) };
    },
    close() {
      store.close();
    },
  };
}

async function realRun(args) {
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? args[rootFlag + 1] : process.cwd();
  const rows = loadRows(positional[0] ?? "data/work-intelligence.sqlite", root);
  assert(rows, "Run from a tracked project root (or pass --root).");
  const { normalizePath, parseQueryWords } = await import("../../packages/storage/dist/search-text.js");
  const { appliesToStrength } = await import("../../packages/storage/dist/applies-to-match.js");
  const context = [{ name: rows.project.name, rootPath: rows.project.root_path }];
  const norm = (path) => normalizePath(path, context);
  // The product query tokenizer (stopwords dropped) for tasks, Session titles and Knowledge text alike.
  const termsOf = (text) =>
    new Set(
      parseQueryWords(text)
        .flatMap((word) => word.terms)
        .filter((term) => !/^\d+$/.test(term)),
    );
  const sink = await createProductSink(rows.project);
  try {
    const report = replay(toDataset(rows, norm), {
      termsOf,
      norm,
      pathMatches: (p, f) => appliesToStrength(p, f) > 0,
      sink,
    });
    assertAggregateOnly(report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    sink.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check: synthetic dataset, pure functions only
// ---------------------------------------------------------------------------------------------------------------
function selfCheck() {
  assert.deepEqual(
    [...localTermsOf("Fix the zqLoginBug 2024")].sort(),
    ["fix", "login", "bug", "zq", "zqloginbug"].sort(),
  );
  assert.equal(hidePaths("Fix src/zq-a.ts crash").includes("zq-a"), false);
  assert.deepEqual(quantiles([]), { n: 0, p50: 0, p90: 0, max: 0 });
  assert.deepEqual(quantiles([1, 2, 3, 4, 10]), { n: 5, p50: 3, p90: 10, max: 10 });
  const base = {
    hasAppliesTo: true,
    appliesToCovers: true,
    taskTerms: new Set(["x"]),
    textTerms: new Set(["y"]),
    sourceTerms: EMPTY,
    appliedTerms: EMPTY,
  };
  assert.equal(classifyMiss({ ...base, hasAppliesTo: false }), "no_applies_to");
  assert.equal(classifyMiss({ ...base, appliesToCovers: false }), "applies_to_mismatch");
  assert.equal(classifyMiss({ ...base, textTerms: new Set(["x"]) }), "ranked_outside_budget");
  assert.equal(classifyMiss({ ...base, sourceTerms: new Set(["x"]) }), "vocab_gap_expandable");
  assert.equal(classifyMiss({ ...base, appliedTerms: new Set(["x"]) }), "vocab_gap_expandable");
  assert.equal(classifyMiss(base), "vocab_gap_unrescuable");
  assert.equal(rankBucket(undefined), "below_coverage_floor");
  assert.equal(rankBucket(5), "1-5");
  assert.equal(rankBucket(6), "6-12");
  assert.equal(rankBucket(13), "13-30");
  assert.equal(rankBucket(31), ">30");

  // Synthetic data: every string carries a "zq" marker so a leak into the output is detectable.
  const T = (n) => 1_000_000 + n * 1_000;
  const iso = (ms) => new Date(ms).toISOString();
  const session = (id, title, files, start) => ({ id, title, files, start, available: start + 50, raw: {} });
  const know = (id, text, appliesTo, sessionId) => ({
    id,
    title: text,
    body: "",
    kind: "pattern",
    status: "active",
    createdAt: iso(T(200)),
    updatedAt: iso(T(200)),
    references: [],
    tags: [],
    appliesTo,
    sessionId,
  });
  const sessions = [
    session("zq-src1", "zqflicker zqglitch zqpanel", ["src/zq-p1.ts"], T(100)),
    session("zq-h1", "zqpagination zqbug", ["src/zq-p.ts"], T(110)),
    session("zq-h2", "zqunrelated zqmaint", ["src/zq-p.ts", "src/zq-d2.ts"], T(120)),
    session("zq-r1", "zqrouting zqbehavior", ["src/zq-r.ts"], T(125)),
    session("zq-a1", "zqstale zqrender", ["src/zq-h1.ts"], T(130)),
    session("zq-a2", "zqstale zqflash", ["src/zq-h2.ts"], T(135)),
    session("zq-a3", "zqjitter zqscroll", ["src/zq-h3.ts"], T(140)),
    session("zq-q12", "zqfound zqtopic", ["src/zq-g.ts"], T(1_000)),
    session("zq-q1", "zqflicker zqglitch zqagain", ["src/zq-a.ts"], T(2_000)),
    session("zq-q2", "zqgizmo zqwobble", ["src/zq-b.ts"], T(3_000)),
    session("zq-q3", "zqnothing zqshared", ["src/zq-q3.ts"], T(4_000)),
    session("zq-q4", "zqplain zqwords", ["src/zq-q4.ts"], T(5_000)),
    session("zq-q5", "zqlogin zqredirect zqloop", ["src/zq-c.ts"], T(6_000)),
    session("zq-q6", "zqflicker zqglitch zqpanel", ["src/zq-z.ts"], T(7_000)),
    session("zq-q7", "zqpagination zqissue", ["src/zq-d2.ts"], T(8_000)),
    session("zq-q8", "zqstale zqglare zqrender", ["src/zq-e.ts"], T(9_000)),
    session("zq-q9", "zqjitter zqwiggle", ["src/zq-f.ts"], T(10_000)),
    session("zq-q10", "zqrouting zqproblem", ["src/zq-r.ts"], T(11_000)),
  ];
  const knowledge = [
    know("zq-k1", "zqquartz zqwidget", ["src/zq-a.ts"], "zq-src1"),
    know("zq-k2", "zqhydration zqmismatch", ["src/zq-b.ts"]),
    know("zq-k3", "zqcachekey zqinvalidate", []),
    know("zq-k4", "zqthrottle zqqueue", ["src/zq-other.ts"]),
    know("zq-k5", "zqlogin", ["src/zq-c.ts"]),
    ...[6, 7, 8, 9, 10, 11].map((n) => know(`zq-k${n}`, "zqlogin zqredirect zqloop zqcookie", ["src/zq-noise.ts"])),
    know("zq-k12", "zqfound zqtopic", ["src/zq-g.ts"]),
    know("zq-k13", "zqmodal zqfocus", ["src/zq-d2.ts"]),
    know("zq-k15", "zqcache zqinvalidate2", ["src/zq-e.ts"]),
    know("zq-k16", "zqlayout zqshift", ["src/zq-f.ts"]),
    know("zq-k17", "zqrouter zqguard", ["src/zq-r.ts"]),
  ];
  const feedback = [
    { knowledgeId: "zq-k15", sessionId: "zq-a1", kind: "applied", time: T(140) },
    { knowledgeId: "zq-k15", sessionId: "zq-a2", kind: "applied", time: T(145) },
    { knowledgeId: "zq-k16", sessionId: "zq-a3", kind: "applied", time: T(148) },
    { knowledgeId: "zq-k3", sessionId: "zq-q3", kind: "applied", time: T(4_030) },
    { knowledgeId: "zq-k4", sessionId: "zq-q4", kind: "applied", time: T(5_030) },
  ];
  const data = {
    sessions,
    revisions: knowledge.map((k) => ({ time: T(200), k })),
    feedback,
  };
  // The title-only oracle is scripted: K12 is found, K5 appears only in the fixed recent list, the rest are absent.
  const scripted = new Map([
    ["zq-q12", { found: new Set(["zq-k12"]), recent: new Set() }],
    ["zq-q5", { found: new Set(), recent: new Set(["zq-k5"]) }],
  ]);
  const writes = { sessions: 0, knowledge: 0, feedback: 0 };
  const sink = {
    addSession: () => (writes.sessions += 1),
    upsertKnowledge: () => (writes.knowledge += 1),
    addFeedback: () => (writes.feedback += 1),
    taskContext: (_task, question) => scripted.get(question.id) ?? { found: new Set(), recent: new Set() },
  };
  const deps = { termsOf: localTermsOf, norm: localNormalize, pathMatches: localPathMatches, sink };
  const report = replay(cloneData(data), deps);
  assertAggregateOnly(report);

  assert.equal(report.tasks.questions, 18);
  assert.equal(report.tasks.noActiveKnowledge, 7);
  assert.equal(report.tasks.withActiveKnowledge, 11);
  assert.equal(report.tasks.withTargets, 10);
  assert.equal(report.tasks.negatives, 1);
  assert.equal(report.tasks.skippedSelfInHistory, 0);
  assert.equal(report.pairs.scoped.total, 8);
  assert.equal(report.pairs.applied_only.total, 2);
  assert.equal(report.pairs.all.total, 10);
  assert.equal(report.pairs.all.found, 1);
  assert.equal(report.pairs.all.recent_only, 1);
  assert.equal(report.pairs.all.absent, 8);
  assert.deepEqual(report.pairs.all.causes, {
    no_applies_to: 1,
    applies_to_mismatch: 1,
    vocab_gap_expandable: 3,
    vocab_gap_unrescuable: 3,
    ranked_outside_budget: 1,
  });
  assert.deepEqual(report.pairs.applied_only.causes.no_applies_to, 1);
  assert.deepEqual(report.vocabGapExpandableVia, { source_only: 1, applied_only: 2, both: 0 });
  assert.equal(report.rankedOutsideBudgetBySimulatedRank["6-12"], 1);
  assert.equal(report.recentOnlyCauses.ranked_outside_budget, 1);
  assert.equal(report.estimates.a_documentExpansion.ceiling, 3);
  assert.equal(report.estimates.a_documentExpansion.rescued, 3);
  assert.equal(report.estimates.a_documentExpansion.extraOnNegatives, 1);
  assert.equal(report.estimates.a_documentExpansion.negativeTasksWithExtra, 1);
  assert.equal(report.estimates.c_lexicon_support1.rescued, 2);
  assert.equal(report.estimates.c_lexicon_support2.rescued, 1);
  assert.equal(report.estimates.c_lexicon_support1.extraOnNegatives, 0);
  assert.equal(report.estimates.d_p5Like.rescued, 1);
  assert.equal(report.estimates.d_cochangeBeyondP5.rescued, 1);
  assert.equal(report.estimates.d_falsePositives.p5ExtraOnNegatives, 1);
  assert.equal(report.estimates.union_a_c1_d, 5);
  assert.equal(writes.sessions, sessions.length - 1);
  assert(writes.knowledge >= knowledge.length && writes.feedback >= 3);

  // No title, id, path or record word of the dataset may appear in the printed report.
  const printed = JSON.stringify(report).toLowerCase();
  const words = new Set();
  for (const s of sessions)
    for (const part of [s.id, s.title, ...s.files]) for (const w of part.split(/[\s/]+/)) words.add(w);
  for (const k of knowledge)
    for (const part of [k.id, k.title, ...k.appliesTo]) for (const w of part.split(/[\s/]+/)) words.add(w);
  for (const word of words) assert(!printed.includes(word.toLowerCase()), "a dataset string leaked into the report");
  assert(!printed.includes("zq"), "synthetic marker leaked into the report");
  // The guard itself rejects strings, ids as keys and non-finite numbers.
  assert.throws(() => assertAggregateOnly({ a: "zq-q1" }));
  assert.throws(() => assertAggregateOnly({ "zq q1": 1 }));
  assert.throws(() => assertAggregateOnly({ a: Number.NaN }));
  // Time-ordered replay: dropping every history Session before the questions removes expansion and co-change gains.
  const noHistory = replay(
    cloneData({
      ...data,
      sessions: sessions.filter((s) => s.id.startsWith("zq-q")),
      feedback: feedback.filter((f) => f.sessionId.startsWith("zq-q")),
    }),
    deps,
  );
  assert.equal(noHistory.estimates.a_documentExpansion.rescued, 0);
  assert.equal(noHistory.estimates.d_cochangeBeyondP5.rescued, 0);
  console.log("self-check passed");
}

const args = process.argv.slice(2);
if (args.includes("--self-check")) selfCheck();
else await realRun(args);
