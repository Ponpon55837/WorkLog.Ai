// Task-only context path replay (read-only research tool, not a product feature).
//
// Question: for a task given without paths, can the Knowledge scoped by appliesTo to the files the task will touch be
// reached anyway, and what does each way of reaching it cost? Variants are replayed per historical Session in time order
// against an in-memory copy of the project's history as it was when the Session started.
//
// Usage:
//   pnpm build
//   node docs/experiments/task-path-replay.mjs --db <path to a database> --project <project id or root path>
//   node docs/experiments/task-path-replay.mjs --self-check     (also the default without --db)
//
// Definitions
//   Question = a non-voided Session with a start time and changed files; task = its title with file-like tokens removed.
//   Target = active Knowledge with appliesTo covering a changed file of the Session (the product's appliesToStrength > 0),
//   known before the Session started, not sourced from it. Pair = (question, target).
//   Hit ("full") = a Knowledge id whose title or excerpt appears outside `omitted` in the getContext response, wherever
//   it sits (relevant.knowledge, relevant.supplements pointers, recentKnowledge). Path entries inside `omitted` are
//   not hits; they are reported separately.
//   Original variants (reproduce the upstream numbers; the inference gate is forced off so they equal the pre-feature
//   product): task = {task}; frequent = the project's three most changed files; predicted = the top files of the five
//   Sessions with the most similar titles; actual = the real changed files (an upper bound).
//   Prototype variants (under `prototype`): productOff = {task} with the gate off (must equal `task`); product = {task}
//   with the gate as shipped; productAlways = gate always on; merged = the task response plus Knowledge newly found by
//   the `predicted` query, appended as {id,title} pointers while the JSON stays within the 9,800 character task budget
//   (simulated). gained / lost compare with the task response; stats satisfy full = task.full + gained - lost.
//   The gate is reached as `store.contextRecallService.shouldInferTaskPaths` (private field, instance method).
//
//   Knob variants (report.metrics, not under `prototype`): the gate is forced on and the recall service's instance field
//   `inferredPathOptions` (mode, pathLimit, pointerLimit, yieldRecent, promoteRecent, allowRecentOmitted) is overridden:
//   off (gate off), paths3 (the first prototype: no yield, promote or omitted), paths3Yield, paths5Yield, paths8Yield,
//   weighted3Yield, weighted5Yield (pointerLimit 5), bestAllKnobs (weighted, yield, promote, allowRecentOmitted).
//   report.metrics.<variant> holds, for every variant, both definitions: loose (the Hit definition above) and strict (a
//   target id with a title or excerpt inside relevant.knowledge or relevant.supplements only, so recentKnowledge and
//   anything else do not count), gained / lost against the task baseline for both, chars (sum, max), onNegative noise,
//   recentDisplaced (recentKnowledge items of the task baseline that the variant removed, split target / other), and
//   gained by first-round confidence and by the time / size slices. report.diagnostics explains each target pair the
//   knob variants did not strictly hit (notInferred, alreadyRecent, excludedOmitted, cutByCap, cutByBudget, firstRound),
//   recomputed from what the product's private inference methods returned during the call (wrapped at runtime) and the
//   response itself; the cut classes are approximate where the response lists omitted ids only up to a limit.
//   report.knowledgeRecallOnly counts strict targets among Knowledge-only recall hits for the task (limits 5 and 8): would
//   relevant.knowledge find more if Sessions did not crowd the mixed recall page.
//
// Safety: --db is opened read-only; replay writes go to an in-memory store. Output is aggregate JSON only, never
// titles, paths, ids or project names.
//
// Limits: one project; titles stand in for tasks; merged is a size simulation, not product behaviour; Knowledge is
// rebuilt from knowledge_audit snapshots, so history lost from the audit is missing.
import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
const { normalizePath, parseQueryWords } = await import("../../packages/storage/dist/search-text.js");
const { appliesToStrength } = await import("../../packages/storage/dist/applies-to-match.js");

const TASK_BUDGET_CHARS = 9_800;
const MERGED_FIELD_OVERHEAD = '"mergedPointers":[]'.length;
const ORIGINAL_VARIANTS = ["task", "frequent", "predicted", "actual"];
const PROTOTYPE_VARIANTS = ["merged", "productOff", "product", "productAlways"];
const BASELINE_METRICS = ["task", "frequent", "predicted", "actual"];
const KNOB_VARIANTS = {
  off: null,
  paths3: { mode: "paths", pathLimit: 3, pointerLimit: 3, yieldRecent: false, promoteRecent: false, allowRecentOmitted: false },
  paths3Yield: { mode: "paths", pathLimit: 3, pointerLimit: 3, yieldRecent: true, promoteRecent: false, allowRecentOmitted: false },
  paths5Yield: { mode: "paths", pathLimit: 5, pointerLimit: 3, yieldRecent: true, promoteRecent: false, allowRecentOmitted: false },
  paths8Yield: { mode: "paths", pathLimit: 8, pointerLimit: 3, yieldRecent: true, promoteRecent: false, allowRecentOmitted: false },
  weighted3Yield: { mode: "weighted", pathLimit: 3, pointerLimit: 3, yieldRecent: true, promoteRecent: false, allowRecentOmitted: false },
  weighted5Yield: { mode: "weighted", pathLimit: 3, pointerLimit: 5, yieldRecent: true, promoteRecent: false, allowRecentOmitted: false },
  bestAllKnobs: { mode: "weighted", pathLimit: 3, pointerLimit: 3, yieldRecent: true, promoteRecent: true, allowRecentOmitted: true },
};
const PRODUCT_METRICS = ["product", "productAlways", ...Object.keys(KNOB_VARIANTS).filter((key) => key !== "off")];
const CONFIDENCES = ["none", "low", "high"];
const SLICE_TAGS = ["latestQuarter", "earlier", "smallChange", "broadChange"];
const LOCATIONS = ["relevantKnowledge", "supplements", "recentKnowledge", "elsewhere"];

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const unique = (xs) => [...new Set(xs)];

function increment(map, key, value = 1) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topPaths(scores) {
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([path]) => path);
}

// Remove explicit file/path tokens without consulting the answer files; preserve ordinary symptom and component words.
const hidePaths = (text) =>
  text.replace(
    /(?:[A-Za-z]:)?(?:[\w@.~-]+[/\\])+[\w@./\\~-]+|[\w@-]+(?:\.[\w-]+)*\.(?:[cm]?[jt]sx?|vue|json|md|sql|ya?ml|toml|css|html|py|sh|ps1|sqlite)\b/giu,
    " ",
  );

const termsOf = (text) =>
  new Set(parseQueryWords(text).flatMap((word) => word.terms).filter((t) => !/^\d+$/.test(t)));

function predict(task, past) {
  const query = termsOf(task);
  const df = new Map();
  const frequency = new Map();
  for (const s of past) {
    for (const term of s.terms) increment(df, term);
    for (const file of s.files) increment(frequency, file);
  }
  const related = [];
  for (const s of past) {
    if (!s.files.length) continue;
    let weight = 0;
    for (const term of query) {
      if (s.terms.has(term)) weight += Math.log((past.length + 1) / (df.get(term) + 0.5));
    }
    if (weight > 0) related.push({ s, score: weight / Math.sqrt(Math.max(1, s.terms.size)) });
  }
  related.sort((a, b) => b.score - a.score || b.s.available - a.s.available);
  const scores = new Map();
  for (const { s, score } of related.slice(0, 5)) {
    for (const file of s.files) increment(scores, file, score / Math.sqrt(s.files.length));
  }
  return { predicted: topPaths(scores), frequent: topPaths(frequency) };
}

function fullIds(context, known) {
  assert.equal(context.outcome, "context");
  const ids = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (known.has(value.id) && (value.title !== undefined || value.excerpt !== undefined)) ids.add(value.id);
    for (const [key, child] of Object.entries(value)) if (key !== "omitted") walk(child);
  }
  walk(context);
  return ids;
}

/** Knowledge ids that keep a title and path inside `omitted`: pointers, not hits. */
function omittedPathEntryIds(context) {
  return new Set(
    (context.omitted ?? [])
      .filter((omission) => omission.section === "relevant.knowledge")
      .flatMap((omission) => omission.entries ?? [])
      .filter((entry) => entry.title !== undefined && entry.path !== undefined)
      .map((entry) => entry.id),
  );
}

/** Knowledge ids with a title or excerpt inside relevant.knowledge or relevant.supplements only (no recentKnowledge). */
function strictIds(context, known) {
  const ids = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (known.has(value.id) && (value.title !== undefined || value.excerpt !== undefined)) ids.add(value.id);
    for (const child of Object.values(value)) walk(child);
  }
  walk(context.relevant?.knowledge);
  walk(context.relevant?.supplements);
  return ids;
}

function newGainCell() {
  return { tasks: 0, pairs: 0, looseGained: 0, strictGained: 0 };
}

function newMetric() {
  return {
    responses: 0,
    loose: { full: 0, gained: 0, lost: 0 },
    strict: { full: 0, gained: 0, lost: 0 },
    chars: { sum: 0, max: 0, average: 0 },
    onNegative: { looseItems: 0, strictItems: 0, strictItemsAddedVsTask: 0, strictInferredPointers: 0 },
    recentDisplaced: { target: 0, other: 0 },
    gainedBy: {
      confidence: Object.fromEntries(CONFIDENCES.map((key) => [key, newGainCell()])),
      slices: Object.fromEntries(SLICE_TAGS.map((key) => [key, newGainCell()])),
    },
  };
}

function newDiagnostic() {
  return { pairs: 0, strictHits: 0, notInferred: 0, alreadyRecent: 0, excludedOmitted: 0, cutByCap: 0, cutByBudget: 0, firstRound: 0 };
}

/** Ids the response keeps in an omission, listed by id or by flagged / path entry (the rest is only counted). */
function omissionListedIds(context) {
  const ids = new Set();
  for (const omission of context.omitted ?? []) {
    for (const id of omission.ids ?? []) ids.add(id);
    for (const entry of omission.entries ?? []) ids.add(entry.id);
  }
  return ids;
}

/**
 * Why a target pair was not strictly hit. `capture` holds what the product's private inference methods returned for this
 * call: the ranked matches (raw), the candidates after first-round / trust filtering, and the first-round ids.
 */
function classifyMiss(id, context, capture, options) {
  if (capture.firstRoundIds.has(id)) return "firstRound";
  if (!capture.raw.has(id)) return "notInferred";
  const index = capture.candidates.findIndex((candidate) => candidate.id === id);
  if (index < 0) return "notInferred";
  const recent = new Set((context.recentKnowledge ?? []).map((item) => item.id));
  const listed = omissionListedIds(context);
  if (recent.has(id) && !options.promoteRecent) return "alreadyRecent";
  if (listed.has(id) && !options.allowRecentOmitted) return "excludedOmitted";
  const eligible = capture.candidates.filter(
    (candidate) => !(recent.has(candidate.id) && !options.promoteRecent) && !(listed.has(candidate.id) && !options.allowRecentOmitted),
  );
  return eligible.findIndex((candidate) => candidate.id === id) >= options.pointerLimit ? "cutByCap" : "cutByBudget";
}

function newLocationTally() {
  const cell = () => ({ target: 0, other: 0 });
  return {
    ...Object.fromEntries(LOCATIONS.map((key) => [key, cell()])),
    supplementsByKind: {},
    omittedPathEntries: cell(),
  };
}

/** Each hit counts once, at its first place: relevant.knowledge, then supplements, then recentKnowledge. */
function tallyLocations(tally, context, ids, targets) {
  const relevant = new Set((context.relevant?.knowledge ?? []).map((item) => item.id));
  const supplements = new Map(
    (context.relevant?.supplements ?? []).filter((item) => item.type === "knowledge").map((item) => [item.id, item.includedBecause.kind]),
  );
  const recent = new Set((context.recentKnowledge ?? []).map((item) => item.id));
  for (const id of ids) {
    const side = targets.has(id) ? "target" : "other";
    if (relevant.has(id)) tally.relevantKnowledge[side]++;
    else if (supplements.has(id)) {
      tally.supplements[side]++;
      const kind = supplements.get(id);
      tally.supplementsByKind[kind] ??= { target: 0, other: 0 };
      tally.supplementsByKind[kind][side]++;
    } else if (recent.has(id)) tally.recentKnowledge[side]++;
    else tally.elsewhere[side]++;
  }
  for (const id of omittedPathEntryIds(context)) tally.omittedPathEntries[targets.has(id) ? "target" : "other"]++;
}

function newSlice() {
  return { tasks: 0, fileHits: 0, pairs: 0, full: 0, gained: 0, lost: 0, addedOutsideTarget: 0, removedOutsideTarget: 0 };
}

function newStat(extra = {}) {
  return { hits: 0, guesses: 0, correct: 0, contexts: 0, full: 0, other: 0, gained: 0, lost: 0, onNegative: 0, chars: 0, ...extra };
}

function newPrototypeStat() {
  return {
    ...newStat(),
    responses: 0,
    gateFired: 0,
    inferredOnNegative: 0,
    locations: newLocationTally(),
  };
}

function newSignalBuckets() {
  const bucket = () => ({ tasks: 0, pairs: 0, gained: 0 });
  return {
    knowledgeHits: { "<5": bucket(), "=5": bucket() },
    confidence: { none: bucket(), low: bucket(), high: bucket() },
    firstRoundHasTarget: { yes: bucket(), no: bucket() },
  };
}

/** Replays every question against the history before it; returns the aggregate report. */
function replay(project, sessions, audits) {
  const pathContext = [{ name: project.name, rootPath: project.root_path }];
  const norm = (path) => normalizePath(path, pathContext);
  for (const row of sessions) {
    row.start = Date.parse(row.started_at);
    row.available = Math.max(...[row.completed_at, row.created_at, row.updated_at ?? row.created_at].map(Date.parse));
    row.files = unique(JSON.parse(row.changed_files_json).map(norm).filter(Boolean));
    row.terms = termsOf(row.title);
  }
  const history = sessions.filter((s) => Number.isFinite(s.available)).sort((a, b) => a.available - b.available);
  const questions = sessions.filter((s) => Number.isFinite(s.start) && s.files.length).sort((a, b) => a.start - b.start);
  const revisions = audits.map((row) => ({ time: Date.parse(row.occurred_at), k: JSON.parse(row.after_json) }));

  const store = new WorkIntelligenceStore(":memory:");
  // The gate is an instance method of the recall service; the experiment overrides it per call and restores it.
  const service = store.contextRecallService;
  const shippedGate = Object.getPrototypeOf(service).shouldInferTaskPaths;
  let gateFired = 0;
  const gates = {
    off: () => false,
    shipped: (...args) => {
      const open = shippedGate.apply(service, args);
      if (open) gateFired++;
      return open;
    },
    always: () => {
      gateFired++;
      return true;
    },
  };
  const search = service.searchIndex;
  const servicePrototype = Object.getPrototypeOf(service);
  const searchPrototype = Object.getPrototypeOf(search);
  const defaultOptions = { ...service.inferredPathOptions };
  // Runs getContext with the gate and optional inferredPathOptions overrides (private instance field of the service),
  // and records what the product's private inference methods returned, for the miss diagnostics.
  const contextWith = (gate, focus, options, capture) => {
    service.shouldInferTaskPaths = gate;
    // A class field is an own property of the instance, so it is restored, not deleted.
    const previousOptions = service.inferredPathOptions;
    if (options) service.inferredPathOptions = { ...defaultOptions, ...options };
    if (capture) {
      capture.raw = new Set();
      capture.candidates = [];
      capture.firstRoundIds = new Set();
      service.inferredKnowledge = (...args) => {
        for (const id of args[2]) capture.firstRoundIds.add(id);
        const result = servicePrototype.inferredKnowledge.apply(service, args);
        capture.candidates = result;
        return result;
      };
      for (const name of ["knowledgeForPaths", "knowledgeForWeightedPaths"]) {
        search[name] = (...args) => {
          const result = searchPrototype[name].apply(search, args);
          for (const item of result) capture.raw.add(item.id);
          return result;
        };
      }
    }
    try {
      return store.getContext(project.root_path, focus);
    } finally {
      delete service.shouldInferTaskPaths;
      service.inferredPathOptions = previousOptions;
      delete service.inferredKnowledge;
      delete search.knowledgeForPaths;
      delete search.knowledgeForWeightedPaths;
    }
  };

  // Use the store's SQLite connection only for reconstructing selected historical rows in this research fixture.
  // Product getContext and the product path matcher below run unmodified.
  const scratch = store.db;
  const insertSQL = (table, fields) =>
    scratch.prepare("INSERT INTO " + table + " (" + fields.join(",") + ") VALUES (" + fields.map(() => "?").join(",") + ")");
  const projectFields = ["id", "name", "root_path", "status", "created_at", "updated_at"];
  insertSQL("projects", projectFields).run(...projectFields.map((key) => project[key]));
  const sessionFields = ["id","project_id","idempotency_key","title","summary","work_summary_json","status","execution_status","completed_at","created_at","started_at","updated_at","changed_files_json","changed_files_confirmed","verification_json"];
  const addSession = insertSQL("sessions", sessionFields);
  const kFields = ["id","project_id","idempotency_key","title","body","kind","status","created_at","updated_at","references_json","tags_json","applies_to_json"];
  const addKnowledge = insertSQL("knowledge", kFields);
  const updateKnowledge = scratch.prepare("UPDATE knowledge SET " + kFields.slice(3).map((key) => key + "=?").join(",") + " WHERE id=?");
  const known = new Map();
  const past = [];
  let si = 0;
  let ki = 0;
  const tally = { all: sessions.length, questions: 0, masked: 0, withScopedKnowledge: 0, positives: 0, pairs: 0 };
  const groups = {};
  const stats = Object.fromEntries(ORIGINAL_VARIANTS.map((key) => [key, newStat()]));
  const prototypeStats = Object.fromEntries(PROTOTYPE_VARIANTS.map((key) => [key, newPrototypeStat()]));
  const prototypeGroups = {};
  const mergedDetail = { keptOld: 0, added: 0, addedTargets: 0, cutByBudget: 0, cutTargets: 0, oldNotKept: 0 };
  const signals = { product: newSignalBuckets(), productAlways: newSignalBuckets() };
  const metrics = Object.fromEntries(
    [...BASELINE_METRICS, "merged", ...Object.keys(KNOB_VARIANTS), "product", "productAlways"].filter((key, index, all) => all.indexOf(key) === index).map((key) => [key, newMetric()]),
  );
  const diagnostics = Object.fromEntries(PRODUCT_METRICS.map((key) => [key, newDiagnostic()]));
  const recallOnly = { positives: 0, baselineStrictPairs: 0, ...Object.fromEntries([5, 8].map((limit) => [`limit${limit}`, { pairs: 0, newVsBaselineStrict: 0, nonTargetHits: 0, tasksWithNewPair: 0 }])) };

  for (const [index, q] of questions.entries()) {
    while (si < history.length && history[si].available < q.start) {
      const s = history[si++];
      addSession.run(...sessionFields.map((key) => s[key]));
      past.push(s);
    }
    assert(!past.includes(q));
    while (ki < revisions.length && revisions[ki].time < q.start) {
      const { k } = revisions[ki++];
      const fields = [k.title, k.body, k.kind, k.status, k.createdAt, k.updatedAt,
        JSON.stringify(k.references ?? []), JSON.stringify(k.tags ?? []), JSON.stringify(k.appliesTo ?? [])];
      if (known.has(k.id)) updateKnowledge.run(...fields, k.id);
      else addKnowledge.run(k.id, project.id, k.id, ...fields);
      known.set(k.id, k);
    }
    const task = hidePaths(q.title).trim();
    if (!task) continue;
    tally.questions++;
    if (task !== q.title.trim()) tally.masked++;
    const { predicted, frequent } = predict(task, past);
    const paths = { task: [], frequent, predicted, actual: q.files.slice(0, 20) };
    const tags = [
      index >= Math.floor(questions.length * 0.75) ? "latestQuarter" : "earlier",
      q.files.length <= 5 ? "smallChange" : "broadChange",
    ];
    const active = [...known.values()].filter((k) => k.status === "active" && k.sessionId !== q.id && k.appliesTo?.length);
    const targets = new Set(active.filter((k) => k.appliesTo.some((p) => q.files.some((f) => appliesToStrength(norm(p), f) > 0))).map((k) => k.id));
    if (active.length) tally.withScopedKnowledge++;
    if (targets.size) tally.positives++;
    tally.pairs += targets.size;
    let baseline;
    let baselineContext;
    let baselineStrict;
    let predictedIds;
    const confidenceOf = () => baselineContext.relevant?.confidence ?? "none";
    // Both definitions for one response, against the task baseline (loose = fullIds, strict = relevant.* only).
    const measure = (name, context, looseIds, strictSet, extraChars = 0) => {
      const m = metrics[name];
      const looseGained = [...targets].filter((id) => looseIds.has(id) && !baseline.has(id)).length;
      const strictGained = [...targets].filter((id) => strictSet.has(id) && !baselineStrict.has(id)).length;
      m.responses++;
      m.loose.full += [...targets].filter((id) => looseIds.has(id)).length;
      m.loose.gained += looseGained;
      m.loose.lost += [...targets].filter((id) => !looseIds.has(id) && baseline.has(id)).length;
      m.strict.full += [...targets].filter((id) => strictSet.has(id)).length;
      m.strict.gained += strictGained;
      m.strict.lost += [...targets].filter((id) => !strictSet.has(id) && baselineStrict.has(id)).length;
      const length = JSON.stringify(context).length + extraChars;
      m.chars.sum += length;
      m.chars.max = Math.max(m.chars.max, length);
      if (!targets.size) {
        m.onNegative.looseItems += looseIds.size;
        m.onNegative.strictItems += strictSet.size;
        m.onNegative.strictItemsAddedVsTask += [...strictSet].filter((id) => !baselineStrict.has(id)).length;
        m.onNegative.strictInferredPointers += (context.relevant?.supplements ?? []).filter((item) => item.includedBecause?.kind === "inferred_path").length;
      }
      const recent = new Set((context.recentKnowledge ?? []).map((item) => item.id));
      for (const item of baselineContext.recentKnowledge ?? []) {
        if (!recent.has(item.id)) m.recentDisplaced[targets.has(item.id) ? "target" : "other"]++;
      }
      for (const cell of [m.gainedBy.confidence[confidenceOf()], ...tags.map((tag) => m.gainedBy.slices[tag])]) {
        cell.tasks++;
        cell.pairs += targets.size;
        cell.looseGained += looseGained;
        cell.strictGained += strictGained;
      }
    };
    for (const [key, candidates] of Object.entries(paths)) {
      const a = stats[key];
      const correct = candidates.filter((file) => q.files.includes(file)).length;
      const slices = tags.map((tag) => {
        const group = (groups[tag] ??= {});
        return (group[key] ??= newSlice());
      });
      for (const slice of slices) {
        slice.tasks++;
        slice.fileHits += Number(correct > 0);
        slice.pairs += targets.size;
      }
      a.guesses += candidates.length;
      a.correct += correct;
      if (correct) a.hits++;
      if (!active.length) continue;
      const context = contextWith(gates.off, candidates.length ? { task, paths: candidates } : { task });
      const ids = fullIds(context, known);
      if (key === "task") {
        baseline = ids;
        baselineContext = context;
        baselineStrict = strictIds(context, known);
      }
      if (key === "predicted") {
        predictedIds = ids;
      }
      for (const slice of slices) {
        for (const id of ids) {
          if (targets.has(id)) {
            slice.full++;
            if (!baseline.has(id)) slice.gained++;
          } else if (!baseline.has(id)) slice.addedOutsideTarget++;
        }
        for (const id of baseline) {
          if (ids.has(id)) continue;
          if (targets.has(id)) slice.lost++;
          else slice.removedOutsideTarget++;
        }
      }
      a.chars += JSON.stringify(context).length;
      if (!targets.size) a.onNegative += ids.size;
      if ([...ids].some((id) => targets.has(id))) a.contexts++;
      for (const id of ids) {
        if (targets.has(id)) a.full++;
        else a.other++;
      }
      for (const id of targets) {
        if (ids.has(id) && !baseline.has(id)) a.gained++;
        if (!ids.has(id) && baseline.has(id)) a.lost++;
      }
      measure(key, context, ids, strictIds(context, known));
    }

    // Prototype variants, compared with the task baseline above.
    const prototypeSlices = (key) =>
      tags.map((tag) => {
        const group = (prototypeGroups[tag] ??= {});
        return (group[key] ??= newSlice());
      });
    const record = (key, context, ids, extraChars = 0) => {
      const a = prototypeStats[key];
      for (const slice of prototypeSlices(key)) {
        for (const id of ids) {
          if (targets.has(id)) {
            slice.full++;
            if (!baseline.has(id)) slice.gained++;
          } else if (!baseline.has(id)) slice.addedOutsideTarget++;
        }
        for (const id of baseline) {
          if (ids.has(id)) continue;
          if (targets.has(id)) slice.lost++;
          else slice.removedOutsideTarget++;
        }
      }
      a.responses++;
      a.chars += JSON.stringify(context).length + extraChars;
      if (!targets.size) a.onNegative += ids.size;
      if ([...ids].some((id) => targets.has(id))) a.contexts++;
      for (const id of ids) {
        if (targets.has(id)) a.full++;
        else a.other++;
      }
      for (const id of targets) {
        if (ids.has(id) && !baseline.has(id)) a.gained++;
        if (!ids.has(id) && baseline.has(id)) a.lost++;
      }
      tallyLocations(a.locations, context, ids, targets);
      return a;
    };
    for (const key of PROTOTYPE_VARIANTS) {
      for (const slice of prototypeSlices(key)) {
        slice.tasks++;
        slice.pairs += targets.size;
      }
    }
    if (!active.length) continue;

    const diagnose = (name, context, strictSet, capture, options) => {
      const d = diagnostics[name];
      for (const id of targets) {
        d.pairs++;
        if (strictSet.has(id)) {
          d.strictHits++;
          continue;
        }
        d[classifyMiss(id, context, capture, options)]++;
      }
    };
    // Knowledge-only recall: would relevant.knowledge find more if Sessions did not crowd the mixed recall page?
    if (targets.size) {
      recallOnly.positives++;
      recallOnly.baselineStrictPairs += [...targets].filter((id) => baselineStrict.has(id)).length;
    }
    for (const limit of [5, 8]) {
      const hits = search.recall({ q: task, projectId: project.id, types: ["knowledge"], limit }).hits.map((hit) => hit.id);
      const cell = recallOnly[`limit${limit}`];
      const found = hits.filter((id) => targets.has(id));
      const fresh = found.filter((id) => !baselineStrict.has(id));
      cell.pairs += found.length;
      cell.newVsBaselineStrict += fresh.length;
      cell.nonTargetHits += hits.length - found.length;
      if (fresh.length) cell.tasksWithNewPair++;
    }
    for (const [key, options] of Object.entries(KNOB_VARIANTS)) {
      const capture = {};
      const context = options ? contextWith(gates.always, { task }, options, capture) : contextWith(gates.off, { task });
      const ids = fullIds(context, known);
      const strict = strictIds(context, known);
      measure(key, context, ids, strict);
      if (options) diagnose(key, context, strict, capture, { ...defaultOptions, ...options });
    }

    const baselineChars = JSON.stringify(baselineContext).length;
    // merged: the old response untouched, new Knowledge from the predicted query appended while it still fits.
    {
      const mergedIds = new Set(baseline);
      let length = baselineChars;
      let added = 0;
      for (const id of predictedIds) {
        if (baseline.has(id)) continue;
        const cost = JSON.stringify({ id, title: known.get(id).title }).length + 1 + (added === 0 ? MERGED_FIELD_OVERHEAD : 0);
        if (length + cost > TASK_BUDGET_CHARS) {
          mergedDetail.cutByBudget++;
          if (targets.has(id)) mergedDetail.cutTargets++;
          continue;
        }
        length += cost;
        added++;
        mergedIds.add(id);
        mergedDetail.added++;
        if (targets.has(id)) mergedDetail.addedTargets++;
      }
      mergedDetail.keptOld += baseline.size;
      for (const id of baseline) if (!mergedIds.has(id)) mergedDetail.oldNotKept++;
      record("merged", baselineContext, mergedIds, length - baselineChars);
      // The simulated pointers would sit in the relevant block, so they count as strict hits.
      measure("merged", baselineContext, mergedIds, new Set([...baselineStrict, ...[...mergedIds].filter((id) => !baseline.has(id))]), length - baselineChars);
    }

    const off = contextWith(gates.off, { task });
    const offIds = fullIds(off, known);
    assert.equal(JSON.stringify(off).length, baselineChars, "productOff must equal task");
    assert.deepEqual([...offIds].sort(), [...baseline].sort(), "productOff must equal task");
    record("productOff", off, offIds);

    for (const [key, gate] of [["product", gates.shipped], ["productAlways", gates.always]]) {
      const before = gateFired;
      const capture = {};
      const context = contextWith(gate, { task }, undefined, capture);
      const ids = fullIds(context, known);
      const strict = strictIds(context, known);
      measure(key, context, ids, strict);
      diagnose(key, context, strict, capture, defaultOptions);
      const a = record(key, context, ids);
      a.gateFired += gateFired - before;
      const inferred = (context.relevant?.supplements ?? []).filter((item) => item.includedBecause.kind === "inferred_path");
      if (!targets.size) a.inferredOnNegative += inferred.length;
      if (targets.size && key !== "productOff") {
        const gained = [...targets].filter((id) => ids.has(id) && !offIds.has(id)).length;
        const hits = off.relevant?.knowledge.length ?? 0;
        const buckets = [
          signals[key].knowledgeHits[hits < 5 ? "<5" : "=5"],
          signals[key].confidence[off.relevant?.confidence ?? "none"],
          signals[key].firstRoundHasTarget[[...offIds].some((id) => targets.has(id)) ? "yes" : "no"],
        ];
        for (const bucket of buckets) {
          bucket.tasks++;
          bucket.pairs += targets.size;
          bucket.gained += gained;
        }
      }
    }
  }
  store.close();
  for (const a of Object.values(stats)) assert.equal(a.full, stats.task.full + a.gained - a.lost);
  for (const a of Object.values(prototypeStats)) assert.equal(a.full, stats.task.full + a.gained - a.lost);
  for (const a of Object.values(prototypeStats)) a.averageChars = a.responses ? Math.round(a.chars / a.responses) : 0;
  for (const m of Object.values(metrics)) m.chars.average = m.responses ? Math.round(m.chars.sum / m.responses) : 0;
  return {
    tally,
    stats,
    groups,
    prototype: { stats: prototypeStats, groups: prototypeGroups, merged: mergedDetail, signals },
    metrics,
    diagnostics,
    knowledgeRecallOnly: recallOnly,
  };
}

function loadProject(dbPath, selector) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tracked = db.prepare("SELECT * FROM projects WHERE status='tracked'").all();
    const candidates = selector
      ? tracked.filter((row) => row.id === selector || row.root_path.toLowerCase() === selector.toLowerCase())
      : tracked;
    assert(candidates.length === 1, selector ? "--project must name one tracked project." : "Pass --project: the database does not hold exactly one tracked project.");
    const project = candidates[0];
    const sessions = db.prepare("SELECT * FROM sessions WHERE project_id=? AND voided_at IS NULL").all(project.id);
    const audits = db.prepare("SELECT occurred_at, after_json FROM knowledge_audit WHERE project_id=? ORDER BY julianday(occurred_at), rowid").all(project.id);
    return { project, sessions, audits };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic database (self-check). Fictional names only.
// ---------------------------------------------------------------------------------------------------------------
// Waits until the wall clock reads a later millisecond so every record has a strictly newer timestamp.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const tick = () => {
  const start = Date.now();
  do Atomics.wait(sleepCell, 0, 0, 2);
  while (Date.now() <= start);
};

function seedSyntheticDatabase(databasePath, root) {
  mkdirSync(root, { recursive: true });
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Fictional tidepool", root);
  store.updateProject(project.id, { status: "tracked" });
  let counter = 0;
  const session = (title, files) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `replay-session-${counter++}`,
      startedAt: new Date().toISOString(),
      title,
      summary: `${title}.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: files,
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error(`session failed: ${result.outcome}`);
  };
  const knowledge = (title, body, appliesTo) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `replay-knowledge-${counter++}`,
      kind: "pattern",
      title,
      body,
      ...(appliesTo ? { appliesTo } : {}),
    });
    if (result.outcome !== "knowledge_recorded") throw new Error(`knowledge failed: ${result.outcome}`);
  };
  const themes = ["lantern", "buoy", "mooring", "kelp"];
  const verbs = ["Calibrate", "Rework", "Inspect", "Patch", "Document"];
  // Scoped Knowledge shares no word with any Session title, so only the changed files can reach it.
  for (const [index, theme] of themes.entries()) knowledge(`Quay bolt torque note zone ${index}`, "Tighten to the posted torque.", [`src/${theme}/**`]);
  // Twelve newer unscoped records fill recentKnowledge, so scoped Knowledge is not shown there.
  for (let index = 0; index < 12; index += 1) knowledge(`Driftwood storage note ${index}`, "Store driftwood dry.");
  for (let index = 0; index < 40; index += 1) {
    const theme = themes[index % themes.length];
    session(`${verbs[index % verbs.length]} harbor ${theme} batch ${index}`, [`src/${theme}/part-${index % 3}.ts`, `src/${theme}/index.ts`]);
  }
}

function assertSelfCheck(report) {
  const { stats, prototype } = report;
  assert(report.tally.questions >= 30, "the synthetic replay must cover its questions");
  assert(report.tally.positives > 0, "the synthetic replay must have targets");
  for (const a of [...Object.values(stats), ...Object.values(prototype.stats)]) {
    for (const value of Object.values(a)) {
      if (typeof value === "number") assert(Number.isFinite(value));
    }
  }
  assert.equal(prototype.stats.productOff.full, stats.task.full, "productOff equals task");
  assert.equal(prototype.stats.product.lost, 0, "product must not lose hits");
  assert.equal(prototype.stats.productAlways.lost, 0, "productAlways must not lose hits");
  assert.equal(prototype.stats.merged.lost, 0, "merged keeps every old hit");
  assert.equal(prototype.merged.oldNotKept, 0);
  assert(prototype.stats.productAlways.gained > 0, "inference must reach scoped Knowledge in the synthetic replay");
  assert(prototype.stats.product.gained > 0, "the shipped gate must fire on the synthetic replay");
  assert(prototype.stats.product.locations.supplementsByKind.inferred_path, "gains arrive as inferred_path supplements");
  const { metrics } = report;
  for (const key of PRODUCT_METRICS) {
    assert(metrics[key].responses > 0, `${key} must be measured`);
    assert(metrics[key].chars.max <= TASK_BUDGET_CHARS, `${key} must stay within the task budget`);
    assert.equal(metrics[key].strict.lost, 0, `${key} must not lose strict hits`);
    assert.equal(metrics[key].loose.lost, 0, `${key} must not lose loose hits`);
  }
  assert.equal(metrics.off.loose.full, metrics.task.loose.full, "off equals task (loose)");
  assert.equal(metrics.off.strict.full, metrics.task.strict.full, "off equals task (strict)");
  assert.equal(metrics.off.chars.sum, metrics.task.chars.sum, "off equals task (chars)");
  assert(metrics.paths3Yield.strict.gained > 0, "paths inference gains strict hits in the synthetic replay");
  assert(metrics.weighted3Yield.strict.gained > 0, "weighted inference gains strict hits in the synthetic replay");
  for (const key of PRODUCT_METRICS) {
    const d = report.diagnostics[key];
    assert.equal(d.strictHits + d.notInferred + d.alreadyRecent + d.excludedOmitted + d.cutByCap + d.cutByBudget + d.firstRound, d.pairs, `${key} diagnostics cover every pair`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const dbPath = flagValue(args, "--db");
  const selfCheck = args.includes("--self-check") || !dbPath;
  if (dbPath && !selfCheck && !existsSync(dbPath)) throw new Error("--db file not found.");
  const temp = mkdtempSync(join(tmpdir(), "wi-replay-selfcheck-"));
  try {
    let target = dbPath;
    if (selfCheck) {
      target = join(temp, "synthetic.sqlite");
      seedSyntheticDatabase(target, join(temp, "fictional-root"));
    }
    const { project, sessions, audits } = loadProject(target, selfCheck ? undefined : flagValue(args, "--project"));
    const report = replay(project, sessions, audits);
    console.log(JSON.stringify(report, null, 2));
    if (selfCheck) {
      assertSelfCheck(report);
      console.log("self-check passed");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main();
