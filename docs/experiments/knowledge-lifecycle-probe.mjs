// Knowledge lifecycle probe (research experiment, read-only).
//
// Usage (run from anywhere; the database is opened read-only in ONE read transaction, nothing is written):
//   node docs/experiments/knowledge-lifecycle-probe.mjs [database] [--threshold 0.3] [--sample N --seed S] [--dist-tokenizer] [--path-hit-replay]
//   node docs/experiments/knowledge-lifecycle-probe.mjs [database] --sample N --seed S --reveal   (LOCAL OWNER ONLY)
//   node docs/experiments/knowledge-lifecycle-probe.mjs --self-check                              (synthetic data only)
//
// The default database is data/work-intelligence.sqlite. Without --self-check it never needs packages/*/dist; with
// --dist-tokenizer it tries packages/storage/dist/search-text.js (parseQueryWords) and falls back to the built-in
// tokenizer (NFKC, lower-case words, camelCase/snake_case parts, CJK bigrams) when the build is missing.
//
// Output contract. The default output is one JSON document of aggregate numbers only: counts, ratios, percentiles
// and histogram buckets. It never prints a title, body, decision text, path, id, project name or any other record
// text. The only per-record numbers are candidate-pair index numbers (the k-th pair of a deterministic list) with
// their overlap score and a yes/no revision-cue bit, so the data owner can find the same pairs in a private copy.
//
// --reveal prints the TEXT of the sampled decision pairs. It is for the data owner on the local machine only. Do NOT
// paste, attach, commit or send --reveal output (or anything derived from it) back to anyone, including the agent
// that wrote this script. Label the pairs yourself and report only counts (for example "7 of 30 were real revisions").
// --reveal requires --sample; without --reveal no text is ever printed.
//
// What it measures:
//   (a) the shipped possiblyStale rule (later non-voided Session in the same project, completed after
//       lastConfirmedAt ?? createdAt, changed a file the appliesTo entries match; the Knowledge's own Session and its
//       lastConfirmedSessionId are skipped) and alternative grading signals computed from stored data only;
//   (b) knowledge_audit rows by change type;
//   (d) decisionDuplication: exact and near-duplicate decision groups and standing-request candidates;
//   (a2) with --path-hit-replay: every Session with changed files as a question, replayed at its started_at (pairs of
//       Knowledge created before, active then, matching a changed file), plus two counterfactual confirmation rules also
//       applied to the full staleness section: pathEvidence (an applied confirmation moves the baseline only when the
//       confirming Session itself changed a covered path) and manualOnly (applied never moves it);
//   (c) how many decisions look like they modify an earlier decision of the same project (term overlap and
//       revision wording), at several thresholds.
// The path matcher here is a re-implementation (plain: equal, directory prefix, segment suffix or inside; glob:
// * within a segment, ** across, ? one character), so compare its baseline with the product's before trusting small
// differences. Time comparisons are string comparisons of the stored timestamps, like the product's SQL.
import assert from "node:assert/strict";
import console from "node:console";
import { resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { URL, pathToFileURL } from "node:url";

const SELF_URL = import.meta.url;
const DEFAULT_DATABASE = "data/work-intelligence.sqlite";
const DEFAULT_THRESHOLDS = [0.2, 0.3, 0.4, 0.5];
const DEFAULT_SAMPLE_THRESHOLD = 0.3;
/** A Session that changed more than the search index's "normal" 20 files is a broad (sweeping) change. */
const BROAD_FILES = 21;
const NEAR_SOURCE_MS = 24 * 60 * 60 * 1000;
const MIN_DECISION_TERMS = 3;
const MAX_IDENTIFIERS = 60;
const MAX_POSTINGS = 2_000;

/** Revision wording: the decision says it changes, replaces or removes something decided before. */
const REVISION_CUES = [
  /改為|改成|改用|不再|取代|移除|廢除|回退|還原|撤銷/u,
  /\binstead\b|\breplac(?:e|es|ed|ing)\b|\bno longer\b|\brevert(?:ed|s)?\b|\brollback\b|\brolled back\b/iu,
  /\bswitch(?:ed|es)? to\b|\brather than\b|\bdeprecat(?:e|ed|es)\b|\bremov(?:e|ed|es|ing)\b/iu,
];

const STOPWORDS = new Set(
  ["the", "and", "for", "with", "that", "this", "from", "are", "was", "not", "use", "used", "using"].concat([
    "我們",
    "這個",
    "因為",
    "所以",
    "使用",
    "進行",
  ]),
);

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const TOKEN_RUN = new RegExp(`([${CJK_CLASS}]+)|((?:(?![${CJK_CLASS}])[\\p{L}\\p{N}])+)`, "gu");

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------
function parseJsonOr(text, fallback) {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function ratio(part, whole) {
  return whole > 0 ? Number((part / whole).toFixed(4)) : null;
}

function count(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function recordOf(map) {
  return Object.fromEntries([...map].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Nearest-rank percentiles of a numeric list (rounded to 2 decimals); null values when the list is empty. */
export function percentiles(values, points = [50, 90, 99]) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = { n: sorted.length };
  for (const point of points) {
    result[`p${point}`] =
      sorted.length === 0
        ? null
        : Number(sorted[Math.min(sorted.length - 1, Math.ceil((point / 100) * sorted.length) - 1)].toFixed(2));
  }
  result.max = sorted.length === 0 ? null : Number(sorted[sorted.length - 1].toFixed(2));
  return result;
}

/** Histogram over labelled upper bounds, e.g. [[1, "1"], [3, "2-3"], [Infinity, "4+"]]. */
export function histogram(values, buckets) {
  const result = Object.fromEntries(buckets.map(([, label]) => [label, 0]));
  for (const value of values) {
    const bucket = buckets.find(([upper]) => value <= upper);
    if (bucket) result[bucket[1]] += 1;
  }
  return result;
}

export function normalizePathText(raw, project) {
  let value = String(raw).trim().replace(/\\/g, "/");
  if (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/:\d+(?::\d+)?$/, "").toLowerCase();
  const root = String(project?.rootPath ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (root && (value === root || value.startsWith(`${root}/`))) value = value.slice(root.length + 1);
  else {
    const name = String(project?.name ?? "").toLowerCase();
    if (name && value.startsWith(`${name}/`)) value = value.slice(name.length + 1);
  }
  return value.replace(/\/+$/, "");
}

/** An appliesTo entry as a predicate over normalized project-relative file paths. */
export function compileAppliesTo(entry) {
  const pattern = String(entry).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  if (!pattern) return () => false;
  if (/[*?]/.test(pattern)) {
    let source = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === "*" && pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        while (pattern[index + 1] === "*") index += 1;
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    const regex = new RegExp(`^${source}$`, "u");
    return (file) => regex.test(file);
  }
  return (file) =>
    file === pattern ||
    file.endsWith(`/${pattern}`) ||
    file.startsWith(`${pattern}/`) ||
    file.includes(`/${pattern}/`) ||
    pattern.endsWith(`/${file}`);
}

/** Identifier-like tokens of a text (lower-case): backtick spans, camelCase, PascalCase, snake_case, UPPER_SNAKE. */
export function extractIdentifiers(text) {
  const found = new Set();
  const source = String(text ?? "");
  const add = (token) => {
    const value = token.replace(/\(\)$/, "").toLowerCase();
    if (value.length >= 4 && !/^\d+$/.test(value) && !value.includes("/")) found.add(value);
  };
  for (const match of source.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = match[1].trim();
    if (/^[\w.$-]+(?:\(\))?$/.test(inner)) add(inner);
  }
  for (const match of source.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g)) add(match[0]);
  for (const match of source.matchAll(/\b(?:[A-Z][a-z0-9]+){2,}\b/g)) add(match[0]);
  for (const match of source.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(match[0]);
  for (const match of source.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) add(match[0]);
  return [...found].sort().slice(0, MAX_IDENTIFIERS);
}

function splitIdentifier(run) {
  return run
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(" ");
}

/** Built-in terms: the same idea as the product tokenizer (identifier parts, CJK bigrams), without a build. */
export function builtinTerms(text) {
  const terms = new Set();
  for (const match of String(text ?? "")
    .normalize("NFKC")
    .matchAll(TOKEN_RUN)) {
    const [, cjk, word] = match;
    if (cjk) {
      const chars = Array.from(cjk);
      if (chars.length === 1) terms.add(cjk);
      for (let index = 0; index < chars.length - 1; index += 1) terms.add(`${chars[index]}${chars[index + 1]}`);
    } else if (word) {
      if (word.length >= 2) terms.add(word.toLowerCase());
      const parts = splitIdentifier(word);
      if (parts.length > 1) for (const part of parts) if (part.length >= 2) terms.add(part.toLowerCase());
    }
  }
  return [...terms].filter((term) => !STOPWORDS.has(term) && !/^\d+$/.test(term));
}

export function hasRevisionCue(text) {
  return REVISION_CUES.some((pattern) => pattern.test(String(text ?? "")));
}

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

/** `size` distinct indexes of [0, total), reproducible from the seed, ascending. */
export function sampleIndexes(total, size, seed) {
  const random = rngFrom(seed);
  const pool = Array.from({ length: total }, (_, index) => index);
  const take = Math.min(size, total);
  for (let index = 0; index < take; index += 1) {
    const other = index + Math.floor(random() * (total - index));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  return pool.slice(0, take).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------
// (b) knowledge_audit change types
// ---------------------------------------------------------------------------------------------------------------
const CONTENT_FIELDS = ["kind", "title", "body", "tags", "references"];

/**
 * The change type of one audit row from its action and changedFields. Order matters: an update that changes content
 * is a content edit even when it also confirms.
 */
export function classifyAudit(action, fields) {
  const set = new Set(fields);
  if (action === "created") return set.has("supersedesId") ? "created_with_supersedes" : "created";
  if (action === "archived") return "archived";
  if (action === "restored") return "restored";
  if (CONTENT_FIELDS.some((field) => set.has(field))) return "content_edit";
  if (set.has("appliesTo")) return "applies_to_edit";
  if (set.has("status")) return "status_edit";
  if (set.has("lastConfirmedAt")) return "confirm_only";
  if (set.has("review")) return "contradiction_flag";
  return "other";
}

export function analyzeAudits(audits) {
  const byClass = new Map();
  const byAction = new Map();
  const fieldPresence = new Map();
  const confirmSource = new Map();
  const supersedeTimes = new Set(
    audits
      .filter((a) => classifyAudit(a.action, a.fields) === "created_with_supersedes")
      .map((a) => `${a.projectId}|${a.occurredAt}`),
  );
  let updatesWithConfirm = 0;
  let archivedBySupersede = 0;
  const updatedKnowledge = new Map();
  for (const audit of audits) {
    const type = classifyAudit(audit.action, audit.fields);
    count(byAction, audit.action);
    count(byClass, type);
    if (audit.action === "updated") {
      for (const field of new Set(audit.fields)) count(fieldPresence, field);
      if (audit.fields.includes("lastConfirmedAt")) updatesWithConfirm += 1;
      count(updatedKnowledge, audit.knowledgeId);
    }
    if (type === "confirm_only") count(confirmSource, audit.feedbackKind ?? "no_feedback_row");
    if (audit.action === "archived" && supersedeTimes.has(`${audit.projectId}|${audit.occurredAt}`))
      archivedBySupersede += 1;
  }
  const updated = byAction.get("updated") ?? 0;
  const confirmOnly = byClass.get("confirm_only") ?? 0;
  return {
    rows: audits.length,
    byAction: recordOf(byAction),
    updatedByType: recordOf(
      new Map(
        [...byClass].filter(([key]) => !["created", "created_with_supersedes", "archived", "restored"].includes(key)),
      ),
    ),
    createdWithSupersedes: byClass.get("created_with_supersedes") ?? 0,
    archivedBySupersedeAtSameTime: archivedBySupersede,
    updatedFieldPresence: recordOf(fieldPresence),
    updatesThatAlsoConfirm: updatesWithConfirm,
    confirmOnlyShareOfUpdated: ratio(confirmOnly, updated),
    confirmOnlyBySource: recordOf(confirmSource),
    knowledgeUpdatedTimes: histogram(
      [...updatedKnowledge.values()],
      [
        [1, "1"],
        [2, "2"],
        [4, "3-4"],
        [Infinity, "5+"],
      ],
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// (a) possiblyStale baseline and alternative grading
// ---------------------------------------------------------------------------------------------------------------
/**
 * Proposal, not shipped behavior. strong: a touching Session deleted or renamed a matched path, or Session text names
 * an identifier the Knowledge cites. weak: only sweeping Sessions (BROAD_FILES+) or only Sessions linked to or right
 * after the Knowledge's own Session. moderate: everything else that is stale.
 */
export function gradeStale(features) {
  if (features.structural || features.identifierHit) return "strong";
  if (features.allBroad || features.allSameLineage) return "weak";
  return "moderate";
}

/** Everything the staleness sections share: normalized Sessions, links, confirmations and per-Knowledge touch lists. */
export function buildContext(data) {
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const sessionsByProject = new Map();
  const sessionById = new Map();
  const decisionsBySession = new Map();
  for (const decision of data.decisions) {
    const list = decisionsBySession.get(decision.sessionId) ?? [];
    list.push(decision.text);
    decisionsBySession.set(decision.sessionId, list);
  }
  let mixedOffsets = 0;
  for (const session of data.sessions) {
    const project = projects.get(session.projectId);
    if (!project) continue;
    if (!String(session.completedAt).endsWith("Z")) mixedOffsets += 1;
    const files = new Set();
    for (const raw of session.files) {
      const path = normalizePathText(raw, project);
      if (path) files.add(path);
    }
    const statusByPath = new Map();
    for (const change of session.changes) {
      for (const raw of [change?.path, change?.previousPath]) {
        if (typeof raw === "string" && raw) statusByPath.set(normalizePathText(raw, project), change.status);
      }
    }
    const prepared = {
      id: session.id,
      projectId: session.projectId,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      files: [...files],
      statusByPath,
      text: [session.title, session.summary, ...(decisionsBySession.get(session.id) ?? [])].join("\n").toLowerCase(),
    };
    sessionById.set(session.id, prepared);
    const list = sessionsByProject.get(session.projectId) ?? [];
    list.push(prepared);
    sessionsByProject.set(session.projectId, list);
  }
  for (const list of sessionsByProject.values()) {
    list.sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0));
  }

  const linked = new Set();
  for (const link of data.links) {
    linked.add(`${link.sessionId}|${link.relatedId}`);
    linked.add(`${link.relatedId}|${link.sessionId}`);
  }
  const appliedCount = new Map();
  const contradicted = new Set();
  const feedbackByKnowledge = new Map();
  const confirmEvents = new Map();
  const addEvent = (knowledgeId, event) => {
    const list = confirmEvents.get(knowledgeId) ?? [];
    list.push(event);
    confirmEvents.set(knowledgeId, list);
  };
  for (const item of data.feedback) {
    const list = feedbackByKnowledge.get(item.knowledgeId) ?? [];
    list.push(item);
    feedbackByKnowledge.set(item.knowledgeId, list);
    if (item.kind === "applied") count(appliedCount, item.knowledgeId);
    if (item.kind === "contradicted") contradicted.add(item.knowledgeId);
    if (item.kind === "applied" || item.kind === "manual_confirm") {
      addEvent(item.knowledgeId, { at: item.occurredAt, kind: item.kind, sessionId: item.sessionId });
    }
  }
  // A lastConfirmedAt change without a feedback row (older data) is a confirmation nobody's Session carried.
  const auditsByKnowledge = new Map();
  for (const audit of data.audits) {
    const list = auditsByKnowledge.get(audit.knowledgeId) ?? [];
    list.push(audit);
    auditsByKnowledge.set(audit.knowledgeId, list);
    if (audit.action === "updated" && audit.fields.includes("lastConfirmedAt") && !audit.feedbackKind) {
      addEvent(audit.knowledgeId, { at: audit.occurredAt, kind: "manual_confirm", sessionId: undefined });
    }
  }
  for (const list of confirmEvents.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const patternCache = new Map();
  const matchedPaths = (projectId, pattern) => {
    const key = `${projectId}\u0000${pattern}`;
    const cached = patternCache.get(key);
    if (cached) return cached;
    const matcher = compileAppliesTo(pattern);
    const paths = new Set();
    for (const session of sessionsByProject.get(projectId) ?? []) {
      for (const file of session.files) if (matcher(file)) paths.add(file);
    }
    patternCache.set(key, paths);
    return paths;
  };
  const touchCache = new Map();
  /** Every Session of the project (oldest first) that changed a file one of the Knowledge's entries matches. */
  const touchOf = (item) => {
    const cached = touchCache.get(item.id);
    if (cached) return cached;
    const sets = item.appliesTo.map((pattern) => matchedPaths(item.projectId, pattern));
    const list = (sessionsByProject.get(item.projectId) ?? []).filter((session) =>
      session.files.some((file) => sets.some((set) => set.has(file))),
    );
    const result = { sets, list, ids: new Set(list.map((session) => session.id)) };
    touchCache.set(item.id, result);
    return result;
  };
  const identifierCache = new Map();
  const identifiersOf = (item) => {
    if (!identifierCache.has(item.id)) identifierCache.set(item.id, extractIdentifiers(`${item.title}\n${item.body}`));
    return identifierCache.get(item.id);
  };
  return {
    sessionsByProject,
    sessionById,
    linked,
    appliedCount,
    contradicted,
    feedbackByKnowledge,
    confirmEvents,
    auditsByKnowledge,
    mixedOffsets,
    touchOf,
    identifiersOf,
  };
}

const CONFIRMATION_MODES = ["reconstructedAll", "pathEvidence", "manualOnly"];

/**
 * Does this confirmation move the baseline? reconstructedAll: every applied and manual_confirm. pathEvidence (i):
 * manual_confirm, and applied only when the confirming Session itself changed a path the Knowledge covers.
 * manualOnly (ii): only manual_confirm.
 */
function advancesBaseline(event, mode, touch) {
  if (mode === "reconstructedAll") return true;
  if (event.kind === "manual_confirm") return true;
  if (mode === "manualOnly") return false;
  return event.sessionId !== undefined && touch.ids.has(event.sessionId);
}

/**
 * The Sessions that make one Knowledge stale at `cutoff` (undefined: now). Baseline = max(createdAt, last confirmation
 * before the cutoff that the mode counts); the source Session and the last counted confirming Session are skipped;
 * with a cutoff only Sessions completed before it count.
 */
export function staleAt(ctx, item, cutoff, mode) {
  const touch = ctx.touchOf(item);
  const counted = (ctx.confirmEvents.get(item.id) ?? []).filter(
    (event) => (cutoff === undefined || event.at < cutoff) && advancesBaseline(event, mode, touch),
  );
  const last = counted[counted.length - 1];
  const baseline = last && last.at > item.createdAt ? last.at : item.createdAt;
  const ownIds = new Set([item.sessionId, last?.sessionId].filter(Boolean));
  const touching = touch.list.filter(
    (session) =>
      session.completedAt > baseline &&
      (cutoff === undefined || session.completedAt < cutoff) &&
      !ownIds.has(session.id),
  );
  return { baseline, ownIds, touching, sets: touch.sets };
}

/** The tier signals of one stale Knowledge: touching Sessions measured against its baseline and own Sessions. */
function stalenessFeatures(ctx, item, touching, since, ownIds, sets) {
  const sinceMs = Date.parse(since);
  const identifiers = ctx.identifiersOf(item);
  const matchedFiles = (session) => session.files.filter((file) => sets.some((set) => set.has(file)));
  const isLinked = (session) => [...ownIds].some((id) => ctx.linked.has(`${id}|${session.id}`));
  const sameLineage = (session) =>
    isLinked(session) || (Number.isFinite(sinceMs) && Date.parse(session.completedAt) - sinceMs <= NEAR_SOURCE_MS);
  return {
    structural: touching.some((session) =>
      matchedFiles(session).some((file) => ["deleted", "renamed"].includes(session.statusByPath.get(file) ?? "")),
    ),
    identifierHit: identifiers.some((token) => touching.some((session) => session.text.includes(token))),
    allBroad: touching.every((session) => session.files.length >= BROAD_FILES),
    allSameLineage: touching.every(sameLineage),
    someLinked: touching.some(isLinked),
    allUnlinked: touching.every((session) => !isLinked(session)),
  };
}

/** Stale ratio, tier distribution and later-change Session count buckets of (Knowledge, cutoff) pairs. */
function summarizePairs(ctx, pairs, mode) {
  const tiers = new Map();
  const counts = [];
  for (const { item, cutoff } of pairs) {
    const result = staleAt(ctx, item, cutoff, mode);
    if (result.touching.length === 0) continue;
    counts.push(result.touching.length);
    const features = stalenessFeatures(ctx, item, result.touching, result.baseline, result.ownIds, result.sets);
    count(tiers, gradeStale(features));
  }
  return {
    pairs: pairs.length,
    stale: counts.length,
    staleRatio: ratio(counts.length, pairs.length),
    tiers: {
      counts: recordOf(tiers),
      ratios: Object.fromEntries([...tiers].map(([key, value]) => [key, ratio(value, counts.length)])),
    },
    laterChangeSessionCount: histogram(counts, [
      [1, "1"],
      [3, "2-3"],
      [Infinity, "4+"],
    ]),
  };
}

/** Was the Knowledge active at `time`? Reconstructed from archived/restored audit rows; unknown history: current status. */
function activeAt(ctx, item, time) {
  const changes = (ctx.auditsByKnowledge.get(item.id) ?? [])
    .filter((audit) => audit.action === "archived" || audit.action === "restored")
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  if (changes.length === 0) return item.status === "active";
  const before = changes.filter((audit) => audit.occurredAt < time);
  return before.length === 0 ? true : before[before.length - 1].action === "restored";
}

/**
 * Path-hit replay: every Session S with changed files is a question. A pair is (Knowledge K, S) where K was created
 * before S started, was active then, and one of its appliesTo entries matches a file S changed. Staleness is
 * evaluated as of S's start under each confirmation mode. appliesTo and kind are the current values.
 */
export function analyzeReplay(data, ctx = buildContext(data)) {
  const knowledgeByProject = new Map();
  for (const item of data.knowledge) {
    if (item.appliesTo.length === 0) continue;
    const list = knowledgeByProject.get(item.projectId) ?? [];
    list.push(item);
    knowledgeByProject.set(item.projectId, list);
  }
  const pairs = [];
  let withFiles = 0;
  let skippedNoStart = 0;
  for (const session of ctx.sessionById.values()) {
    if (session.files.length === 0) continue;
    withFiles += 1;
    if (!session.startedAt) {
      skippedNoStart += 1;
      continue;
    }
    for (const item of knowledgeByProject.get(session.projectId) ?? []) {
      if (!(item.createdAt < session.startedAt) || !activeAt(ctx, item, session.startedAt)) continue;
      const { sets } = ctx.touchOf(item);
      if (session.files.some((file) => sets.some((set) => set.has(file))))
        pairs.push({ item, cutoff: session.startedAt });
    }
  }
  return {
    sessionsWithChangedFiles: withFiles,
    sessionsWithoutStartedAt: skippedNoStart,
    pairs: pairs.length,
    distinctKnowledge: new Set(pairs.map(({ item }) => item.id)).size,
    modes: Object.fromEntries(CONFIRMATION_MODES.map((mode) => [mode, summarizePairs(ctx, pairs, mode)])),
  };
}

export function analyzeKnowledge(data, ctx = buildContext(data)) {
  const { appliedCount, contradicted, feedbackByKnowledge, mixedOffsets } = ctx;
  const active = data.knowledge.filter((item) => item.status === "active");
  const withAppliesTo = active.filter((item) => item.appliesTo.length > 0);
  const counts = [];
  const touchSizes = [];
  const gapDays = [];
  const tiers = new Map();
  const countBucketByTier = new Map();
  const flags = {
    structural: 0,
    identifierHit: 0,
    allBroad: 0,
    allSameLineage: 0,
    someSameLineage: 0,
    nearSourceOnly: 0,
    ownSessionWouldHaveCounted: 0,
    touchedOnlyByOwnSessions: 0,
    hasIdentifiers: 0,
    hasIdentifiersAndStale: 0,
  };
  let stale = 0;
  const appliedAfter = new Map();
  const appliedBuckets = { stale: [], fresh: [] };
  const crossTierContradicted = new Map();
  for (const item of withAppliesTo) {
    const since = item.lastConfirmedAt ?? item.createdAt;
    const ownIds = new Set([item.sessionId, item.lastConfirmedSessionId].filter(Boolean));
    const { sets: matchedSets, list: touchList } = ctx.touchOf(item);
    const touchingAll = touchList.filter((session) => session.completedAt > since);
    const touching = touchingAll.filter((session) => !ownIds.has(session.id));
    if (touchingAll.length > touching.length) flags.ownSessionWouldHaveCounted += 1;
    if (touching.length === 0 && touchingAll.length > 0) flags.touchedOnlyByOwnSessions += 1;
    const identifiers = ctx.identifiersOf(item);
    if (identifiers.length > 0) flags.hasIdentifiers += 1;
    const applied = appliedCount.get(item.id) ?? 0;
    for (const feedback of feedbackByKnowledge.get(item.id) ?? []) {
      if (feedback.kind === "applied" && feedback.occurredAt > since) appliedAfter.set(item.id, true);
    }
    if (touching.length === 0) {
      appliedBuckets.fresh.push(applied);
      continue;
    }
    stale += 1;
    appliedBuckets.stale.push(applied);
    counts.push(touching.length);
    const sinceMs = Date.parse(since);
    const features = stalenessFeatures(ctx, item, touching, since, ownIds, matchedSets);
    if (features.structural) flags.structural += 1;
    if (features.identifierHit) flags.identifierHit += 1;
    if (features.allBroad) flags.allBroad += 1;
    if (features.allSameLineage) flags.allSameLineage += 1;
    if (features.someLinked) flags.someSameLineage += 1;
    if (features.allUnlinked && features.allSameLineage) flags.nearSourceOnly += 1;
    if (identifiers.length > 0) flags.hasIdentifiersAndStale += 1;
    const tier = gradeStale(features);
    count(tiers, tier);
    const bucket = touching.length === 1 ? "1" : touching.length <= 3 ? "2-3" : "4+";
    count(countBucketByTier, `${tier}|${bucket}`);
    if (contradicted.has(item.id)) count(crossTierContradicted, tier);
    for (const session of touching) touchSizes.push(session.files.length);
    const first = touching[0];
    if (Number.isFinite(sinceMs)) gapDays.push((Date.parse(first.completedAt) - sinceMs) / 86_400_000);
  }
  const appliedBucketing = (values) =>
    histogram(values, [
      [0, "0"],
      [1, "1"],
      [3, "2-3"],
      [Infinity, "4+"],
    ]);
  const staleCountList = counts;
  return {
    activeKnowledge: active.length,
    activeWithAppliesTo: withAppliesTo.length,
    baselinePossiblyStale: stale,
    baselinePossiblyStaleRatio: ratio(stale, withAppliesTo.length),
    sessionsWithoutZSuffixTimestamp: mixedOffsets,
    laterChangeSessionCount: {
      buckets: histogram(staleCountList, [
        [1, "1"],
        [3, "2-3"],
        [Infinity, "4+"],
      ]),
      percentiles: percentiles(staleCountList),
    },
    touchingSessionFileCount: {
      buckets: histogram(touchSizes, [
        [5, "1-5"],
        [BROAD_FILES - 1, "6-20"],
        [Infinity, "21+"],
      ]),
      percentiles: percentiles(touchSizes),
    },
    daysFromSinceToFirstLaterChange: percentiles(gapDays),
    signals: {
      ...flags,
      identifierCoverageAmongStale: ratio(flags.hasIdentifiersAndStale, stale),
      identifierHitAmongStaleWithIdentifiers: ratio(flags.identifierHit, flags.hasIdentifiersAndStale),
      structuralAmongStale: ratio(flags.structural, stale),
      allBroadAmongStale: ratio(flags.allBroad, stale),
      allSameLineageAmongStale: ratio(flags.allSameLineage, stale),
    },
    proposedTiers: {
      counts: recordOf(tiers),
      ratios: Object.fromEntries([...tiers].map(([key, value]) => [key, ratio(value, stale)])),
    },
    proposedTierByCountBucket: recordOf(countBucketByTier),
    appliedEvidence: {
      appliedSessionsOfStale: appliedBucketing(appliedBuckets.stale),
      appliedSessionsOfFresh: appliedBucketing(appliedBuckets.fresh),
      knowledgeWithAppliedFeedbackAfterSince: appliedAfter.size,
      staleThatWereContradictedByTier: recordOf(crossTierContradicted),
    },
    counterfactualBaselines: Object.fromEntries(
      CONFIRMATION_MODES.map((mode) => {
        const summary = summarizePairs(
          ctx,
          withAppliesTo.map((item) => ({ item, cutoff: undefined })),
          mode,
        );
        return [mode, { baselinePossiblyStale: summary.stale, ...summary }];
      }),
    ),
    supersedes: {
      knowledgeWithSupersedesId: data.knowledge.filter((item) => item.supersedesId).length,
      activeDecisionKind: active.filter((item) => item.kind === "decision").length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// (c) decision supersession heuristic
// ---------------------------------------------------------------------------------------------------------------
/** Every decision's best earlier match (another Session, same project) by IDF-weighted term Jaccard. */
export function matchDecisions(decisions, termsOf = builtinTerms) {
  const byProject = new Map();
  for (const decision of decisions) {
    const list = byProject.get(decision.projectId) ?? [];
    list.push(decision);
    byProject.set(decision.projectId, list);
  }
  const results = [];
  for (const projectId of [...byProject.keys()].sort()) {
    const list = byProject
      .get(projectId)
      .slice()
      .sort(
        (a, b) =>
          (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0) ||
          (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) ||
          a.position - b.position,
      );
    const termSets = list.map((decision) => new Set(termsOf(decision.text)));
    const df = new Map();
    for (const terms of termSets) for (const term of terms) count(df, term);
    const idf = (term) => Math.log((list.length + 1) / ((df.get(term) ?? 0) + 0.5));
    const weights = termSets.map((terms) => [...terms].reduce((sum, term) => sum + idf(term), 0));
    const postings = new Map();
    list.forEach((decision, index) => {
      const terms = termSets[index];
      const eligible = terms.size >= MIN_DECISION_TERMS;
      const overlap = new Map();
      if (eligible) {
        for (const term of terms) {
          const posting = postings.get(term);
          if (!posting || posting.length > MAX_POSTINGS) continue;
          const weight = idf(term);
          for (const other of posting) {
            if (list[other].sessionId === decision.sessionId) continue;
            overlap.set(other, (overlap.get(other) ?? 0) + weight);
          }
        }
      }
      const scored = [];
      for (const [other, inter] of overlap) {
        const union = weights[index] + weights[other] - inter;
        if (union > 0) scored.push({ other, score: inter / union });
      }
      scored.sort((a, b) => b.score - a.score || b.other - a.other);
      results.push({
        projectId,
        decision,
        eligible,
        cue: hasRevisionCue(decision.text),
        matches: scored.map((item) => ({ decision: list[item.other], score: item.score })),
      });
      for (const term of terms) {
        const posting = postings.get(term) ?? [];
        posting.push(index);
        postings.set(term, posting);
      }
    });
  }
  return results;
}

export function analyzeDecisions(decisions, options = {}) {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const sampleThreshold = options.sampleThreshold ?? DEFAULT_SAMPLE_THRESHOLD;
  const results = matchDecisions(decisions, options.termsOf);
  const eligible = results.filter((item) => item.eligible);
  const cueTotal = results.filter((item) => item.cue).length;
  const perThreshold = {};
  for (const threshold of thresholds) {
    const candidates = eligible.filter((item) => (item.matches[0]?.score ?? 0) >= threshold);
    const cueCandidates = candidates.filter((item) => item.cue);
    const noncandidates = results.length - candidates.length;
    const pairCounts = candidates.map((item) => item.matches.filter((match) => match.score >= threshold).length);
    const gaps = candidates.map(
      (item) => (Date.parse(item.decision.completedAt) - Date.parse(item.matches[0].decision.completedAt)) / 86_400_000,
    );
    perThreshold[String(threshold)] = {
      decisionsWithCandidate: candidates.length,
      candidateRatio: ratio(candidates.length, results.length),
      suspectedRevisions: cueCandidates.length,
      suspectedRevisionRatio: ratio(cueCandidates.length, results.length),
      cueRateAmongCandidates: ratio(cueCandidates.length, candidates.length),
      cueRateAmongNonCandidates: ratio(cueTotal - cueCandidates.length, noncandidates),
      pairsAboveThreshold: pairCounts.reduce((sum, value) => sum + value, 0),
      pairsPerCandidate: histogram(pairCounts, [
        [1, "1"],
        [3, "2-3"],
        [Infinity, "4+"],
      ]),
      daysToBestEarlierMatch: percentiles(gaps.filter(Number.isFinite)),
    };
  }
  const bestScores = eligible.map((item) => item.matches[0]?.score ?? 0);
  const perProject = new Map();
  for (const item of results) count(perProject, item.projectId);
  const candidatesAtSample = eligible.filter((item) => (item.matches[0]?.score ?? 0) >= sampleThreshold);
  return {
    summary: {
      decisions: results.length,
      projectsWithDecisions: perProject.size,
      decisionsPerProject: percentiles([...perProject.values()]),
      eligibleForMatching: eligible.length,
      tooShortToMatch: results.length - eligible.length,
      withRevisionCue: cueTotal,
      revisionCueRatio: ratio(cueTotal, results.length),
      bestScoreDistribution: histogram(bestScores, [
        [0, "0"],
        [0.1, "0-0.1"],
        [0.2, "0.1-0.2"],
        [0.3, "0.2-0.3"],
        [0.5, "0.3-0.5"],
        [Infinity, "0.5+"],
      ]),
    },
    perThreshold,
    candidates: candidatesAtSample,
    sampleThreshold,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Decision duplication
// ---------------------------------------------------------------------------------------------------------------
const NEAR_DUPLICATE_THRESHOLD = 0.8;
const STANDING_MIN_SESSIONS = 3;

/** NFKC, lower case, version numbers replaced by a placeholder, then whitespace and punctuation removed. */
export function normalizeDecisionText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\d+\.\d+(?:\.\d+)?/g, "vernum")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function makeUnionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (item) => {
    let root = item;
    while (parent[root] !== root) root = parent[root];
    for (let node = item; parent[node] !== root;) [parent[node], node] = [root, parent[node]];
    return root;
  };
  return { find, union: (a, b) => void (parent[find(a)] = find(b)) };
}

/** Components (arrays of decision indexes) of an edge list over `size` decisions. */
function components(size, edges) {
  const sets = makeUnionFind(size);
  for (const [a, b] of edges) sets.union(a, b);
  const byRoot = new Map();
  for (let index = 0; index < size; index += 1) {
    const root = sets.find(index);
    const list = byRoot.get(root) ?? [];
    list.push(index);
    byRoot.set(root, list);
  }
  return [...byRoot.values()];
}

function groupStats(groups, decisions) {
  const multi = groups.filter((group) => group.length >= 2);
  const spans = multi.map((group) => new Set(group.map((index) => decisions[index].sessionId)).size);
  return {
    groups: multi.length,
    decisionsInGroups: multi.reduce((sum, group) => sum + group.length, 0),
    sizeDist: histogram(
      multi.map((group) => group.length),
      [
        [2, "2"],
        [3, "3"],
        [5, "4-5"],
        [10, "6-10"],
        [Infinity, "11+"],
      ],
    ),
    sessionsSpanned: histogram(spans, [
      [1, "1"],
      [2, "2"],
      [3, "3"],
      [5, "4-5"],
      [Infinity, "6+"],
    ]),
  };
}

/** Groups that appear in at least three distinct Sessions: with origin user_requested only, and with any origin. */
function standingStats(groups, decisions) {
  const tally = (qualifies) => {
    const hits = groups.filter(
      (group) =>
        new Set(group.filter((i) => qualifies(decisions[i])).map((i) => decisions[i].sessionId)).size >=
        STANDING_MIN_SESSIONS,
    );
    return { groups: hits.length, decisions: hits.reduce((sum, group) => sum + group.length, 0) };
  };
  return { userRequested: tally((decision) => decision.origin === "user_requested"), anyOrigin: tally(() => true) };
}

/**
 * Duplicate decisions of one project. exact: equal after normalizeDecisionText. near: IDF Jaccard >= 0.8 between
 * different Sessions, merged with union-find. merged: exact or near. Standing-request candidates and the de-duplicated
 * total are reported for exact groups alone and for merged groups.
 */
export function analyzeDecisionDuplication(decisions, options = {}) {
  const indexOf = new Map(decisions.map((decision, index) => [decision, index]));
  const exactKeys = new Map();
  const exactEdges = [];
  decisions.forEach((decision, index) => {
    const normalized = normalizeDecisionText(decision.text);
    if (!normalized) return;
    const key = `${decision.projectId}\u0000${normalized}`;
    if (exactKeys.has(key)) exactEdges.push([exactKeys.get(key), index]);
    else exactKeys.set(key, index);
  });
  const nearEdges = [];
  for (const item of matchDecisions(decisions, options.termsOf)) {
    const self = indexOf.get(item.decision);
    for (const match of item.matches) {
      if (match.score < NEAR_DUPLICATE_THRESHOLD) break;
      nearEdges.push([self, indexOf.get(match.decision)]);
    }
  }
  const exact = components(decisions.length, exactEdges);
  const near = components(decisions.length, nearEdges);
  const merged = components(decisions.length, [...exactEdges, ...nearEdges]);
  const multiOnly = (groups) => groups.filter((group) => group.length >= 2);
  return {
    decisions: decisions.length,
    nearThreshold: NEAR_DUPLICATE_THRESHOLD,
    exact: groupStats(exact, decisions),
    near: groupStats(near, decisions),
    merged: groupStats(merged, decisions),
    standingRequestCandidates: {
      minSessions: STANDING_MIN_SESSIONS,
      exact: standingStats(multiOnly(exact), decisions),
      merged: standingStats(multiOnly(merged), decisions),
    },
    dedupedDecisions: { exactOnly: exact.length, merged: merged.length },
  };
}

/** The numbers-only description of a sample (index, score, cue bit) from the reproducible candidate list. */
export function describeSample(analysis, sampleSize, seed) {
  const total = analysis.candidates.length;
  const indexes = sampleIndexes(total, sampleSize, seed);
  return {
    threshold: analysis.sampleThreshold,
    candidatePairs: total,
    requested: sampleSize,
    seed,
    picks: indexes.map((index) => ({
      index,
      score: Number(analysis.candidates[index].matches[0].score.toFixed(3)),
      cue: analysis.candidates[index].cue,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Loading (the only code that touches the database; SELECT only)
// ---------------------------------------------------------------------------------------------------------------
export function loadData(db) {
  const projects = db
    .prepare("SELECT id, name, root_path FROM projects WHERE status = 'tracked'")
    .all()
    .map((row) => ({ id: row.id, name: row.name, rootPath: row.root_path }));
  const sessions = db
    .prepare(
      `SELECT s.id, s.project_id, s.title, s.summary, s.started_at, s.completed_at, s.changed_files_json, s.changed_file_changes_json
       FROM sessions s JOIN projects p ON p.id = s.project_id AND p.status = 'tracked'
       WHERE s.voided_at IS NULL`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at,
      files: parseJsonOr(row.changed_files_json, []).filter((value) => typeof value === "string"),
      changes: parseJsonOr(row.changed_file_changes_json, []).filter((value) => value && typeof value === "object"),
    }));
  const decisions = db
    .prepare(
      `SELECT d.session_id, d.project_id, d.position, d.text, d.origin, s.completed_at
       FROM session_decisions d
       JOIN sessions s ON s.id = d.session_id AND s.voided_at IS NULL
       JOIN projects p ON p.id = d.project_id AND p.status = 'tracked'`,
    )
    .all()
    .map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id,
      position: row.position,
      text: row.text,
      origin: row.origin,
      completedAt: row.completed_at,
    }));
  const knowledge = db
    .prepare(
      `SELECT k.id, k.project_id, k.session_id, k.kind, k.status, k.title, k.body, k.created_at, k.applies_to_json,
              k.last_confirmed_at, k.last_confirmed_session_id, k.supersedes_id
       FROM knowledge k JOIN projects p ON p.id = k.project_id AND p.status = 'tracked'`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id ?? undefined,
      kind: row.kind,
      status: row.status,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      appliesTo: parseJsonOr(row.applies_to_json, []).filter((value) => typeof value === "string"),
      lastConfirmedAt: row.last_confirmed_at ?? undefined,
      lastConfirmedSessionId: row.last_confirmed_session_id ?? undefined,
      supersedesId: row.supersedes_id ?? undefined,
    }));
  const audits = db
    .prepare(
      `SELECT a.id, a.knowledge_id, a.project_id, a.action, a.changed_fields_json, a.occurred_at, f.kind AS feedback_kind
       FROM knowledge_audit a
       JOIN projects p ON p.id = a.project_id AND p.status = 'tracked'
       LEFT JOIN knowledge_feedback f ON f.id = a.id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      knowledgeId: row.knowledge_id,
      projectId: row.project_id,
      action: row.action,
      fields: parseJsonOr(row.changed_fields_json, []).filter((value) => typeof value === "string"),
      occurredAt: row.occurred_at,
      feedbackKind: row.feedback_kind ?? undefined,
    }));
  const feedback = db
    .prepare("SELECT knowledge_id, session_id, kind, occurred_at FROM knowledge_feedback")
    .all()
    .map((row) => ({
      knowledgeId: row.knowledge_id,
      sessionId: row.session_id ?? undefined,
      kind: row.kind,
      occurredAt: row.occurred_at,
    }));
  const links = db
    .prepare("SELECT session_id, related_session_id FROM session_links")
    .all()
    .map((row) => ({ sessionId: row.session_id, relatedId: row.related_session_id }));
  return { projects, sessions, decisions, knowledge, audits, feedback, links };
}

/** The whole numbers-only report for loaded data; `analysis.candidates` is never included. */
export function buildReport(data, options = {}) {
  const ctx = buildContext(data);
  const decisionAnalysis = analyzeDecisions(data.decisions, options);
  const report = {
    sizes: {
      projects: data.projects.length,
      sessions: data.sessions.length,
      decisions: data.decisions.length,
      knowledge: data.knowledge.length,
      auditRows: data.audits.length,
      feedbackRows: data.feedback.length,
    },
    staleness: analyzeKnowledge(data, ctx),
    audit: analyzeAudits(data.audits),
    decisionSupersession: { summary: decisionAnalysis.summary, perThreshold: decisionAnalysis.perThreshold },
    decisionDuplication: analyzeDecisionDuplication(data.decisions, options),
  };
  if (options.pathHitReplay) report.pathHitReplay = analyzeReplay(data, ctx);
  if (options.sample)
    report.decisionSupersession.sample = describeSample(decisionAnalysis, options.sample, options.seed ?? 1);
  return { report, decisionAnalysis };
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check: pure functions, synthetic data, no dist, no real database
// ---------------------------------------------------------------------------------------------------------------
function syntheticData() {
  const day = (n) => `2026-01-${String(n).padStart(2, "0")}T10:00:00.000Z`;
  const project = { id: "pid-zqproj", name: "ZqProjectName", rootPath: "/home/zquser/zqproject" };
  const make = (id, n, title, files, changes = [], summary = "zqsummary text") => ({
    id,
    projectId: project.id,
    title,
    summary,
    completedAt: day(n),
    files,
    changes,
  });
  const sessions = [
    make("sid-zq-source", 1, "zqseed session", ["/home/zquser/zqproject/src/zqalpha/core.ts"]),
    make("sid-zq-touch-a", 5, "zqtouch alpha", ["src/zqalpha/core.ts"]),
    make("sid-zq-touch-b", 6, "zqtouch beta", ["src/zqalpha/other.ts"]),
    make("sid-zq-touch-c", 7, "zqtouch gamma", ["src/zqalpha/third.ts"]),
    make("sid-zq-touch-d", 8, "zqtouch delta", ["src/zqalpha/fourth.ts"]),
    make(
      "sid-zq-delete",
      9,
      "zqremove gamma",
      ["src/zqbeta/gone.ts"],
      [{ path: "src/zqbeta/gone.ts", status: "deleted" }],
    ),
    make(
      "sid-zq-broad",
      10,
      "zqbroad sweep",
      Array.from({ length: 25 }, (_, i) => `src/zqwide/file${i}.ts`),
    ),
    make("sid-zq-symbol", 11, "zqrefactor fooZqHandler wiring", ["src/zqsymbol/handler.ts"]),
    make("sid-zq-old", 2, "zqold session", ["src/zqold/legacy.ts"]),
  ];
  const k = (id, extra) => ({
    id,
    projectId: project.id,
    kind: "pattern",
    status: "active",
    title: "zqknowledge title",
    body: "zqknowledge body",
    createdAt: day(3),
    appliesTo: [],
    ...extra,
  });
  const knowledge = [
    k("kid-zq-fresh", { appliesTo: ["src/zqnever/*.ts"] }),
    k("kid-zq-own", { appliesTo: ["src/zqalpha/core.ts"], sessionId: "sid-zq-touch-a", createdAt: day(4) }),
    k("kid-zq-before", { appliesTo: ["src/zqold/legacy.ts"] }),
    k("kid-zq-many", { appliesTo: ["src/zqalpha/"], lastConfirmedAt: day(4) }),
    k("kid-zq-deleted", { appliesTo: ["src/zqbeta/**"] }),
    k("kid-zq-broad", { appliesTo: ["src/zqwide/file1.ts"] }),
    k("kid-zq-symbol", { appliesTo: ["src/zqsymbol"], body: "Wired through `fooZqHandler` only." }),
    k("kid-zq-archived", { status: "archived", appliesTo: ["src/zqalpha/core.ts"] }),
    k("kid-zq-noapplies", {}),
  ];
  const audits = [
    {
      id: "aid-1",
      knowledgeId: "kid-zq-fresh",
      projectId: project.id,
      action: "created",
      fields: ["kind", "title", "body"],
      occurredAt: day(3),
    },
    {
      id: "aid-2",
      knowledgeId: "kid-zq-many",
      projectId: project.id,
      action: "created",
      fields: ["kind", "supersedesId"],
      occurredAt: day(4),
    },
    {
      id: "aid-3",
      knowledgeId: "kid-zq-old",
      projectId: project.id,
      action: "archived",
      fields: ["status"],
      occurredAt: day(4),
    },
    {
      id: "aid-4",
      knowledgeId: "kid-zq-fresh",
      projectId: project.id,
      action: "updated",
      fields: ["lastConfirmedAt"],
      occurredAt: day(5),
      feedbackKind: "applied",
    },
    {
      id: "aid-5",
      knowledgeId: "kid-zq-fresh",
      projectId: project.id,
      action: "updated",
      fields: ["lastConfirmedAt", "review"],
      occurredAt: day(6),
      feedbackKind: "manual_confirm",
    },
    {
      id: "aid-6",
      knowledgeId: "kid-zq-fresh",
      projectId: project.id,
      action: "updated",
      fields: ["body", "lastConfirmedAt"],
      occurredAt: day(7),
    },
    {
      id: "aid-7",
      knowledgeId: "kid-zq-many",
      projectId: project.id,
      action: "updated",
      fields: ["appliesTo"],
      occurredAt: day(8),
    },
    {
      id: "aid-8",
      knowledgeId: "kid-zq-many",
      projectId: project.id,
      action: "updated",
      fields: ["review"],
      occurredAt: day(9),
      feedbackKind: "contradicted",
    },
    {
      id: "aid-9",
      knowledgeId: "kid-zq-many",
      projectId: project.id,
      action: "restored",
      fields: ["status"],
      occurredAt: day(10),
    },
  ];
  const feedback = [
    { knowledgeId: "kid-zq-fresh", sessionId: "sid-zq-old", kind: "applied", occurredAt: day(5) },
    { knowledgeId: "kid-zq-many", sessionId: "sid-zq-old", kind: "applied", occurredAt: day(4) },
    { knowledgeId: "kid-zq-many", sessionId: "sid-zq-old", kind: "contradicted", occurredAt: day(9) },
  ];
  const decisions = [
    {
      sessionId: "sid-zq-source",
      position: 0,
      text: "zqconfig loader stores zqsettings in zqjsonfile storage",
      completedAt: day(1),
    },
    {
      sessionId: "sid-zq-touch-a",
      position: 0,
      text: "zqconfig loader stores zqsettings using zqsqlite instead of zqjsonfile storage, no longer zqjsonfile",
      completedAt: day(5),
    },
    {
      sessionId: "sid-zq-touch-b",
      position: 0,
      text: "zqwidget renders zqgraph labels with zqcanvas",
      completedAt: day(6),
    },
    {
      sessionId: "sid-zq-touch-c",
      position: 0,
      text: "設定檔載入器改用 zqsqlite 取代 zqjsonfile 儲存設定",
      completedAt: day(7),
    },
    { sessionId: "sid-zq-touch-c", position: 1, text: "zq ab", completedAt: day(7) },
  ].map((item) => ({ ...item, projectId: project.id }));
  const links = [{ sessionId: "sid-zq-touch-b", relatedId: "sid-zq-source" }];
  const strings = [
    project.id,
    project.name,
    project.rootPath,
    ...sessions.flatMap((s) => [s.id, s.title, s.summary, ...s.files]),
    ...knowledge.flatMap((item) => [item.id, item.title, item.body, ...item.appliesTo]),
    ...audits.map((a) => a.id),
    ...decisions.map((d) => d.text),
  ];
  return { data: { projects: [project], sessions, decisions, knowledge, audits, feedback, links }, strings };
}

/**
 * Two Knowledge items and Sessions arranged so every confirmation mode gives a different answer.
 * K1 (source s1) is confirmed manually on day 2 and "applied" by s3 on day 5, but s3 never touched K1's path.
 * K2 is archived on day 4. K3 is "applied" by s7 on day 6 and s7 itself changed K3's path.
 */
function replayData() {
  const at = (day, hour) => `2026-02-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const project = { id: "pid-zqreplay", name: "ZqReplay", rootPath: "/home/zquser/zqreplay" };
  const session = (id, startDay, doneDay, files) => ({
    id,
    projectId: project.id,
    title: `zqreplay ${id}`,
    summary: "zqreplay summary",
    startedAt: startDay === undefined ? undefined : at(startDay, 9),
    completedAt: at(doneDay, 10),
    files,
    changes: [],
  });
  const sessions = [
    session("sid-zr1", 1, 1, ["src/zqa/x.ts"]),
    session("sid-zr2", 4, 4, ["src/zqa/x.ts"]),
    session("sid-zr3", 5, 5, ["src/zqb/y.ts"]),
    session("sid-zr4", 8, 8, ["src/zqa/x.ts"]),
    session("sid-zr5", 9, 9, []),
    session("sid-zr6", undefined, 9, ["src/zqa/x.ts"]),
    session("sid-zr7", 6, 6, ["src/zqc/z.ts"]),
    session("sid-zr8", 2, 2, ["src/zqc/z.ts"]),
  ];
  const k = (id, extra) => ({
    id,
    projectId: project.id,
    kind: "pattern",
    status: "active",
    title: "zqreplay knowledge",
    body: "zqreplay body",
    createdAt: at(1, 10),
    ...extra,
  });
  const knowledge = [
    k("kid-zr1", { appliesTo: ["src/zqa/x.ts"], sessionId: "sid-zr1" }),
    k("kid-zr2", { appliesTo: ["src/zqa/x.ts"], status: "archived" }),
    k("kid-zr3", { appliesTo: ["src/zqc/z.ts"] }),
  ];
  const feedback = [
    { knowledgeId: "kid-zr1", kind: "manual_confirm", occurredAt: at(2, 10) },
    { knowledgeId: "kid-zr1", sessionId: "sid-zr3", kind: "applied", occurredAt: at(5, 10) },
    { knowledgeId: "kid-zr3", sessionId: "sid-zr7", kind: "applied", occurredAt: at(6, 10) },
  ];
  const audits = [
    {
      id: "aid-zr1",
      knowledgeId: "kid-zr2",
      projectId: project.id,
      action: "archived",
      fields: ["status"],
      occurredAt: at(4, 12),
    },
  ];
  const strings = [
    project.id,
    project.name,
    project.rootPath,
    ...sessions.flatMap((s) => [s.id, s.title, s.summary, ...s.files]),
    ...knowledge.flatMap((item) => [item.id, item.title, item.body, ...item.appliesTo]),
    "aid-zr1",
  ];
  return { data: { projects: [project], sessions, decisions: [], knowledge, audits, feedback, links: [] }, strings };
}

/** Decisions: one exact group with a version number, one near-duplicate pair, standing and any-origin groups. */
function duplicationData() {
  const project = { id: "pid-zqdup", name: "ZqDup", rootPath: "/home/zquser/zqdup" };
  let counter = 0;
  const decision = (session, text, origin) => ({
    projectId: project.id,
    sessionId: `sid-zd${session}`,
    position: counter++,
    text,
    origin,
    completedAt: `2026-03-${String(session).padStart(2, "0")}T10:00:00.000Z`,
  });
  const decisions = [
    decision(1, "Always use zqpnpm 9.1.2 for zqinstalls", "user_requested"),
    decision(2, "always use ZQPNPM 9.2.0 for zqinstalls!", "user_requested"),
    decision(3, "Always use zqpnpm 10.0 for zqinstalls.", "agent_autonomous"),
    decision(4, "Always use zqpnpm 9.1.2 for zqinstalls", "user_requested"),
    decision(5, "zqwidget renders zqlabels", "user_requested"),
    decision(6, "zqwidget  renders zqlabels.", "user_requested"),
    decision(7, "zqcache keys include zqtenant id", "agent_autonomous"),
    decision(8, "zqcache keys include zqtenant id", "agent_autonomous"),
    decision(9, "zqcache keys include zqtenant id", "agent_autonomous"),
    decision(10, "zqparser handles zqquoted fields zqescape rules zqstrictly", "user_requested"),
    decision(11, "zqparser handles zqquoted fields zqescape rules zqstrictly today", "user_requested"),
    decision(12, "zqunrelated alpha beta gamma", "user_requested"),
    decision(13, "zqdifferent delta epsilon zeta", "agent_autonomous"),
  ];
  return {
    decisions,
    strings: [project.id, ...decisions.map((item) => item.text), ...decisions.map((item) => item.sessionId)],
  };
}

function assertNoLeak(output, strings, label) {
  const text = JSON.stringify(output);
  for (const value of strings) {
    assert(!text.includes(value), `${label}: output contains record text`);
    for (const word of String(value).split(/[\s/.:,`()]+/u)) {
      if (word.length >= 4 && /zq|sid|kid|aid|pid/u.test(word))
        assert(!text.includes(word), `${label}: output contains a record word`);
    }
  }
}

function selfCheck() {
  // Helpers.
  assert.deepEqual(percentiles([1, 2, 3, 4, 100], [50, 90]), { n: 5, p50: 3, p90: 100, max: 100 });
  assert.equal(percentiles([]).p50, null);
  assert.deepEqual(
    histogram(
      [1, 2, 3, 4, 9],
      [
        [1, "1"],
        [3, "2-3"],
        [Infinity, "4+"],
      ],
    ),
    { 1: 1, "2-3": 2, "4+": 2 },
  );
  assert.equal(normalizePathText("C:\\Repo\\Src\\A.ts:12:3", { rootPath: "c:/repo", name: "x" }), "src/a.ts");
  assert.equal(normalizePathText("./Proj/src/a.ts", { rootPath: "/other", name: "Proj" }), "src/a.ts");
  const dir = compileAppliesTo("src/zqa");
  assert(dir("src/zqa/b.ts") && dir("x/src/zqa/b.ts") && !dir("src/zqab/b.ts"));
  assert(compileAppliesTo("b.ts")("src/b.ts") && compileAppliesTo("src/b.ts")("b.ts"));
  const star = compileAppliesTo("src/*.ts");
  assert(
    star("src/a.ts") &&
      !star("src/x/a.ts") &&
      compileAppliesTo("src/**/a.ts")("src/x/y/a.ts") &&
      compileAppliesTo("a?.ts")("ab.ts"),
  );
  assert.deepEqual(
    extractIdentifiers("Use `fooBar()` and ParserFactory, snake_case_name, MAX_RETRY_COUNT and the x_y."),
    ["foobar", "max_retry_count", "parserfactory", "snake_case_name"],
  );
  assert.deepEqual(extractIdentifiers("plain words only, a `two words` span `src/a.ts`"), []);
  for (const cue of [
    "改為 X",
    "已經不再使用",
    "use A instead",
    "Replaces the old way",
    "no longer needed",
    "revert it",
    "rollback plan",
    "移除舊設定",
  ]) {
    assert(hasRevisionCue(cue), `cue ${cue}`);
  }
  assert(!hasRevisionCue("adds a new parser for logs"));
  assert(builtinTerms("設定檔載入").includes("設定") && builtinTerms("fooBarBaz").includes("bar"));

  // Sampling is reproducible, distinct, in range and seed dependent.
  const first = sampleIndexes(100, 10, 7);
  assert.deepEqual(first, sampleIndexes(100, 10, 7));
  assert.equal(new Set(first).size, 10);
  assert(first.every((value) => value >= 0 && value < 100));
  assert.notDeepEqual(first, sampleIndexes(100, 10, 8));
  assert.deepEqual(sampleIndexes(3, 10, 1), [0, 1, 2]);

  // Audit classification.
  const cases = [
    ["created", ["kind", "title"], "created"],
    ["created", ["kind", "supersedesId"], "created_with_supersedes"],
    ["archived", ["status"], "archived"],
    ["restored", ["status"], "restored"],
    ["updated", ["lastConfirmedAt"], "confirm_only"],
    ["updated", ["lastConfirmedAt", "review"], "confirm_only"],
    ["updated", ["review"], "contradiction_flag"],
    ["updated", ["body", "lastConfirmedAt"], "content_edit"],
    ["updated", ["appliesTo"], "applies_to_edit"],
    ["updated", ["status"], "status_edit"],
    ["updated", [], "other"],
  ];
  for (const [action, fields, expected] of cases)
    assert.equal(classifyAudit(action, fields), expected, `${action} ${fields}`);
  assert.equal(gradeStale({ structural: true, allBroad: true }), "strong");
  assert.equal(gradeStale({ identifierHit: true }), "strong");
  assert.equal(gradeStale({ allBroad: true }), "weak");
  assert.equal(gradeStale({ allSameLineage: true }), "weak");
  assert.equal(gradeStale({}), "moderate");

  const { data, strings } = syntheticData();
  const audit = analyzeAudits(data.audits);
  assert.equal(audit.rows, 9);
  assert.equal(audit.byAction.updated, 5);
  assert.equal(audit.updatedByType.confirm_only, 2);
  assert.equal(audit.updatedByType.content_edit, 1);
  assert.equal(audit.updatedByType.applies_to_edit, 1);
  assert.equal(audit.updatedByType.contradiction_flag, 1);
  assert.equal(audit.createdWithSupersedes, 1);
  assert.equal(audit.archivedBySupersedeAtSameTime, 1);
  assert.equal(audit.confirmOnlyShareOfUpdated, 0.4);
  assert.deepEqual(audit.confirmOnlyBySource, { applied: 1, manual_confirm: 1 });
  assert.equal(audit.updatesThatAlsoConfirm, 3);

  // Staleness: fresh, own Session skipped, touch before confirmation ignored, archived and appliesTo-less skipped.
  const stale = analyzeKnowledge(data);
  assert.equal(stale.activeKnowledge, 8);
  assert.equal(stale.activeWithAppliesTo, 7);
  // many, deleted, broad, symbol are stale; fresh, own (only its own Session touched it) and before are not.
  assert.equal(stale.baselinePossiblyStale, 4);
  assert.equal(stale.baselinePossiblyStaleRatio, Number((4 / 7).toFixed(4)));
  assert.equal(stale.signals.ownSessionWouldHaveCounted, 1);
  assert.equal(stale.signals.touchedOnlyByOwnSessions, 1);
  assert.equal(stale.signals.structural, 1);
  assert.equal(stale.signals.identifierHit, 1);
  assert.equal(stale.signals.hasIdentifiers, 1);
  assert.equal(stale.signals.allBroad, 1);
  assert.equal(stale.laterChangeSessionCount.buckets["4+"], 1, "many: four later sessions after its confirmation");
  assert.equal(stale.laterChangeSessionCount.buckets["1"], 3);
  assert.deepEqual(stale.proposedTiers.counts, { strong: 2, weak: 1, moderate: 1 });
  // Only kid-zq-fresh has applied feedback later than its since (real data keeps them equal by construction).
  assert.equal(stale.appliedEvidence.knowledgeWithAppliedFeedbackAfterSince, 1);
  assert.equal(stale.supersedes.knowledgeWithSupersedesId, 0);

  // Decisions: the revision of the first decision is found, unrelated ones are not, short ones are skipped.
  const matched = matchDecisions(data.decisions);
  assert.equal(matched.length, 5);
  const revision = matched.find((item) => item.decision.sessionId === "sid-zq-touch-a");
  assert.equal(revision.cue, true);
  assert.equal(revision.matches[0].decision.sessionId, "sid-zq-source");
  assert(revision.matches[0].score >= 0.3, `revision score ${revision.matches[0].score}`);
  assert.equal(matched.find((item) => item.decision.sessionId === "sid-zq-touch-b").matches.length, 0);
  assert.equal(matched.find((item) => item.decision.text === "zq ab").eligible, false);
  const analysis = analyzeDecisions(data.decisions, { thresholds: [0.2, 0.5] });
  assert.equal(analysis.summary.decisions, 5);
  assert.equal(analysis.summary.tooShortToMatch, 1);
  assert(analysis.perThreshold["0.2"].suspectedRevisions >= 1);
  assert(analysis.perThreshold["0.5"].decisionsWithCandidate <= analysis.perThreshold["0.2"].decisionsWithCandidate);
  const described = describeSample(analysis, 2, 3);
  assert.deepEqual(described, describeSample(analysis, 2, 3));
  assert(described.picks.every((pick) => Object.keys(pick).sort().join() === "cue,index,score"));

  // Default output contains no record text, with and without a sample.
  const report = buildReport(data, { sample: 3, seed: 5 }).report;
  assertNoLeak(report, strings, "report");
  assert(!JSON.stringify(report).includes('candidates":['));
  assertNoLeak(buildReport(data).report, strings, "report-no-sample");

  // Path-hit replay and the two counterfactual confirmation rules.
  const replay = replayData();
  const replayReport = buildReport(replay.data, { pathHitReplay: true }).report;
  const replayed = replayReport.pathHitReplay;
  assert.equal(replayed.sessionsWithChangedFiles, 7);
  assert.equal(replayed.sessionsWithoutStartedAt, 1);
  // (K1,s2) (K1,s4) (K2,s2) (K3,s8) (K3,s7); K2 is archived by s4, K1/K2 were created after s1 started.
  assert.equal(replayed.pairs, 5);
  assert.equal(replayed.distinctKnowledge, 3);
  // Only (K3,s7) is stale when every confirmation counts: s8 changed K3's path after its creation.
  assert.equal(replayed.modes.reconstructedAll.stale, 1);
  // K1 at s4: s3's applied (no path evidence) is ignored, so s2's change after the day-2 manual confirmation counts.
  assert.equal(replayed.modes.pathEvidence.stale, 2);
  assert.equal(replayed.modes.manualOnly.stale, 2);
  assert.equal(replayed.modes.pathEvidence.staleRatio, 0.4);
  assert.equal(replayed.modes.pathEvidence.laterChangeSessionCount["1"], 2);
  assert.equal(
    Object.values(replayed.modes.manualOnly.tiers.counts).reduce((a, b) => a + b, 0),
    2,
  );
  // Full section: K1 and K3 are active with appliesTo. K3's applied carries path evidence, K1's does not.
  const factual = replayReport.staleness.counterfactualBaselines;
  assert.equal(factual.reconstructedAll.baselinePossiblyStale, 1);
  assert.equal(factual.pathEvidence.baselinePossiblyStale, 1);
  assert.equal(factual.manualOnly.baselinePossiblyStale, 2);
  assert.equal(factual.manualOnly.pairs, 2);
  assert(!("pathHitReplay" in buildReport(replay.data).report));
  assertNoLeak(replayReport, replay.strings, "replay");
  assert.equal(
    staleAt(buildContext(replay.data), replay.data.knowledge[0], undefined, "manualOnly").touching.length,
    3,
  );

  // Decision duplication.
  assert.equal(normalizeDecisionText("Use v1.2.3 (now)!"), normalizeDecisionText("use  V9.0 now"));
  const duplicates = duplicationData();
  const duplication = analyzeDecisionDuplication(duplicates.decisions);
  assert.equal(duplication.decisions, 13);
  // Exact: the four pnpm decisions (versions normalized), the two widget ones, the three cache ones.
  assert.equal(duplication.exact.groups, 3);
  assert.equal(duplication.exact.decisionsInGroups, 9);
  assert.deepEqual(duplication.exact.sizeDist, { 2: 1, 3: 1, "4-5": 1, "6-10": 0, "11+": 0 });
  assert.deepEqual(duplication.exact.sessionsSpanned, { 1: 0, 2: 1, 3: 1, "4-5": 1, "6+": 0 });
  // Near adds the parser pair; the version-differing pnpm decision is below 0.8 against the others.
  assert(duplication.near.groups >= 3);
  assert.equal(duplication.merged.groups, 4);
  assert.equal(duplication.merged.decisionsInGroups, 11);
  assert.deepEqual(duplication.standingRequestCandidates.exact.userRequested, { groups: 1, decisions: 4 });
  assert.deepEqual(duplication.standingRequestCandidates.exact.anyOrigin, { groups: 2, decisions: 7 });
  assert.deepEqual(duplication.standingRequestCandidates.merged.anyOrigin, { groups: 2, decisions: 7 });
  assert.deepEqual(duplication.dedupedDecisions, { exactOnly: 13 - 9 + 3, merged: 13 - 11 + 4 });
  assertNoLeak(duplication, duplicates.strings, "duplication");
  assertNoLeak(
    buildReport({ ...data, decisions: duplicates.decisions }).report,
    duplicates.strings,
    "duplication-report",
  );

  // The SQL runs against the real column names (a minimal copy of the columns this probe reads) and matches.
  const memory = new DatabaseSync(":memory:");
  memory.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, status TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, summary TEXT, completed_at TEXT,
      changed_files_json TEXT, changed_file_changes_json TEXT, voided_at TEXT, started_at TEXT);
    CREATE TABLE session_decisions (id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, position INTEGER, text TEXT, origin TEXT);
    CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, kind TEXT, status TEXT, title TEXT,
      body TEXT, created_at TEXT, applies_to_json TEXT, last_confirmed_at TEXT, last_confirmed_session_id TEXT, supersedes_id TEXT);
    CREATE TABLE knowledge_audit (id TEXT PRIMARY KEY, knowledge_id TEXT, project_id TEXT, action TEXT,
      changed_fields_json TEXT, occurred_at TEXT);
    CREATE TABLE knowledge_feedback (id TEXT PRIMARY KEY, knowledge_id TEXT, project_id TEXT, session_id TEXT, kind TEXT, occurred_at TEXT);
    CREATE TABLE session_links (id TEXT PRIMARY KEY, session_id TEXT, related_session_id TEXT);
  `);
  const p = data.projects[0];
  memory.prepare("INSERT INTO projects VALUES (?, ?, ?, 'tracked')").run(p.id, p.name, p.rootPath);
  for (const s of data.sessions) {
    memory
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(
        s.id,
        s.projectId,
        s.title,
        s.summary,
        s.completedAt,
        JSON.stringify(s.files),
        JSON.stringify(s.changes),
        s.startedAt ?? null,
      );
  }
  data.decisions.forEach((d, index) =>
    memory
      .prepare("INSERT INTO session_decisions VALUES (?, ?, ?, ?, ?, ?)")
      .run(`d${index}`, d.sessionId, d.projectId, d.position, d.text, d.origin ?? "unspecified"),
  );
  for (const item of data.knowledge) {
    memory
      .prepare("INSERT INTO knowledge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        item.id,
        item.projectId,
        item.sessionId ?? null,
        item.kind,
        item.status,
        item.title,
        item.body,
        item.createdAt,
        JSON.stringify(item.appliesTo),
        item.lastConfirmedAt ?? null,
        item.lastConfirmedSessionId ?? null,
        item.supersedesId ?? null,
      );
  }
  for (const a of data.audits) {
    memory
      .prepare("INSERT INTO knowledge_audit VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.id, a.knowledgeId, a.projectId, a.action, JSON.stringify(a.fields), a.occurredAt);
    if (a.feedbackKind) {
      memory
        .prepare("INSERT INTO knowledge_feedback VALUES (?, ?, ?, NULL, ?, ?)")
        .run(a.id, a.knowledgeId, a.projectId, a.feedbackKind, a.occurredAt);
    }
  }
  memory.prepare("INSERT INTO session_links VALUES ('l1', 'sid-zq-touch-b', 'sid-zq-source')").run();
  memory.exec("BEGIN");
  const loaded = loadData(memory);
  memory.exec("ROLLBACK");
  memory.close();
  assert.equal(loaded.sessions.length, data.sessions.length);
  assert.equal(loaded.decisions.length, 5);
  assert.equal(loaded.decisions[0].origin, "unspecified");
  assert.equal(loaded.audits.find((a) => a.id === "aid-4").feedbackKind, "applied");
  assert.equal(analyzeKnowledge(loaded).baselinePossiblyStale, 4);
  assert.deepEqual(analyzeAudits(loaded.audits).byAction, audit.byAction);
  console.log("self-check passed");
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------
function flagValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function printReveal(analysis, sample) {
  console.error(
    "REVEAL: record text follows. Local data owner only; do not paste, attach or send this output anywhere.",
  );
  for (const pick of sample.picks) {
    const item = analysis.candidates[pick.index];
    const earlier = item.matches[0];
    console.log(`--- pair #${pick.index} score=${pick.score} cue=${pick.cue}`);
    console.log(`earlier (${earlier.decision.completedAt}): ${earlier.decision.text}`);
    console.log(`later   (${item.decision.completedAt}): ${item.decision.text}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) {
    selfCheck();
    return;
  }
  const valueFlags = new Set(["--threshold", "--sample", "--seed"]);
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1]));
  const databasePath = resolve(positional[0] ?? DEFAULT_DATABASE);
  const sampleSize = Number(flagValue(args, "--sample", 0)) || 0;
  const seed = Number(flagValue(args, "--seed", 1)) || 1;
  const reveal = args.includes("--reveal");
  if (reveal && sampleSize === 0) throw new Error("--reveal needs --sample N.");
  const threshold = Number(flagValue(args, "--threshold", DEFAULT_SAMPLE_THRESHOLD));
  const thresholds = [...new Set([...DEFAULT_THRESHOLDS, threshold])].sort((a, b) => a - b);
  let termsOf = builtinTerms;
  let tokenizer = "builtin";
  if (args.includes("--dist-tokenizer")) {
    try {
      const module = await import(
        pathToFileURL(resolve(new URL("../../packages/storage/dist/search-text.js", SELF_URL).pathname)).href
      );
      termsOf = (text) =>
        module
          .parseQueryWords(String(text))
          .flatMap((word) => word.terms)
          .filter((term) => !/^\d+$/.test(term));
      tokenizer = "dist";
    } catch {
      tokenizer = "builtin (dist missing)";
    }
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let data;
  try {
    db.exec("BEGIN");
    data = loadData(db);
  } finally {
    db.close();
  }
  const { report, decisionAnalysis } = buildReport(data, {
    thresholds,
    sampleThreshold: threshold,
    sample: sampleSize,
    seed,
    termsOf,
    pathHitReplay: args.includes("--path-hit-replay"),
  });
  console.log(JSON.stringify({ tokenizer, ...report }, null, 2));
  if (reveal) printReveal(decisionAnalysis, report.decisionSupersession.sample);
}

await main();
