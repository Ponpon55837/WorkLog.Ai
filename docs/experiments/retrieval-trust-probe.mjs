// Retrieval trust probe (research experiment, read-only for the source database).
//
// Usage (run from the repository root after `pnpm build`; packages/storage/dist must exist):
//   node docs/experiments/retrieval-trust-probe.mjs <database> [--sample N] [--seed S] [--sections 1,2,3,4,5]
//        [--hub-share 0.2] [--context-sample N] [--related-sample N] [--pair-sample N] [--window-pair-sample N]
//        [--hotspot-limit N] [--treat-all-tracked]
//   WORK_INTELLIGENCE_DB=<database> node docs/experiments/retrieval-trust-probe.mjs
//   node docs/experiments/retrieval-trust-probe.mjs --self-check          (synthetic data only, fictional names)
//
// The database path is the first positional argument or the env WORK_INTELLIGENCE_DB; there is no default path.
//
// Safety. The source database is opened with `readOnly: true`, copied with VACUUM INTO (fallback: file copy of the
// database and its -wal) into a fresh 0700 directory under the OS temp dir, and closed. Everything else (the store,
// its migrations, its search-index sync) runs on the copy only. The directory is deleted in `finally`, also on error.
//
// Output contract. One JSON document on stdout of AGGREGATES ONLY: counts, ratios, percentiles, histograms and
// booleans. It never prints a title, body, summary, path, path fragment, project name, Session or Knowledge id, query
// text or error message from the data. Path categories are fixed labels defined in this file (lockfile, changelog,
// manifest, status_doc, version_file, other). Errors print only an error code or class name (stderr, exit 1). Before
// printing, a leak scan checks the output for every id, title, project name, project root and changed-file path read
// from the database (strings of 8+ characters that are not themselves fixed output labels); a hit exits 2 with no
// output. Sampling is deterministic: --sample N (default 200) with --seed S (default 1), mulberry32.
//
// Sections (--sections filters; default all):
//   1 answerability: sampled non-voided Session titles (path-like tokens removed) as queries, recall scoped to the
//     Session's project, limit 8, the Session's own hit excluded. Variants base / plus1 / plus2 / plus3 add that many
//     nonsense tokens to the title (unknown-word dilution; plus2 is the "half-off" control); `nonsenseOnly` is three
//     nonsense tokens alone. Also the Agent Knowledge search (match, otherStatusMatches) and getContext on a smaller
//     sample (top-level keys, relevant counts, supplement kinds).
//   2 producedBy: matchedIn combinations, matchedPaths share, how often matchedIn has more than one element (the MCP
//     work_recall trims it to the first), synonymOnlyDetectable (false: the response does not say), getContext
//     includedBecause kinds.
//   3 hubs: files touched by many Sessions, per project and pooled, and their effect on related work, graph paths,
//     hotspots, possiblyStale and the derived graph. A hub is a path touched by >= --hub-share of a project's
//     Sessions that have changed files (and at least 5 Sessions) for the impact measures.
//   4 protection: confirmed Knowledge, manual confirmations, rolled back baselines, supersede conflicts.
//   5 health: orphaned / unscoped / dangling Knowledge, Knowledge Pages needing review, search_dirty rows.
// Note: the store's retrieval calls sync the search index on the copy, so search_dirty is counted on the source first.
//
// Additions (all new output keys; existing keys are unchanged):
//   Policy. `warnings: ["no_tracked_projects"]` (plus a fixed stderr line) when no project is tracked. With
//     --treat-all-tracked (recorded as options.treatAllTracked), the TEMP COPY ONLY gets every project set to status
//     'tracked' and root_path set to a fresh empty directory (temp/root-<index>) before the store opens; the source is
//     never touched.
//   Section 1 answerability.pastOnly: the same sampled queries, recall with `to` = the calendar day BEFORE the query
//     Session's start (started_at, else completed_at, else created_at; local time zone like the product), limit 8. It
//     approximates "the Agent asks before this work existed". Confidence, termHitsPresentShare, zeroTermFraction,
//     hit histogram and hits by type, and the count of queries with 0 Knowledge hits but confidence high. The queries
//     are then split into positives (the query Session reported Knowledge as applied, kind 'applied', and that
//     Knowledge was created before the Session started) and negatives (no such row): n, confidence, share with >= 1
//     Knowledge hit, hit@8 of a truth Knowledge (positives only) and the Knowledge hit-count histogram. Known product
//     behaviour: appliesTo (path) matching ignores `to`, so a later Knowledge could leak in via paths; the queries
//     here carry no paths.
//   Section 1 answerability.knowledgeSearchQuality: the Agent Knowledge search (status active) already run per query,
//     restricted to queries whose Session has truth Knowledge (active Knowledge with knowledge.session_id = the
//     Session, or applied feedback by the Session). Per match type (strict / relaxed / none): n, hit@1 and hit@3 of a
//     truth Knowledge among items (strict) or relaxedMatches (relaxed). Also the coverage of the top relaxed match
//     (matchedTerms / distinct query terms; `tokenizer` names how terms are counted) and the distinct-query-term
//     histogram, which shows strict AND matching on long titles.
//   Section 1 answerability.positiveRecallBounds: the SAME positives/negatives split as pastOnly (and only queries that
//     reached that split, so positives.n and negatives.n equal pastOnly's). pastOnly's `to` filters Knowledge by
//     updated_at, so truth Knowledge updated after the Session (a later manual confirm or edit) is excluded and the
//     pastOnly hit@8 is a lower bound. `noDateFilter`: the same recall without `to` (limit 8, which is the base call, and
//     a limit 20 variant), own hit excluded: n, confidence, share with >= 1 Knowledge hit, positives hit@8 / hit@20.
//     `truthUpdatedAfterStart`: positives whose truth Knowledge (applied, created before the start) has updated_at >
//     the Session's start (all of them = invisible to pastOnly; any of them). `getContextTaskOnly`: store.getContext
//     with { task: query } exactly like the getContext sample (projectRoot given, so the product's P5 inferred-path
//     supplements apply) for every positive and the first 50 negatives in sample order. Positives: a truth Knowledge in
//     relevant.knowledge, in relevant.supplements (tally by includedBecause kind), only in recentKnowledge, or nowhere;
//     negatives: share with relevant.knowledge, share with supplements; relevant.confidence for both. NOT time-sliced:
//     the query Session itself is in the index, so relevant.sessions may include it (and its own applied feedback may
//     surface its Knowledge as an applied_knowledge supplement), which favours the positives.
//   Section 3 impact.graphPath: classification {endpointOutsideRange, noPath, found}, decided by building the same
//     bounded graph (store.getGraph, maxNodes 500, maxEdges 1000) and checking the two node ids, never by the reason
//     text. `inWindowPairs` samples only the project's newest 50 non-voided Sessions (completed_at DESC), with the
//     same classification, hop histogram and hub-intermediate share. `pathGraph` reports how many session nodes the
//     path-search graph holds, how many of the newest 50 made it in, and whether nodes/edges were truncated.
//   Section 3 impact.hotspots: byRank (categories of the top 10 per rank, counts only) and top10SessionShare (each
//     top-10 hotspot's Sessions / the project's Sessions with changed files).
//   Section 4 protection.stalenessCounterfactuals: on SECOND temp copies (VACUUM INTO of the first copy, deleted in
//     the same run) the variants baseline, excludeOver20 (changed_files_json = '[]' for Sessions with more than 20
//     changed files), excludeHubs (hub paths removed from every Session) and both; a new store instance per variant
//     (staleness reads sessions.changed_files_json directly). Reports activeWithAppliesTo, possiblyStale,
//     confirmedAndPossiblyStale, manualConfirmAndPossiblyStale and the possiblyStale sessionCount distribution, plus
//     possiblyStaleTriggerSessionCount (how many later Sessions touched each stale Knowledge) for the baseline.
//     `staleDroppedByCap`: the Knowledge possiblyStale in baseline but not in excludeOver20 (the over-20-files cap
//     removed their only triggers): n and a histogram of the changed-file count (21-50, 51-100, 101-300, 301+) of
//     the Session that baseline reports in possiblyStale.sessionId (an approximation: other >20-file triggers of the
//     same Knowledge are not recomputed; `method` says so in the output).
//   Section 1 answerability.pathRecallBaseline: the SAME positives as pastOnly (and up to 50 negatives in sample order),
//     asked with `store.getContext(project.root, { task: query, paths })` where `paths` are the query Session's own
//     changed files, first 20, as stored. Per positive: `truthHasAppliesTo` (any truth Knowledge has appliesTo) and
//     `truthCoversSessionFiles` (the product matcher appliesToStrength > 0 for a normalized Session file against a
//     truth Knowledge's appliesTo: "findable if the Agent passed the right paths"). Then where a truth Knowledge shows
//     up: relevant.knowledge, supplements (tally by includedBecause kind), recentKnowledge only, nowhere, also split by
//     truthCoversSessionFiles. Negatives: share with >= 1 relevant.knowledge. relevant.confidence distributions, and
//     `relevantKnowledgeEmpty` (share of responses with an empty relevant.knowledge, the knowledge-only signal). NOT
//     time-sliced; the paths are the Session's own FINAL changed files, an upper bound of what an Agent knows at start.
//   Section 4 protection.appliesToBreadth: for each active Knowledge with appliesTo, breadth = share of the project's
//     non-voided Sessions with changed files whose changed files (any) are covered (appliesToStrength > 0, paths
//     normalized like section 3) by any of its appliesTo entries; `breadthFocused` is the same over only Sessions with
//     <= 20 changed files. Reports the distribution (buckets 0, (0,0.05], (0.05,0.1], (0.1,0.2], (0.2,0.4], (0.4,1];
//     p50/p90/max) for all, by baseline possiblyStale yes/no, and for possiblyStale by trigger-session-count bucket
//     (1, 2-9, 10+; possiblyStale.sessionCount of the baseline variant). Also the count with breadthFocused >= 0.1 and
//     >= 0.2 and how many of those are possiblyStale in baseline and in excludeOver20, and per-entry breadth:
//     `broadEntries` (share of appliesTo entries whose own breadth >= 0.1) and Knowledge with >= 1 broad entry.
//
// Response-shape measures (all new output keys; every field is read defensively, a missing field on an older build is
// counted as "(absent)" or 0 so the same probe runs before and after the product change; `productShape` records
// booleans about the build it ran against):
//   Section 1 answerability: `knowledgeConfidence` (none/low/high over Knowledge hits only) next to every existing
//     `confidence` distribution: base queries, pastOnly (all, positives, negatives), positiveRecallBounds (noDateFilter
//     groups and getContext positives/negatives as relevantKnowledgeConfidence) and pathRecallBaseline; the getContext
//     sample's `relevantKnowledgeConfidence`. Cross counts: queries with 0 Knowledge hits but confidence high, split by
//     knowledgeConfidence (`zeroKnowledgeHitsButHighConfidence`; getContext `zeroKnowledgeButHighConfidenceShare`),
//     and knowledgeConfidence none although Knowledge hits exist (`knowledgeConfidenceNoneWithKnowledgeHits`).
//     `knowledgeHint` is counted per getContext response (`knowledgeHintResponses`, `knowledgeHintShare`) and
//     `termHitsTruncated` per query / response. knowledgeSearch.fallbackTermHits: for Agent Knowledge searches that
//     fell back (match relaxed or none), the share carrying termHits and the share whose words are ALL 0, also for
//     `none` alone; `termHitsTruncatedAnswers`.
//   Section 2 producedBy: `matchedVia: "synonym"` (synonymOnlyHits / share / by type; synonymOnlyDetectable is true
//     when the responses carry the new recall shape), `matchedInLengthHistogram` (store level, before the MCP trim; the
//     MCP work_recall now keeps up to 4 fields, so `matchedInOverMcpLimitShare` is the share with 5+), the share of
//     Knowledge hits and getContext Knowledge items that are possiblyStale / staleReason broad_applies_to / carry
//     broadChangesSince.
//   Section 4 protection.stalenessShape (first copy = baseline): over active Knowledge with appliesTo, possiblyStale
//     count and `possiblyStaleReason` (applies_to_changed / broad_applies_to), `withBroadChangesSince` with its
//     summary, `broadChangesSinceOnly` (broadChangesSince > 0 and no possiblyStale), the possiblyStale
//     `appliesToBreadth` share and sessions (summary and buckets), confirmed and manually confirmed possiblyStale
//     (also by reason). The same fields are in each stalenessCounterfactuals variant; with the broad-Session split
//     excludeOver20 should be close to the baseline (`differenceFromBaseline` counts the ids on either side only).
//   Section 4 protection.writeTimeBreadth: the product's read-only scanAppliesToBreadth (loaded from
//     packages/storage/dist/knowledge-breadth.js; if the build does not export it the key says `available: false`) run
//     on the temp copy for every active Knowledge with appliesTo: share distribution, Sessions compared, broad count
//     (share > 0.15 over >= 10 Sessions), truncated and unchecked counts, and the overlap of broad with baseline
//     possiblyStale and with reason broad_applies_to. It estimates the width as of NOW over the project's newest
//     focused Sessions, not as of the day the Knowledge was written. Nothing is written to any database.
import assert from "node:assert/strict";
import console from "node:console";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync, backup } from "node:sqlite";

const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
const searchText = await import("../../packages/storage/dist/search-text.js");
const { normalizePath } = searchText;
const { appliesToStrength } = await import("../../packages/storage/dist/applies-to-match.js");
// Read-only breadth scan of the product (absent in older builds; the probe then skips the write-time width estimate).
const breadthModule = await import("../../packages/storage/dist/knowledge-breadth.js").catch(() => undefined);
const scanAppliesToBreadth = typeof breadthModule?.scanAppliesToBreadth === "function" ? breadthModule.scanAppliesToBreadth : undefined;
const TOKENIZER = typeof searchText.parseQueryWords === "function" ? "parseQueryWords" : "whitespace_lowercase";
/** Distinct query terms, counted the way the store parses a query when it can. */
const distinctTerms = (query) =>
  new Set(
    typeof searchText.parseQueryWords === "function"
      ? searchText.parseQueryWords(query).flatMap((word) => word.terms)
      : query.toLowerCase().split(/\s+/u).filter(Boolean),
  );

const ALL_SECTIONS = ["1", "2", "3", "4", "5"];
const VALUE_FLAGS = [
  "--sample",
  "--seed",
  "--hub-share",
  "--sections",
  "--context-sample",
  "--related-sample",
  "--pair-sample",
  "--window-pair-sample",
  "--hotspot-limit",
];
const PATH_WINDOW_SESSIONS = 50;
const RECALL_LIMIT = 8;
const NEGATIVE_CONTEXT_SAMPLE = 50;
const MIN_HUB_SESSIONS = 5;
const BROAD_FILES = 20;
const MIN_LEAK_LENGTH = 8;
const MAX_PROJECT_ROWS = 25;
const MAX_PROJECT_CALLS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const bump = (object, key, by = 1) => {
  object[key] = (object[key] ?? 0) + by;
};
const ratio = (numerator, denominator) => (denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null);

function summary(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 1e4) / 1e4;
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1], mean: Math.round(mean * 100) / 100 };
}

const errorClass = (error) => {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  const name = error && typeof error === "object" ? error.constructor?.name : undefined;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "UnknownError";
};

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.includes(args[i])) i += 1;
    else if (!args[i].startsWith("--")) return args[i];
  }
  return undefined;
}

function intFlag(args, name, fallback) {
  const raw = flagValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw Object.assign(new Error("flag"), { code: "BAD_FLAG" });
  return value;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const tick = () => {
  const start = Date.now();
  do Atomics.wait(sleepCell, 0, 0, 2);
  while (Date.now() <= start);
};

// ---------------------------------------------------------------------------------------------------------------
// Query construction (no database text leaves this process)
// ---------------------------------------------------------------------------------------------------------------
/** A title without path-like tokens: anything with a slash or a file extension is dropped. */
function cleanTitle(title) {
  return title
    .split(/\s+/u)
    .filter((token) => token && !/[\\/]/u.test(token) && !/\.[a-z0-9]{1,6}\W*$/iu.test(token))
    .join(" ")
    .slice(0, 400)
    .trim();
}

const NONSENSE_ALPHABET = "bcdfghjklmnpqrstvwxzqxzjk";
function nonsenseToken(rng) {
  const length = 6 + Math.floor(rng() * 3);
  let token = "";
  for (let i = 0; i < length; i += 1) token += NONSENSE_ALPHABET[Math.floor(rng() * NONSENSE_ALPHABET.length)];
  return `${token}${Math.floor(rng() * 90) + 10}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Hub path categories (fixed rules on the normalized, lower-cased path)
// ---------------------------------------------------------------------------------------------------------------
function category(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (
    ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "cargo.lock", "poetry.lock", "go.sum"].includes(base) ||
    base.endsWith(".lock")
  )
    return "lockfile";
  if (base.startsWith("changelog") || base.startsWith("history") || path.startsWith("docs/releases/")) return "changelog";
  if (["package.json", "cargo.toml", "pyproject.toml", "go.mod"].includes(base)) return "manifest";
  if (path === "docs/status.md" || base.startsWith("readme")) return "status_doc";
  if (base === "version" || base === "version.ts" || base === "version.json") return "version_file";
  return "other";
}

// ---------------------------------------------------------------------------------------------------------------
// Database copy
// ---------------------------------------------------------------------------------------------------------------
async function copyDatabase(sourcePath, directory) {
  const copyPath = join(directory, "copy.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let searchDirty;
  try {
    try {
      searchDirty = source.prepare("SELECT COUNT(*) AS c FROM search_dirty").get().c;
    } catch {
      searchDirty = null;
    }
    try {
      source.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
      return { copyPath, method: "vacuum_into", searchDirty };
    } catch {
      try {
        await backup(source, copyPath);
        return { copyPath, method: "backup_api", searchDirty };
      } catch {
        // Last resort: plain file copies (database plus WAL); the copy is migrated and read like any other.
      }
    }
  } finally {
    source.close();
  }
  copyFileSync(sourcePath, copyPath);
  if (existsSync(`${sourcePath}-wal`)) copyFileSync(`${sourcePath}-wal`, `${copyPath}-wal`);
  return { copyPath, method: "file_copy", searchDirty };
}

/** Temp copy only: every project becomes tracked with its own fresh empty root directory inside the temp dir. */
function treatAllTracked(copyPath, directory) {
  const base = realpathSync(directory);
  const db = new DatabaseSync(copyPath);
  try {
    const ids = db.prepare("SELECT id FROM projects ORDER BY id").all();
    // Move the unique roots out of the way first, then assign the final ones.
    db.exec("BEGIN");
    const update = db.prepare("UPDATE projects SET status = 'tracked', root_path = ? WHERE id = ?");
    ids.forEach((row, index) => {
      const root = join(base, `root-${index}`);
      mkdirSync(root, { recursive: true });
      update.run(root, row.id);
    });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** The local calendar day before a timestamp, as YYYY-MM-DD (local time zone, like the product). */
function dayBefore(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const before = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  return `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, "0")}-${String(before.getDate()).padStart(2, "0")}`;
}

/** Active Knowledge of the given projects with the staleness fields the probe reads. */
function loadActiveKnowledge(someStore, projectList) {
  const items = [];
  for (const project of projectList) {
    for (let page = 1, pages = 1; page <= pages; page += 1) {
      const result = someStore.searchKnowledge({ projectId: project.id, status: "active", page, pageSize: 200 });
      if (result.outcome !== "knowledge") break;
      pages = result.pageInfo.totalPages;
      for (const item of result.items) {
        items.push({
          id: item.id,
          projectId: item.projectId,
          appliesTo: item.appliesTo.length,
          lastConfirmedAt: item.lastConfirmedAt,
          confirmed: item.evidence?.confirmed ?? 0,
          unchecked: item.stalenessUnchecked === true,
          // Absent on builds without the broad-Session split (counted as 0 / "(absent)").
          broadChangesSince: typeof item.broadChangesSince === "number" ? item.broadChangesSince : 0,
          stale: item.possiblyStale
            ? {
                paths: item.possiblyStale.paths,
                sessionId: item.possiblyStale.sessionId,
                completedAt: item.possiblyStale.completedAt,
                sessionCount: item.possiblyStale.sessionCount,
                reason: enumValue(item.possiblyStale.reason),
                breadth:
                  item.possiblyStale.appliesToBreadth && typeof item.possiblyStale.appliesToBreadth.share === "number"
                    ? { share: item.possiblyStale.appliesToBreadth.share, sessions: item.possiblyStale.appliesToBreadth.sessions }
                    : undefined,
              }
            : undefined,
        });
      }
    }
  }
  return items;
}

/** A response field that may be missing on an older build: its enum value, else "(absent)". */
const enumValue = (value) => (typeof value === "string" && /^[a-z_]{1,32}$/u.test(value) ? value : "(absent)");
const countBucket = (count) => (count === 0 ? "0" : count <= 2 ? "1-2" : count <= 5 ? "3-5" : "6+");
const termBucket = (count) => (count <= 2 ? "1-2" : count <= 4 ? "3-4" : count <= 6 ? "5-6" : count <= 9 ? "7-9" : "10+");

/** A second temp copy (VACUUM INTO of the first copy) with the changed-file lists of Sessions edited. */
function writeStalenessVariant(copyPath, targetPath, { over20, hubs }, hubSets, projectById) {
  const source = new DatabaseSync(copyPath);
  try {
    source.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  if (!over20 && !hubs) return;
  const writer = new DatabaseSync(targetPath);
  try {
    writer.exec("BEGIN");
    if (over20) {
      writer.exec(
        `UPDATE sessions SET changed_files_json = '[]' WHERE json_valid(changed_files_json)
           AND json_type(changed_files_json) = 'array' AND json_array_length(changed_files_json) > ${BROAD_FILES}`,
      );
    }
    if (hubs) {
      const update = writer.prepare("UPDATE sessions SET changed_files_json = ? WHERE id = ?");
      for (const row of writer.prepare("SELECT id, project_id, changed_files_json FROM sessions").all()) {
        const project = projectById.get(row.project_id);
        const hubSet = hubSets.get(row.project_id);
        if (!project || !hubSet || hubSet.size === 0) continue;
        let files;
        try {
          files = JSON.parse(row.changed_files_json);
        } catch {
          continue;
        }
        if (!Array.isArray(files)) continue;
        const kept = files.filter(
          (file) => !(typeof file === "string" && hubSet.has(normalizePath(file, project.context))),
        );
        if (kept.length !== files.length) update.run(JSON.stringify(kept), row.id);
      }
    }
    writer.exec("COMMIT");
  } finally {
    writer.close();
  }
}

/** Aggregates of the staleness fields of active Knowledge with appliesTo (enum strings and numbers only). */
function stalenessShape(items, manualIds) {
  const withApplies = items.filter((item) => item.appliesTo > 0);
  const stale = withApplies.filter((item) => item.stale);
  const reasons = {};
  const confirmedReasons = {};
  for (const item of stale) {
    bump(reasons, item.stale.reason);
    if (item.lastConfirmedAt || item.confirmed > 0) bump(confirmedReasons, item.stale.reason);
  }
  const broad = withApplies.filter((item) => item.broadChangesSince > 0);
  const breadths = stale.map((item) => item.stale.breadth).filter(Boolean);
  const shareBuckets = { "(0,0.1]": 0, "(0.1,0.15]": 0, "(0.15,0.3]": 0, "(0.3,0.6]": 0, "(0.6,1]": 0, "0": 0 };
  for (const breadth of breadths) {
    bump(
      shareBuckets,
      breadth.share <= 0 ? "0" : breadth.share <= 0.1 ? "(0,0.1]" : breadth.share <= 0.15 ? "(0.1,0.15]" : breadth.share <= 0.3 ? "(0.15,0.3]" : breadth.share <= 0.6 ? "(0.3,0.6]" : "(0.6,1]",
    );
  }
  return {
    activeWithAppliesTo: withApplies.length,
    possiblyStale: stale.length,
    possiblyStaleReason: reasons,
    withBroadChangesSince: broad.length,
    broadChangesSince: summary(broad.map((item) => item.broadChangesSince)),
    broadChangesSinceOnly: broad.filter((item) => !item.stale).length,
    possiblyStaleAlsoWithBroadChangesSince: broad.filter((item) => item.stale).length,
    possiblyStaleAppliesToBreadth: {
      present: breadths.length,
      absent: stale.length - breadths.length,
      shareBuckets,
      share: summary(breadths.map((breadth) => breadth.share)),
      sessions: summary(breadths.map((breadth) => breadth.sessions)),
    },
    confirmedAndPossiblyStale: stale.filter((item) => item.lastConfirmedAt || item.confirmed > 0).length,
    confirmedAndPossiblyStaleReason: confirmedReasons,
    manualConfirmAndPossiblyStale: stale.filter((item) => manualIds.has(item.id)).length,
    possiblyStaleSessionCount: summary(stale.map((item) => item.stale.sessionCount ?? 0)),
    stalenessUnchecked: withApplies.filter((item) => item.unchecked).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------
function analyze(store, raw, options, sourceInfo) {
  const rng = mulberry32(options.seed);
  const sections = options.sections;
  const known = new Set(); // strings from the database that must never appear in the output
  const remember = (value) => {
    if (typeof value === "string" && value.length >= MIN_LEAK_LENGTH) known.add(value);
  };

  const projects = raw
    .prepare("SELECT id, name, root_path FROM projects WHERE status = 'tracked' ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      root: row.root_path,
      context: [{ name: row.name, rootPath: row.root_path }],
    }));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    remember(project.id);
    remember(project.name);
    remember(project.root);
  }
  for (const row of raw.prepare("SELECT id, title, changed_files_json FROM sessions").all()) {
    remember(row.id);
    remember(row.title);
    try {
      const files = JSON.parse(row.changed_files_json);
      if (Array.isArray(files)) {
        for (const file of files) remember(typeof file === "string" ? file.trim() : undefined);
      }
    } catch {
      // Malformed rows are counted below.
    }
  }
  for (const row of raw.prepare("SELECT id, title FROM knowledge").all()) {
    remember(row.id);
    remember(row.title);
  }

  const pool = raw
    .prepare(
      `SELECT s.id, s.project_id FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.status = 'tracked' AND s.voided_at IS NULL ORDER BY s.id`,
    )
    .all();
  const titles = new Map(
    raw
      .prepare(
        `SELECT s.id, s.title FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
      )
      .all()
      .map((row) => [row.id, row.title]),
  );
  const sample = shuffled(pool, rng).slice(0, options.sample);
  // Ground-truth lookups for the past-only recall and Knowledge search quality measures (ids never printed).
  const sessionStart = new Map(
    raw
      .prepare(
        `SELECT s.id, s.started_at, s.completed_at, s.created_at FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
      )
      .all()
      .map((row) => [row.id, row.started_at || row.completed_at || row.created_at]),
  );
  const knowledgeMeta = new Map(
    raw
      .prepare("SELECT id, status, created_at, updated_at, session_id FROM knowledge")
      .all()
      .map((row) => [row.id, row]),
  );
  const appliedBySession = new Map();
  for (const row of raw
    .prepare("SELECT session_id, knowledge_id FROM knowledge_feedback WHERE kind = 'applied' AND session_id IS NOT NULL")
    .all()) {
    if (!appliedBySession.has(row.session_id)) appliedBySession.set(row.session_id, new Set());
    appliedBySession.get(row.session_id).add(row.knowledge_id);
  }
  const authoredBySession = new Map();
  for (const row of knowledgeMeta.values()) {
    if (!row.session_id) continue;
    if (!authoredBySession.has(row.session_id)) authoredBySession.set(row.session_id, new Set());
    authoredBySession.get(row.session_id).add(row.id);
  }
  const report = {
    probe: "retrieval-trust",
    options: {
      sample: options.sample,
      seed: options.seed,
      hubShare: options.hubShare,
      sections: [...sections],
      copyMethod: sourceInfo.method,
      treatAllTracked: options.treatAllTracked === true,
    },
    counts: { trackedProjects: projects.length, nonVoidedSessions: pool.length, sampled: sample.length },
    // Which product build this ran against (booleans only): lets a before/after pair be told apart.
    productShape: {
      scanAppliesToBreadthExported: scanAppliesToBreadth !== undefined,
    },
  };
  if (projects.length === 0) {
    report.warnings = ["no_tracked_projects"];
    process.stderr.write("warning: no tracked projects; every section is empty (see --treat-all-tracked)\n");
  }

  // ---- shared lazily computed data --------------------------------------------------------------------------
  let hubData;
  const hubs = () => {
    if (hubData) return hubData;
    const perProject = new Map();
    let broad = 0;
    for (const row of raw
      .prepare(
        `SELECT s.id, s.project_id, s.changed_files_json FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
      )
      .all()) {
      const project = projectById.get(row.project_id);
      let files = [];
      try {
        const parsed = JSON.parse(row.changed_files_json);
        if (Array.isArray(parsed)) files = parsed;
      } catch {
        files = [];
      }
      if (files.length > BROAD_FILES) broad += 1;
      const paths = new Set(
        files.filter((file) => typeof file === "string").map((file) => normalizePath(file, project.context)).filter(Boolean),
      );
      if (paths.size === 0) continue;
      let entry = perProject.get(row.project_id);
      if (!entry) {
        entry = { sessions: 0, counts: new Map() };
        perProject.set(row.project_id, entry);
      }
      entry.sessions += 1;
      for (const path of paths) entry.counts.set(path, (entry.counts.get(path) ?? 0) + 1);
    }
    const sets = new Map();
    for (const [projectId, entry] of perProject) {
      const set = new Set();
      for (const [path, count] of entry.counts) {
        if (count >= MIN_HUB_SESSIONS && count / entry.sessions >= options.hubShare - 1e-9) set.add(path);
      }
      sets.set(projectId, set);
    }
    hubData = { perProject, sets, broad };
    return hubData;
  };

  // Non-voided Session changed files of tracked projects: stored strings, normalized unique paths (read once).
  let sessionFilesData;
  const sessionFiles = () => {
    if (sessionFilesData) return sessionFilesData;
    sessionFilesData = new Map();
    for (const row of raw
      .prepare(
        `SELECT s.id, s.project_id, s.changed_files_json FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
      )
      .all()) {
      const project = projectById.get(row.project_id);
      let stored = [];
      try {
        const parsed = JSON.parse(row.changed_files_json);
        if (Array.isArray(parsed)) stored = parsed.filter((file) => typeof file === "string");
      } catch {
        stored = [];
      }
      const paths = new Set(stored.map((file) => normalizePath(file, project.context)).filter(Boolean));
      sessionFilesData.set(row.id, { projectId: row.project_id, stored, paths, count: stored.length });
    }
    return sessionFilesData;
  };
  // Stored appliesTo entries per Knowledge id (normalized like the product does before matching).
  let appliesToData;
  const appliesToOf = (id) => {
    if (!appliesToData) {
      appliesToData = new Map();
      for (const row of raw
        .prepare(
          `SELECT k.id, k.project_id, k.applies_to_json FROM knowledge k JOIN projects p ON p.id = k.project_id
           WHERE p.status = 'tracked'`,
        )
        .all()) {
        let entries = [];
        try {
          const parsed = JSON.parse(row.applies_to_json);
          if (Array.isArray(parsed)) entries = parsed.filter((entry) => typeof entry === "string");
        } catch {
          entries = [];
        }
        const context = projectById.get(row.project_id)?.context;
        appliesToData.set(row.id, context ? entries.map((entry) => normalizePath(entry, context)).filter(Boolean) : []);
      }
    }
    return appliesToData.get(id) ?? [];
  };
  const entryCovers = (entry, path) => appliesToStrength(entry, path) > 0;

  let knowledgeData;
  const activeKnowledge = () => {
    if (knowledgeData) return knowledgeData;
    knowledgeData = loadActiveKnowledge(store, projects);
    return knowledgeData;
  };

  // ---- sections 1 and 2: retrieval pass ---------------------------------------------------------------------
  if (sections.has("1") || sections.has("2")) {
    const recallOne = (root, q, selfId, range = {}) => {
      const result = store.recall({ q, projectRoot: root, limit: RECALL_LIMIT, ...range });
      if (result.outcome !== "recall") return undefined;
      const hits = result.hits ?? [];
      return {
        confidence: result.confidence,
        knowledgeConfidence: enumValue(result.knowledgeConfidence),
        termHitsTruncated: result.termHitsTruncated === true,
        termHits: result.termHits,
        hits,
        nonSelf: hits.filter((hit) => !(hit.type === "session" && hit.id === selfId)),
      };
    };
    const flagsAll = (outcome, tokens) =>
      tokens.every((token) =>
        (outcome.termHits ?? []).some((entry) => entry.term.toLowerCase() === token && entry.count === 0),
      );
    const variantNames = ["base", "plus1", "plus2", "plus3"];
    const variants = Object.fromEntries(
      variantNames.map((name) => [
        name,
        { queries: 0, confidence: {}, nonSelfHitsZero: 0, termHitsFlagAll: 0, droppedByUnknownTerms: 0, lostAllNonSelf: 0 },
      ]),
    );
    const nonsenseOnly = { queries: 0, confidence: {}, noHits: 0, allTermsZero: 0 };
    const base = {
      queries: 0,
      skippedEmptyQuery: 0,
      skippedByPolicy: 0,
      errors: {},
      confidence: {},
      knowledgeConfidence: {},
      termHitsTruncated: 0,
      zeroKnowledgeHitsButHigh: 0,
      zeroKnowledgeHitsButHighByKnowledgeConfidence: {},
      knowledgeConfidenceNoneWithKnowledgeHits: 0,
      termHitsPresent: 0,
      zeroTermFraction: { buckets: {}, values: [] },
      nonSelfHistogram: { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 },
      hits: 0,
      pathOnlyHits: 0,
      highWithoutNonSelf: 0,
    };
    const produced = {
      hits: 0,
      byType: {},
      matchedInCombos: {},
      matchedInMultiple: 0,
      matchedInLength: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, "5+": 0 },
      withMatchedPaths: 0,
      synonymHits: 0,
      synonymHitsByType: {},
      knowledgeHits: 0,
      knowledgeHitsPossiblyStale: 0,
      knowledgeHitsBroadStaleReason: 0,
      knowledgeHitsWithBroadChanges: 0,
      knowledgeConfidenceResponses: 0,
    };
    const knowledgeSearch = {
      queries: 0,
      skipped: 0,
      errors: {},
      match: {},
      otherStatusMatchesPresent: 0,
      fallbackAnswers: 0,
      noneAnswers: 0,
      termHitsOnFallback: 0,
      termHitsOnNone: 0,
      allTermsZeroOnNone: 0,
      allTermsZeroOnFallback: 0,
      termHitsTruncated: 0,
    };
    const context = {
      responses: 0,
      skipped: 0,
      errors: {},
      topLevelKeys: {},
      relevantKeys: {},
      relevantConfidence: {},
      relevantKnowledgeConfidence: {},
      knowledgeHintResponses: 0,
      knowledgeHintWithKnowledge: 0,
      zeroKnowledgeButHigh: 0,
      zeroKnowledgeButHighByKnowledgeConfidence: {},
      termHitsTruncated: 0,
      knowledgeItems: 0,
      knowledgeItemsPossiblyStale: 0,
      knowledgeItemsBroadStaleReason: 0,
      knowledgeItemsWithBroadChanges: 0,
      knowledgeCount: { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 },
      sessionCount: { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 },
      zeroRelevant: 0,
      supplementKinds: {},
      responsesWithSupplements: 0,
    };
    const bucket = countBucket;
    const newGroup = () => ({
      n: 0,
      confidence: {},
      knowledgeConfidence: {},
      withKnowledgeHit: 0,
      hitAt8: 0,
      knowledgeHitHistogram: { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 },
    });
    const pastOnly = {
      queries: 0,
      skippedNoStart: 0,
      skippedByPolicy: 0,
      errors: {},
      confidence: {},
      knowledgeConfidence: {},
      termHitsTruncated: 0,
      zeroKnowledgeHitsButHighByKnowledgeConfidence: {},
      knowledgeConfidenceNoneWithKnowledgeHits: 0,
      termHitsPresent: 0,
      zeroTermFractionBuckets: {},
      zeroTermFractions: [],
      hitsHistogram: { 0: 0, "1-2": 0, "3-5": 0, "6+": 0 },
      hitsByType: {},
      zeroKnowledgeHitsButHigh: 0,
      positives: newGroup(),
      negatives: newGroup(),
    };
    const newBound = () => ({
      n: 0,
      confidence: {},
      knowledgeConfidence: {},
      withKnowledgeHit: 0,
      hitAt8: 0,
      limit20: { n: 0, hitAt20: 0, withKnowledgeHit: 0 },
    });
    const bounds = {
      errors: {},
      noDate: { positives: newBound(), negatives: newBound() },
      updated: { positives: 0, allAfter: 0, anyAfter: 0, truthRows: 0, truthRowsAfter: 0 },
      negativeContextAttempts: 0,
      ctx: {
        positives: {
          n: 0,
          errors: {},
          skipped: 0,
          confidence: {},
          knowledgeConfidence: {},
          knowledgeHint: 0,
          termHitsTruncated: 0,
          relevantKnowledge: 0,
          supplements: 0,
          supplementKinds: {},
          recentOnly: 0,
          nowhere: 0,
        },
        negatives: {
          n: 0,
          errors: {},
          skipped: 0,
          confidence: {},
          knowledgeConfidence: {},
          knowledgeHint: 0,
          termHitsTruncated: 0,
          withRelevantKnowledge: 0,
          withSupplements: 0,
        },
      },
    };
    const newPathGroup = () => ({
      n: 0,
      errors: {},
      skipped: 0,
      noSessionFiles: 0,
      confidence: {},
      knowledgeConfidence: {},
      knowledgeHint: 0,
      termHitsTruncated: 0,
      relevantKnowledge: 0,
      relevantKnowledgeEmpty: 0,
      supplements: 0,
      supplementKinds: {},
      recentOnly: 0,
      nowhere: 0,
      truthHasAppliesTo: 0,
      truthCoversSessionFiles: 0,
      foundWhenCovered: 0,
      foundWhenNotCovered: 0,
      withSupplements: 0,
    });
    const pathRecall = { negativeAttempts: 0, positives: newPathGroup(), negatives: newPathGroup() };
    const quality = {
      queriesWithTruth: 0,
      byMatch: {
        strict: { n: 0, hitAt1: 0, hitAt3: 0 },
        relaxed: { n: 0, hitAt1: 0, hitAt3: 0 },
        none: { n: 0, hitAt1: 0, hitAt3: 0 },
      },
      relaxedCoverageBuckets: {},
      relaxedCoverageValues: [],
      queryTermsHistogram: {},
      queryTermsByMatch: {},
    };

    const contextLimit = Math.min(options.contextSample, sample.length);
    for (const [index, entry] of sample.entries()) {
      const project = projectById.get(entry.project_id);
      const query = cleanTitle(titles.get(entry.id) ?? "");
      if (!query) {
        base.skippedEmptyQuery += 1;
        continue;
      }
      let baseOutcome;
      try {
        baseOutcome = recallOne(project.root, query, entry.id);
      } catch (error) {
        bump(base.errors, errorClass(error));
        continue;
      }
      if (!baseOutcome) {
        base.skippedByPolicy += 1;
        continue;
      }
      base.queries += 1;
      const baseRecord = variants.base;
      baseRecord.queries += 1;
      bump(baseRecord.confidence, baseOutcome.confidence);
      bump(base.confidence, baseOutcome.confidence);
      bump(base.knowledgeConfidence, baseOutcome.knowledgeConfidence);
      if (baseOutcome.termHitsTruncated) base.termHitsTruncated += 1;
      if (baseOutcome.knowledgeConfidence !== "(absent)") produced.knowledgeConfidenceResponses += 1;
      const baseKnowledgeHits = baseOutcome.nonSelf.filter((hit) => hit.type === "knowledge");
      if (baseKnowledgeHits.length === 0 && baseOutcome.confidence === "high") {
        base.zeroKnowledgeHitsButHigh += 1;
        bump(base.zeroKnowledgeHitsButHighByKnowledgeConfidence, baseOutcome.knowledgeConfidence);
      }
      if (baseOutcome.knowledgeConfidence === "none" && baseKnowledgeHits.length > 0) {
        base.knowledgeConfidenceNoneWithKnowledgeHits += 1;
      }
      if (baseOutcome.nonSelf.length === 0) baseRecord.nonSelfHitsZero += 1;
      if (baseOutcome.termHits) base.termHitsPresent += 1;
      const termHits = baseOutcome.termHits ?? [];
      const zeroFraction = termHits.length > 0 ? termHits.filter((hit) => hit.count === 0).length / termHits.length : 0;
      base.zeroTermFraction.values.push(zeroFraction);
      bump(
        base.zeroTermFraction.buckets,
        zeroFraction === 0 ? "0" : zeroFraction <= 0.25 ? "(0,0.25]" : zeroFraction <= 0.5 ? "(0.25,0.5]" : "(0.5,1]",
      );
      bump(base.nonSelfHistogram, bucket(baseOutcome.nonSelf.length));
      if (baseOutcome.confidence === "high" && baseOutcome.nonSelf.length === 0) base.highWithoutNonSelf += 1;
      for (const hit of baseOutcome.nonSelf) {
        base.hits += 1;
        produced.hits += 1;
        bump(produced.byType, hit.type);
        const fields = hit.matchedIn ?? [];
        if (fields.length === 1 && fields[0] === "path") base.pathOnlyHits += 1;
        if (fields.length > 1) produced.matchedInMultiple += 1;
        bump(produced.matchedInLength, fields.length >= 5 ? "5+" : String(fields.length));
        if (hit.matchedVia === "synonym") {
          produced.synonymHits += 1;
          bump(produced.synonymHitsByType, hit.type);
        }
        if (hit.type === "knowledge") {
          produced.knowledgeHits += 1;
          if (hit.possiblyStale) produced.knowledgeHitsPossiblyStale += 1;
          if (hit.staleReason === "broad_applies_to") produced.knowledgeHitsBroadStaleReason += 1;
          if (typeof hit.broadChangesSince === "number" && hit.broadChangesSince > 0) produced.knowledgeHitsWithBroadChanges += 1;
        }
        bump(produced.matchedInCombos, [...fields].sort().join("+") || "(none)");
        if (hit.matchedPaths && hit.matchedPaths.length > 0) produced.withMatchedPaths += 1;
      }

      // Past-only recall: ask on the calendar day before the Session started.
      const startedAt = sessionStart.get(entry.id);
      const to = startedAt ? dayBefore(startedAt) : undefined;
      if (!to) pastOnly.skippedNoStart += 1;
      else {
        try {
          const past = recallOne(project.root, query, entry.id, { to });
          if (!past) pastOnly.skippedByPolicy += 1;
          else {
            pastOnly.queries += 1;
            bump(pastOnly.confidence, past.confidence);
            bump(pastOnly.knowledgeConfidence, past.knowledgeConfidence);
            if (past.termHitsTruncated) pastOnly.termHitsTruncated += 1;
            if (past.termHits) pastOnly.termHitsPresent += 1;
            const pastTerms = past.termHits ?? [];
            const pastZero = pastTerms.length > 0 ? pastTerms.filter((hit) => hit.count === 0).length / pastTerms.length : 0;
            pastOnly.zeroTermFractions.push(pastZero);
            bump(
              pastOnly.zeroTermFractionBuckets,
              pastZero === 0 ? "0" : pastZero <= 0.25 ? "(0,0.25]" : pastZero <= 0.5 ? "(0.25,0.5]" : "(0.5,1]",
            );
            bump(pastOnly.hitsHistogram, bucket(past.nonSelf.length));
            for (const hit of past.nonSelf) bump(pastOnly.hitsByType, hit.type);
            const knowledgeHits = past.nonSelf.filter((hit) => hit.type === "knowledge");
            if (knowledgeHits.length === 0 && past.confidence === "high") {
              pastOnly.zeroKnowledgeHitsButHigh += 1;
              bump(pastOnly.zeroKnowledgeHitsButHighByKnowledgeConfidence, past.knowledgeConfidence);
            }
            if (past.knowledgeConfidence === "none" && knowledgeHits.length > 0) pastOnly.knowledgeConfidenceNoneWithKnowledgeHits += 1;
            const truth = new Set(
              [...(appliedBySession.get(entry.id) ?? [])].filter((id) => {
                const created = Date.parse(knowledgeMeta.get(id)?.created_at ?? "");
                return Number.isFinite(created) && created < Date.parse(startedAt);
              }),
            );
            const group = truth.size > 0 ? pastOnly.positives : pastOnly.negatives;
            group.n += 1;
            bump(group.confidence, past.confidence);
            bump(group.knowledgeConfidence, past.knowledgeConfidence);
            if (knowledgeHits.length > 0) group.withKnowledgeHit += 1;
            bump(group.knowledgeHitHistogram, bucket(knowledgeHits.length));
            if (truth.size > 0 && knowledgeHits.some((hit) => truth.has(hit.id))) group.hitAt8 += 1;

            // Positive recall bounds: the same split, without the date filter and with task-only getContext.
            const positive = truth.size > 0;
            try {
              const noDate = positive ? bounds.noDate.positives : bounds.noDate.negatives;
              noDate.n += 1;
              bump(noDate.confidence, baseOutcome.confidence);
              bump(noDate.knowledgeConfidence, baseOutcome.knowledgeConfidence);
              const baseKnowledge = baseOutcome.nonSelf.filter((hit) => hit.type === "knowledge");
              if (baseKnowledge.length > 0) noDate.withKnowledgeHit += 1;
              if (positive && baseKnowledge.some((hit) => truth.has(hit.id))) noDate.hitAt8 += 1;
              const wide = recallOne(project.root, query, entry.id, { limit: 20 });
              noDate.limit20.n += 1;
              const wideKnowledge = (wide?.nonSelf ?? []).filter((hit) => hit.type === "knowledge");
              if (wideKnowledge.length > 0) noDate.limit20.withKnowledgeHit += 1;
              if (positive && wideKnowledge.some((hit) => truth.has(hit.id))) noDate.limit20.hitAt20 += 1;
              if (positive) {
                const startMs = Date.parse(startedAt);
                const after = [...truth].filter((id) => Date.parse(knowledgeMeta.get(id)?.updated_at ?? "") > startMs).length;
                bounds.updated.positives += 1;
                bounds.updated.truthRows += truth.size;
                bounds.updated.truthRowsAfter += after;
                if (after === truth.size) bounds.updated.allAfter += 1;
                if (after > 0) bounds.updated.anyAfter += 1;
              }
            } catch (error) {
              bump(bounds.errors, errorClass(error));
            }
            if (positive || bounds.negativeContextAttempts < NEGATIVE_CONTEXT_SAMPLE) {
              if (!positive) bounds.negativeContextAttempts += 1;
              const record = positive ? bounds.ctx.positives : bounds.ctx.negatives;
              try {
                const response = store.getContext(project.root, { task: query });
                if (response.outcome !== "context") record.skipped += 1;
                else {
                  record.n += 1;
                  const relevant = response.relevant ?? {};
                  bump(record.confidence, relevant.confidence ?? "(absent)");
                  bump(record.knowledgeConfidence, enumValue(relevant.knowledgeConfidence));
                  if (typeof relevant.knowledgeHint === "string") record.knowledgeHint += 1;
                  if (relevant.termHitsTruncated === true) record.termHitsTruncated += 1;
                  const supplements = relevant.supplements ?? [];
                  if (positive) {
                    const inRelevant = (relevant.knowledge ?? []).some((item) => truth.has(item.id));
                    const truthSupplements = supplements.filter((item) => item.type === "knowledge" && truth.has(item.id));
                    const inRecent = (response.recentKnowledge ?? []).some((item) => truth.has(item.id));
                    if (inRelevant) record.relevantKnowledge += 1;
                    if (truthSupplements.length > 0) {
                      record.supplements += 1;
                      for (const kind of new Set(truthSupplements.map((item) => item.includedBecause?.kind ?? "(none)"))) {
                        bump(record.supplementKinds, kind);
                      }
                    }
                    if (!inRelevant && truthSupplements.length === 0) {
                      if (inRecent) record.recentOnly += 1;
                      else record.nowhere += 1;
                    }
                  } else {
                    if ((relevant.knowledge ?? []).length > 0) record.withRelevantKnowledge += 1;
                    if (supplements.length > 0) record.withSupplements += 1;
                  }
                }
              } catch (error) {
                bump(record.errors, errorClass(error));
              }
            }
            // Path recall baseline: getContext with the query Session's own changed files (first 20, as stored).
            if (positive || pathRecall.negativeAttempts < NEGATIVE_CONTEXT_SAMPLE) {
              if (!positive) pathRecall.negativeAttempts += 1;
              const record = positive ? pathRecall.positives : pathRecall.negatives;
              try {
                const own = sessionFiles().get(entry.id);
                const stored = (own?.stored ?? []).slice(0, BROAD_FILES);
                if (stored.length === 0) record.noSessionFiles += 1;
                let hasApplies = false;
                let covers = false;
                if (positive) {
                  for (const id of truth) {
                    const entries = appliesToOf(id);
                    if (entries.length > 0) hasApplies = true;
                    if (entries.some((pattern) => [...(own?.paths ?? [])].some((path) => entryCovers(pattern, path)))) covers = true;
                  }
                }
                const response = store.getContext(project.root, { task: query, paths: stored });
                if (response.outcome !== "context") record.skipped += 1;
                else {
                  record.n += 1;
                  const relevant = response.relevant ?? {};
                  bump(record.confidence, relevant.confidence ?? "(absent)");
                  bump(record.knowledgeConfidence, enumValue(relevant.knowledgeConfidence));
                  if (typeof relevant.knowledgeHint === "string") record.knowledgeHint += 1;
                  if (relevant.termHitsTruncated === true) record.termHitsTruncated += 1;
                  const supplements = relevant.supplements ?? [];
                  if ((relevant.knowledge ?? []).length === 0) record.relevantKnowledgeEmpty += 1;
                  if (positive) {
                    if (hasApplies) record.truthHasAppliesTo += 1;
                    if (covers) record.truthCoversSessionFiles += 1;
                    const inRelevant = (relevant.knowledge ?? []).some((item) => truth.has(item.id));
                    const truthSupplements = supplements.filter((item) => item.type === "knowledge" && truth.has(item.id));
                    const inRecent = (response.recentKnowledge ?? []).some((item) => truth.has(item.id));
                    if (inRelevant) record.relevantKnowledge += 1;
                    if (truthSupplements.length > 0) {
                      record.supplements += 1;
                      for (const kind of new Set(truthSupplements.map((item) => item.includedBecause?.kind ?? "(none)"))) {
                        bump(record.supplementKinds, kind);
                      }
                    }
                    if (inRelevant || truthSupplements.length > 0) record[covers ? "foundWhenCovered" : "foundWhenNotCovered"] += 1;
                    if (!inRelevant && truthSupplements.length === 0) {
                      if (inRecent) record.recentOnly += 1;
                      else record.nowhere += 1;
                    }
                  } else if ((relevant.knowledge ?? []).length > 0) record.relevantKnowledge += 1;
                  if (!positive && supplements.length > 0) record.withSupplements += 1;
                }
              } catch (error) {
                bump(record.errors, errorClass(error));
              }
            }
          }
        } catch (error) {
          bump(pastOnly.errors, errorClass(error));
        }
      }

      // Unknown-word dilution: the title plus k nonsense tokens.
      const injected = [];
      for (const [name, count] of [
        ["plus1", 1],
        ["plus2", 2],
        ["plus3", 3],
      ]) {
        while (injected.length < count) injected.push(nonsenseToken(rng));
        const tokens = injected.slice(0, count);
        const diluted = recallOne(project.root, `${query} ${tokens.join(" ")}`, entry.id);
        if (!diluted) continue;
        const record = variants[name];
        record.queries += 1;
        bump(record.confidence, diluted.confidence);
        if (diluted.nonSelf.length === 0) record.nonSelfHitsZero += 1;
        if (flagsAll(diluted, tokens)) record.termHitsFlagAll += 1;
        if (baseOutcome.nonSelf.length > 0) {
          if (diluted.confidence === "none") record.droppedByUnknownTerms += 1;
          if (diluted.nonSelf.length === 0) record.lostAllNonSelf += 1;
        }
      }
      // Nonsense control: three tokens, nothing else.
      const tokens = [nonsenseToken(rng), nonsenseToken(rng), nonsenseToken(rng)];
      const only = recallOne(project.root, tokens.join(" "), entry.id);
      if (only) {
        nonsenseOnly.queries += 1;
        bump(nonsenseOnly.confidence, only.confidence);
        if (only.hits.length === 0) nonsenseOnly.noHits += 1;
        if (flagsAll(only, tokens)) nonsenseOnly.allTermsZero += 1;
      }

      // Agent Knowledge search (what work_search_knowledge calls), active status.
      try {
        const found = store.searchKnowledgeForAgent({ projectRoot: project.root, q: query, status: "active" });
        if (found.outcome === "knowledge") {
          knowledgeSearch.queries += 1;
          bump(knowledgeSearch.match, found.match ?? "(absent)");
          if (found.termHitsTruncated === true) knowledgeSearch.termHitsTruncated += 1;
          if (found.match === "relaxed" || found.match === "none") {
            const zeroTerms = Array.isArray(found.termHits) && found.termHits.length > 0 && found.termHits.every((entry) => entry.count === 0);
            knowledgeSearch.fallbackAnswers += 1;
            if (Array.isArray(found.termHits)) knowledgeSearch.termHitsOnFallback += 1;
            if (zeroTerms) knowledgeSearch.allTermsZeroOnFallback += 1;
            if (found.match === "none") {
              knowledgeSearch.noneAnswers += 1;
              if (Array.isArray(found.termHits)) knowledgeSearch.termHitsOnNone += 1;
              if (zeroTerms) knowledgeSearch.allTermsZeroOnNone += 1;
            }
          }
          const matchType = found.match === "strict" || found.match === "relaxed" ? found.match : "none";
          const termCount = distinctTerms(query).size;
          bump(quality.queryTermsHistogram, termBucket(termCount));
          if (!quality.queryTermsByMatch[matchType]) quality.queryTermsByMatch[matchType] = {};
          bump(quality.queryTermsByMatch[matchType], termBucket(termCount));
          const topRelaxed = found.relaxedMatches?.[0];
          if (matchType === "relaxed" && topRelaxed && termCount > 0) {
            const coverage = Math.min(1, (topRelaxed.matchedTerms?.length ?? 0) / termCount);
            quality.relaxedCoverageValues.push(coverage);
            bump(
              quality.relaxedCoverageBuckets,
              coverage <= 0.25 ? "(0,0.25]" : coverage <= 0.5 ? "(0.25,0.5]" : coverage <= 0.75 ? "(0.5,0.75]" : "(0.75,1]",
            );
          }
          const truthIds = new Set(
            [...(authoredBySession.get(entry.id) ?? []), ...(appliedBySession.get(entry.id) ?? [])].filter(
              (id) => knowledgeMeta.get(id)?.status === "active",
            ),
          );
          if (truthIds.size > 0) {
            quality.queriesWithTruth += 1;
            const record = quality.byMatch[matchType];
            record.n += 1;
            const ranked = (matchType === "strict" ? found.items : matchType === "relaxed" ? found.relaxedMatches : []) ?? [];
            if (ranked.slice(0, 1).some((item) => truthIds.has(item.id))) record.hitAt1 += 1;
            if (ranked.slice(0, 3).some((item) => truthIds.has(item.id))) record.hitAt3 += 1;
          }
          if (found.otherStatusMatches && Object.keys(found.otherStatusMatches).length > 0) {
            knowledgeSearch.otherStatusMatchesPresent += 1;
          }
        } else knowledgeSearch.skipped += 1;
      } catch (error) {
        bump(knowledgeSearch.errors, errorClass(error));
      }

      // getContext (what work_get_context calls) on the smaller sample.
      if (index < contextLimit) {
        try {
          const response = store.getContext(project.root, { task: query });
          if (response.outcome !== "context") context.skipped += 1;
          else {
            context.responses += 1;
            for (const key of Object.keys(response)) bump(context.topLevelKeys, key);
            const relevant = response.relevant ?? {};
            for (const key of Object.keys(relevant)) bump(context.relevantKeys, key);
            if (relevant.confidence) bump(context.relevantConfidence, relevant.confidence);
            const relevantKnowledgeConfidence = enumValue(relevant.knowledgeConfidence);
            bump(context.relevantKnowledgeConfidence, relevantKnowledgeConfidence);
            if (relevant.termHitsTruncated === true) context.termHitsTruncated += 1;
            for (const item of relevant.knowledge ?? []) {
              context.knowledgeItems += 1;
              if (item.possiblyStale) context.knowledgeItemsPossiblyStale += 1;
              if (item.staleReason === "broad_applies_to") context.knowledgeItemsBroadStaleReason += 1;
              if (typeof item.broadChangesSince === "number" && item.broadChangesSince > 0) context.knowledgeItemsWithBroadChanges += 1;
            }
            if (typeof relevant.knowledgeHint === "string") {
              context.knowledgeHintResponses += 1;
              if ((relevant.knowledge?.length ?? 0) > 0) context.knowledgeHintWithKnowledge += 1;
            }
            if ((relevant.knowledge?.length ?? 0) === 0 && relevant.confidence === "high") {
              context.zeroKnowledgeButHigh += 1;
              bump(context.zeroKnowledgeButHighByKnowledgeConfidence, relevantKnowledgeConfidence);
            }
            const knowledgeCount = relevant.knowledge?.length ?? 0;
            const sessionCount = relevant.sessions?.length ?? 0;
            bump(context.knowledgeCount, bucket(knowledgeCount));
            bump(context.sessionCount, bucket(sessionCount));
            if (knowledgeCount === 0 && sessionCount === 0) context.zeroRelevant += 1;
            const kinds = new Set();
            for (const supplement of relevant.supplements ?? []) {
              const kind = supplement.includedBecause?.kind ?? "(none)";
              bump(context.supplementKinds, `${kind}.items`);
              kinds.add(kind);
            }
            for (const kind of kinds) bump(context.supplementKinds, `${kind}.responses`);
            if (kinds.size > 0) context.responsesWithSupplements += 1;
          }
        } catch (error) {
          bump(context.errors, errorClass(error));
        }
      }
    }

    const groupReport = (group, withTruth) => ({
      n: group.n,
      confidence: group.confidence,
      knowledgeConfidence: group.knowledgeConfidence,
      withKnowledgeHitShare: ratio(group.withKnowledgeHit, group.n),
      ...(withTruth ? { hitAt8: group.hitAt8, hitAt8Share: ratio(group.hitAt8, group.n) } : {}),
      knowledgeHitHistogram: group.knowledgeHitHistogram,
    });
    const decorate = (record) => ({
      ...record,
      nonSelfHitsZeroShare: ratio(record.nonSelfHitsZero, record.queries),
      termHitsFlagAllShare: ratio(record.termHitsFlagAll, record.queries),
    });
    const boundsReport = () => {
      const bound = (group, withTruth) => ({
        n: group.n,
        confidence: group.confidence,
        knowledgeConfidence: group.knowledgeConfidence,
        withKnowledgeHitShare: ratio(group.withKnowledgeHit, group.n),
        ...(withTruth ? { hitAt8: group.hitAt8, hitAt8Share: ratio(group.hitAt8, group.n) } : {}),
        limit20: {
          n: group.limit20.n,
          withKnowledgeHitShare: ratio(group.limit20.withKnowledgeHit, group.limit20.n),
          ...(withTruth ? { hitAt20: group.limit20.hitAt20, hitAt20Share: ratio(group.limit20.hitAt20, group.limit20.n) } : {}),
        },
      });
      const p = bounds.ctx.positives;
      const g = bounds.ctx.negatives;
      return {
        definition: "positive = the query Session applied a Knowledge created before its start (same split as pastOnly)",
        errors: bounds.errors,
        noDateFilter: {
          positives: bound(bounds.noDate.positives, true),
          negatives: bound(bounds.noDate.negatives, false),
        },
        truthUpdatedAfterStart: {
          positives: bounds.updated.positives,
          allTruthUpdatedAfterStart: bounds.updated.allAfter,
          allTruthUpdatedAfterStartShare: ratio(bounds.updated.allAfter, bounds.updated.positives),
          anyTruthUpdatedAfterStart: bounds.updated.anyAfter,
          anyTruthUpdatedAfterStartShare: ratio(bounds.updated.anyAfter, bounds.updated.positives),
          truthRows: bounds.updated.truthRows,
          truthRowsUpdatedAfterStart: bounds.updated.truthRowsAfter,
        },
        getContextTaskOnly: {
          timeSliced: false,
          negativeSampleLimit: NEGATIVE_CONTEXT_SAMPLE,
          positives: {
            n: p.n,
            skipped: p.skipped,
            errors: p.errors,
            relevantConfidence: p.confidence,
            relevantKnowledgeConfidence: p.knowledgeConfidence,
            knowledgeHintResponses: p.knowledgeHint,
            termHitsTruncatedResponses: p.termHitsTruncated,
            truthInRelevantKnowledge: p.relevantKnowledge,
            truthInRelevantKnowledgeShare: ratio(p.relevantKnowledge, p.n),
            truthInSupplements: p.supplements,
            truthInSupplementsShare: ratio(p.supplements, p.n),
            truthInSupplementsByKind: p.supplementKinds,
            truthInRecentKnowledgeOnly: p.recentOnly,
            truthInRecentKnowledgeOnlyShare: ratio(p.recentOnly, p.n),
            truthNowhere: p.nowhere,
            truthNowhereShare: ratio(p.nowhere, p.n),
          },
          negatives: {
            n: g.n,
            skipped: g.skipped,
            errors: g.errors,
            relevantConfidence: g.confidence,
            relevantKnowledgeConfidence: g.knowledgeConfidence,
            knowledgeHintResponses: g.knowledgeHint,
            termHitsTruncatedResponses: g.termHitsTruncated,
            withRelevantKnowledge: g.withRelevantKnowledge,
            withRelevantKnowledgeShare: ratio(g.withRelevantKnowledge, g.n),
            withSupplements: g.withSupplements,
            withSupplementsShare: ratio(g.withSupplements, g.n),
          },
        },
      };
    };
    const pathRecallReport = () => {
      const p = pathRecall.positives;
      const g = pathRecall.negatives;
      return {
        definition: "positive = the query Session applied a Knowledge created before its start (same split as pastOnly)",
        timeSliced: false,
        pathsSource: "the query Session's own final changed files, first 20, as stored (an upper bound of what an Agent knows at start)",
        negativeSampleLimit: NEGATIVE_CONTEXT_SAMPLE,
        positives: {
          n: p.n,
          skipped: p.skipped,
          errors: p.errors,
          noSessionFiles: p.noSessionFiles,
          truthHasAppliesTo: p.truthHasAppliesTo,
          truthHasAppliesToShare: ratio(p.truthHasAppliesTo, p.n),
          truthCoversSessionFiles: p.truthCoversSessionFiles,
          truthCoversSessionFilesShare: ratio(p.truthCoversSessionFiles, p.n),
          relevantConfidence: p.confidence,
          relevantKnowledgeConfidence: p.knowledgeConfidence,
          knowledgeHintResponses: p.knowledgeHint,
          termHitsTruncatedResponses: p.termHitsTruncated,
          truthInRelevantKnowledge: p.relevantKnowledge,
          truthInRelevantKnowledgeShare: ratio(p.relevantKnowledge, p.n),
          truthInSupplements: p.supplements,
          truthInSupplementsShare: ratio(p.supplements, p.n),
          truthInSupplementsByKind: p.supplementKinds,
          truthInRecentKnowledgeOnly: p.recentOnly,
          truthInRecentKnowledgeOnlyShare: ratio(p.recentOnly, p.n),
          truthNowhere: p.nowhere,
          truthNowhereShare: ratio(p.nowhere, p.n),
          foundInRelevantOrSupplementsWhenCovered: p.foundWhenCovered,
          foundInRelevantOrSupplementsWhenNotCovered: p.foundWhenNotCovered,
          foundShareWhenCovered: ratio(p.foundWhenCovered, p.truthCoversSessionFiles),
          foundShareWhenNotCovered: ratio(p.foundWhenNotCovered, p.n - p.truthCoversSessionFiles),
          relevantKnowledgeEmpty: p.relevantKnowledgeEmpty,
          relevantKnowledgeEmptyShare: ratio(p.relevantKnowledgeEmpty, p.n),
        },
        negatives: {
          n: g.n,
          skipped: g.skipped,
          errors: g.errors,
          noSessionFiles: g.noSessionFiles,
          relevantConfidence: g.confidence,
          relevantKnowledgeConfidence: g.knowledgeConfidence,
          knowledgeHintResponses: g.knowledgeHint,
          termHitsTruncatedResponses: g.termHitsTruncated,
          withRelevantKnowledge: g.relevantKnowledge,
          withRelevantKnowledgeShare: ratio(g.relevantKnowledge, g.n),
          withSupplements: g.withSupplements,
          withSupplementsShare: ratio(g.withSupplements, g.n),
          relevantKnowledgeEmpty: g.relevantKnowledgeEmpty,
          relevantKnowledgeEmptyShare: ratio(g.relevantKnowledgeEmpty, g.n),
        },
      };
    };
    report.productShape.recallHasKnowledgeConfidence = produced.knowledgeConfidenceResponses > 0;
    if (sections.has("1")) {
      const baseWithHits = base.nonSelfHistogram["1-2"] + base.nonSelfHistogram["3-5"] + base.nonSelfHistogram["6+"];
      const dilution = {};
      for (const name of ["plus1", "plus2", "plus3"]) {
        dilution[name] = {
          ...decorate(variants[name]),
          droppedByUnknownTermsShareOfQueriesWithHits: ratio(variants[name].droppedByUnknownTerms, baseWithHits),
          lostAllNonSelfShareOfQueriesWithHits: ratio(variants[name].lostAllNonSelf, baseWithHits),
        };
      }
      report.answerability = {
        queries: base.queries,
        skippedEmptyQuery: base.skippedEmptyQuery,
        skippedByPolicy: base.skippedByPolicy,
        errors: base.errors,
        confidence: base.confidence,
        knowledgeConfidence: base.knowledgeConfidence,
        termHitsTruncatedQueries: base.termHitsTruncated,
        zeroKnowledgeHitsButHighConfidence: {
          n: base.zeroKnowledgeHitsButHigh,
          share: ratio(base.zeroKnowledgeHitsButHigh, base.queries),
          byKnowledgeConfidence: base.zeroKnowledgeHitsButHighByKnowledgeConfidence,
        },
        knowledgeConfidenceNoneWithKnowledgeHits: base.knowledgeConfidenceNoneWithKnowledgeHits,
        termHitsPresentShare: ratio(base.termHitsPresent, base.queries),
        zeroTermFraction: {
          buckets: base.zeroTermFraction.buckets,
          ...summary(base.zeroTermFraction.values),
        },
        nonSelfHitsHistogram: base.nonSelfHistogram,
        nonSelfHits: base.hits,
        pathOnlyHitShare: ratio(base.pathOnlyHits, base.hits),
        highConfidenceWithoutNonSelfHits: base.highWithoutNonSelf,
        highConfidenceWithoutNonSelfShare: ratio(base.highWithoutNonSelf, base.queries),
        controls: {
          nonsenseOnly: {
            ...nonsenseOnly,
            confidenceNoneShare: ratio(nonsenseOnly.confidence.none ?? 0, nonsenseOnly.queries),
            allTermsZeroShare: ratio(nonsenseOnly.allTermsZero, nonsenseOnly.queries),
          },
          halfOff: "see dilution.plus2",
        },
        dilution: { base: decorate(variants.base), ...dilution },
        knowledgeSearch: {
          ...knowledgeSearch,
          otherStatusMatchesPresentShare: ratio(knowledgeSearch.otherStatusMatchesPresent, knowledgeSearch.queries),
          fallbackTermHits: {
            definition: "match relaxed or none: termHits lists how many Knowledge contain each query word",
            fallbackAnswers: knowledgeSearch.fallbackAnswers,
            termHitsPresentShare: ratio(knowledgeSearch.termHitsOnFallback, knowledgeSearch.fallbackAnswers),
            allTermsZeroShare: ratio(knowledgeSearch.allTermsZeroOnFallback, knowledgeSearch.fallbackAnswers),
            noneAnswers: knowledgeSearch.noneAnswers,
            noneTermHitsPresentShare: ratio(knowledgeSearch.termHitsOnNone, knowledgeSearch.noneAnswers),
            noneAllTermsZeroShare: ratio(knowledgeSearch.allTermsZeroOnNone, knowledgeSearch.noneAnswers),
            termHitsTruncatedAnswers: knowledgeSearch.termHitsTruncated,
          },
        },
        getContext: {
          ...context,
          zeroRelevantShare: ratio(context.zeroRelevant, context.responses),
          answerabilityFields: {
            relevantConfidence: context.relevantKeys.confidence ?? 0,
            relevantKnowledgeConfidence: context.relevantKeys.knowledgeConfidence ?? 0,
            relevantKnowledgeHint: context.relevantKeys.knowledgeHint ?? 0,
            relevantTermHits: context.relevantKeys.termHits ?? 0,
          },
          knowledgeHintShare: ratio(context.knowledgeHintResponses, context.responses),
          zeroKnowledgeButHighConfidenceShare: ratio(context.zeroKnowledgeButHigh, context.responses),
        },
        pastOnly: {
          queries: pastOnly.queries,
          skippedNoStart: pastOnly.skippedNoStart,
          skippedByPolicy: pastOnly.skippedByPolicy,
          errors: pastOnly.errors,
          startSource: "started_at, else completed_at, else created_at",
          confidence: pastOnly.confidence,
          knowledgeConfidence: pastOnly.knowledgeConfidence,
          termHitsTruncatedQueries: pastOnly.termHitsTruncated,
          zeroKnowledgeHitsButHighByKnowledgeConfidence: pastOnly.zeroKnowledgeHitsButHighByKnowledgeConfidence,
          knowledgeConfidenceNoneWithKnowledgeHits: pastOnly.knowledgeConfidenceNoneWithKnowledgeHits,
          termHitsPresentShare: ratio(pastOnly.termHitsPresent, pastOnly.queries),
          zeroTermFraction: { buckets: pastOnly.zeroTermFractionBuckets, ...summary(pastOnly.zeroTermFractions) },
          hitsHistogram: pastOnly.hitsHistogram,
          hitsByType: pastOnly.hitsByType,
          zeroKnowledgeHitsButHighConfidence: pastOnly.zeroKnowledgeHitsButHigh,
          positives: groupReport(pastOnly.positives, true),
          negatives: groupReport(pastOnly.negatives, false),
        },
        positiveRecallBounds: boundsReport(),
        pathRecallBaseline: pathRecallReport(),
        knowledgeSearchQuality: {
          tokenizer: TOKENIZER,
          queriesWithTruth: quality.queriesWithTruth,
          byMatch: Object.fromEntries(
            Object.entries(quality.byMatch).map(([name, record]) => [
              name,
              { ...record, hitAt1Share: ratio(record.hitAt1, record.n), hitAt3Share: ratio(record.hitAt3, record.n) },
            ]),
          ),
          relaxedTopMatchTermCoverage: { buckets: quality.relaxedCoverageBuckets, ...summary(quality.relaxedCoverageValues) },
          queryTermsHistogram: quality.queryTermsHistogram,
          queryTermsByMatch: quality.queryTermsByMatch,
        },
      };
    }
    if (sections.has("2")) {
      report.producedBy = {
        nonSelfHits: produced.hits,
        byType: produced.byType,
        matchedInCombos: produced.matchedInCombos,
        matchedInMultipleShare: ratio(produced.matchedInMultiple, produced.hits),
        // Store level: the MCP work_recall trims matchedIn to its limit (4 in the current build, 1 in older builds).
        matchedInLengthHistogram: produced.matchedInLength,
        matchedInOverMcpLimitShare: ratio(produced.matchedInLength["5+"], produced.hits),
        matchedPathsShare: ratio(produced.withMatchedPaths, produced.hits),
        // True when the responses carry the new recall shape (knowledgeConfidence), where matchedVia can name synonym-only hits.
        synonymOnlyDetectable: produced.knowledgeConfidenceResponses > 0,
        synonymOnlyHits: produced.synonymHits,
        synonymOnlyHitShare: ratio(produced.synonymHits, produced.hits),
        synonymOnlyHitsByType: produced.synonymHitsByType,
        knowledgeHits: {
          n: produced.knowledgeHits,
          possiblyStaleShare: ratio(produced.knowledgeHitsPossiblyStale, produced.knowledgeHits),
          broadStaleReasonShare: ratio(produced.knowledgeHitsBroadStaleReason, produced.knowledgeHits),
          withBroadChangesShare: ratio(produced.knowledgeHitsWithBroadChanges, produced.knowledgeHits),
        },
        getContextKnowledgeItems: {
          n: context.knowledgeItems,
          possiblyStaleShare: ratio(context.knowledgeItemsPossiblyStale, context.knowledgeItems),
          broadStaleReasonShare: ratio(context.knowledgeItemsBroadStaleReason, context.knowledgeItems),
          withBroadChangesShare: ratio(context.knowledgeItemsWithBroadChanges, context.knowledgeItems),
        },
        getContextIncludedBecause: context.supplementKinds,
        getContextResponses: context.responses,
      };
    }
  }

  // ---- section 3: hub files ---------------------------------------------------------------------------------
  if (sections.has("3")) {
    const { perProject, sets, broad } = hubs();
    const thresholds = [0.1, 0.25, 0.5];
    const pooled = {
      projectsWithFiles: perProject.size,
      sessionsWithChangedFiles: 0,
      distinctPaths: 0,
      pathsAtLeast: { "10%": 0, "25%": 0, "50%": 0 },
      hubCategories: {},
    };
    const rows = [];
    for (const [projectId, entry] of perProject) {
      const top = Math.max(...entry.counts.values());
      const row = { sessionsWithChangedFiles: entry.sessions, distinctPaths: entry.counts.size, topPathShare: ratio(top, entry.sessions) };
      row.pathsAtLeast = {};
      for (const threshold of thresholds) {
        const label = `${Math.round(threshold * 100)}%`;
        let count = 0;
        for (const [path, sessions] of entry.counts) {
          if (sessions / entry.sessions >= threshold - 1e-9) {
            count += 1;
            if (threshold === 0.1) bump(pooled.hubCategories, category(path));
          }
        }
        row.pathsAtLeast[label] = count;
        pooled.pathsAtLeast[label] += count;
      }
      row.impactHubs = sets.get(projectId)?.size ?? 0;
      pooled.sessionsWithChangedFiles += entry.sessions;
      pooled.distinctPaths += entry.counts.size;
      rows.push(row);
    }
    rows.sort((a, b) => b.sessionsWithChangedFiles - a.sessionsWithChangedFiles);
    const malformed = raw
      .prepare(
        `SELECT COUNT(*) AS c FROM sessions
         WHERE CASE WHEN json_valid(changed_files_json) THEN json_type(changed_files_json) <> 'array' ELSE 1 END`,
      )
      .get().c;
    const hubSections = {
      definitionNote: "share = Sessions touching the path / non-voided Sessions of the project with >= 1 changed file",
      pooled: {
        ...pooled,
        topPathShare: summary(rows.map((row) => row.topPathShare ?? 0)),
        sessionsOver20Files: broad,
        malformedChangedFiles: malformed,
      },
      projects: { total: rows.length, listed: rows.slice(0, MAX_PROJECT_ROWS) },
    };
    const impact = {};

    // related work
    const related = {
      sampled: 0,
      errors: {},
      states: {},
      resultsHistogram: {},
      itemsTotal: 0,
      sharedLength: { 1: 0, 2: 0, 3: 0, "4+": 0 },
      hubOnlyRelated: 0,
      hubOnlyAmongShownPaths: 0,
      sessionsWithResults: 0,
      sessionsWhereEveryResultIsHubOnly: 0,
    };
    for (const entry of sample.slice(0, Math.min(options.relatedSample, sample.length))) {
      const hubSet = sets.get(entry.project_id) ?? new Set();
      try {
        const result = store.getRelatedWork(entry.id);
        related.sampled += 1;
        bump(related.states, result.state === "ready" ? "ready" : `unavailable:${result.reason ?? "unknown"}`);
        if (result.state !== "ready") continue;
        bump(related.resultsHistogram, String(result.items.length));
        let hubOnlySessionItems = 0;
        for (const item of result.items) {
          related.itemsTotal += 1;
          bump(related.sharedLength, item.sharedCount >= 4 ? "4+" : String(item.sharedCount));
          const shownAllHub = item.sharedPaths.length > 0 && item.sharedPaths.every((path) => hubSet.has(path));
          if (shownAllHub) related.hubOnlyAmongShownPaths += 1;
          if (shownAllHub && item.pathsOmitted === 0) {
            related.hubOnlyRelated += 1;
            hubOnlySessionItems += 1;
          }
        }
        if (result.items.length > 0) {
          related.sessionsWithResults += 1;
          if (hubOnlySessionItems === result.items.length) related.sessionsWhereEveryResultIsHubOnly += 1;
        }
      } catch (error) {
        bump(related.errors, errorClass(error));
      }
    }
    impact.relatedWork = {
      ...related,
      hubOnlyRelatedShare: ratio(related.hubOnlyRelated, related.itemsTotal),
      hubOnlyAmongShownPathsShare: ratio(related.hubOnlyAmongShownPaths, related.itemsTotal),
    };

    // graph paths between Sessions of one project
    const byProject = new Map();
    for (const entry of pool) {
      if (!byProject.has(entry.project_id)) byProject.set(entry.project_id, []);
      byProject.get(entry.project_id).push(entry.id);
    }
    const multi = [...byProject.entries()].filter(([, ids]) => ids.length >= 2);
    // The bounded graph a path search walks (same limits as GraphBuilder.findPath), cached per project.
    const graphErrors = {};
    const graphInfo = new Map();
    const graphFor = (projectId) => {
      if (graphInfo.has(projectId)) return graphInfo.get(projectId);
      let info = null;
      try {
        const graph = store.getGraph({ projectId, maxNodes: 500, maxEdges: 1000 });
        if (graph.outcome === "graph") {
          info = {
            nodeIds: new Set(graph.nodes.map((node) => node.id)),
            sessionNodes: graph.nodes.filter((node) => node.kind === "session").length,
            truncationReported: graph.truncation !== undefined,
            nodesTruncated: graph.truncation?.nodesTruncated === true,
            edgesTruncated: graph.truncation?.edgesTruncated === true,
          };
        }
      } catch (error) {
        bump(graphErrors, errorClass(error));
      }
      graphInfo.set(projectId, info);
      return info;
    };
    const windows = new Map();
    const windowOf = (projectId) => {
      if (!windows.has(projectId)) {
        windows.set(
          projectId,
          raw
            .prepare(
              `SELECT id FROM sessions WHERE project_id = ? AND voided_at IS NULL
               ORDER BY completed_at DESC, id DESC LIMIT ${PATH_WINDOW_SESSIONS}`,
            )
            .all(projectId)
            .map((row) => row.id),
        );
      }
      return windows.get(projectId);
    };
    const runPairs = (candidates, target) => {
      const record = {
        pairs: 0,
        errors: {},
        skipped: 0,
        found: 0,
        foundWithHubIntermediate: 0,
        hopHistogram: {},
        searchedNodes: [],
        classification: { endpointOutsideRange: 0, noPath: 0, found: 0 },
      };
      for (let attempt = 0; candidates.length > 0 && record.pairs < target && attempt < target * 3; attempt += 1) {
        const [projectId, ids] = candidates[Math.floor(rng() * candidates.length)];
        const a = ids[Math.floor(rng() * ids.length)];
        const b = ids[Math.floor(rng() * ids.length)];
        if (a === b) continue;
        try {
          const result = store.getGraphPath({ projectId, from: `session:${a}`, to: `session:${b}` });
          if (result.outcome !== "graph_path") {
            record.skipped += 1;
            continue;
          }
          record.pairs += 1;
          record.searchedNodes.push(result.searchedNodes);
          if (!result.found) {
            const info = graphFor(projectId);
            const inside = info ? info.nodeIds.has(`session:${a}`) && info.nodeIds.has(`session:${b}`) : true;
            record.classification[inside ? "noPath" : "endpointOutsideRange"] += 1;
            continue;
          }
          record.found += 1;
          record.classification.found += 1;
          bump(record.hopHistogram, result.steps.length >= 6 ? "6+" : String(result.steps.length));
          const project = projectById.get(projectId);
          const hubSet = sets.get(projectId) ?? new Set();
          const prefix = `file:${projectId}:`;
          let viaHub = false;
          for (let i = 0; i < result.steps.length - 1; i += 1) {
            const node = result.steps[i].to;
            if (node.kind === "file" && typeof node.id === "string" && node.id.startsWith(prefix)) {
              if (hubSet.has(normalizePath(node.id.slice(prefix.length), project.context))) viaHub = true;
            }
          }
          if (viaHub) record.foundWithHubIntermediate += 1;
        } catch (error) {
          bump(record.errors, errorClass(error));
        }
      }
      return {
        ...record,
        searchedNodes: summary(record.searchedNodes),
        foundShare: ratio(record.found, record.pairs),
        foundWithHubIntermediateShare: ratio(record.foundWithHubIntermediate, record.found),
      };
    };
    for (const [projectId] of multi.slice(0, MAX_PROJECT_CALLS)) graphFor(projectId);
    const randomPairs = runPairs(multi, options.pairSample);
    const windowCandidates = [...byProject.keys()]
      .map((projectId) => [projectId, windowOf(projectId)])
      .filter(([, ids]) => ids.length >= 2);
    const inWindowPairs = runPairs(windowCandidates, options.windowPairSample);
    const presentShares = [];
    const sessionNodes = [];
    let nodesTruncatedProjects = 0;
    let edgesTruncatedProjects = 0;
    let truncationReported = false;
    for (const [projectId, info] of graphInfo) {
      if (!info) continue;
      const window = windowOf(projectId);
      if (window.length > 0) presentShares.push(window.filter((id) => info.nodeIds.has(`session:${id}`)).length / window.length);
      sessionNodes.push(info.sessionNodes);
      if (info.nodesTruncated) nodesTruncatedProjects += 1;
      if (info.edgesTruncated) edgesTruncatedProjects += 1;
      if (info.truncationReported) truncationReported = true;
    }
    impact.graphPath = {
      ...randomPairs,
      inWindowPairs,
      pathGraph: {
        windowSessions: PATH_WINDOW_SESSIONS,
        projectsMeasured: sessionNodes.length,
        errors: graphErrors,
        sessionNodesPresent: summary(sessionNodes),
        newestWindowSessionsPresentShare: summary(presentShares),
        truncationReported,
        projectsWithNodesTruncated: nodesTruncatedProjects,
        projectsWithEdgesTruncated: edgesTruncatedProjects,
      },
    };

    // hotspots
    const callProjects = [...projects]
      .sort((a, b) => (perProject.get(b.id)?.sessions ?? 0) - (perProject.get(a.id)?.sessions ?? 0))
      .slice(0, MAX_PROJECT_CALLS);
    const hotspots = { projects: 0, errors: {}, top10Items: 0, top10Hub: 0, hubByCategory: {}, projectsWithHubInTop10: 0 };
    const byRank = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1, items: 0, hub: 0, categories: {} }));
    const sessionShares = [];
    for (const project of callProjects) {
      try {
        const result = store.getHotspots({ projectId: project.id, limit: options.hotspotLimit });
        if (result.outcome !== "hotspots") continue;
        hotspots.projects += 1;
        const hubSet = sets.get(project.id) ?? new Set();
        let any = false;
        const withFiles = perProject.get(project.id)?.sessions ?? 0;
        for (const [rankIndex, item] of result.items.slice(0, 10).entries()) {
          hotspots.top10Items += 1;
          const path = normalizePath(item.path, project.context);
          byRank[rankIndex].items += 1;
          bump(byRank[rankIndex].categories, category(path));
          if (hubSet.has(path)) byRank[rankIndex].hub += 1;
          if (withFiles > 0 && typeof item.sessionCount === "number") sessionShares.push(Math.min(1, item.sessionCount / withFiles));
          if (hubSet.has(path)) {
            hotspots.top10Hub += 1;
            bump(hotspots.hubByCategory, category(path));
            any = true;
          }
        }
        if (any) hotspots.projectsWithHubInTop10 += 1;
      } catch (error) {
        bump(hotspots.errors, errorClass(error));
      }
    }
    impact.hotspots = {
      ...hotspots,
      top10HubShare: ratio(hotspots.top10Hub, hotspots.top10Items),
      byRank,
      top10SessionShare: {
        definition: "hotspot Sessions / project Sessions with changed files",
        ...summary(sessionShares),
      },
    };

    // staleness
    const stale = { activeWithAppliesTo: 0, possiblyStale: 0, stalenessUnchecked: 0, allPathsHub: 0, triggeredByOver20FileSession: 0 };
    const sessionFileCount = raw.prepare(
      `SELECT CASE WHEN json_valid(changed_files_json) AND json_type(changed_files_json) = 'array'
                   THEN json_array_length(changed_files_json) ELSE 0 END AS n FROM sessions WHERE id = ?`,
    );
    for (const item of activeKnowledge()) {
      if (item.appliesTo === 0) continue;
      stale.activeWithAppliesTo += 1;
      if (item.unchecked) stale.stalenessUnchecked += 1;
      if (!item.stale) continue;
      stale.possiblyStale += 1;
      const project = projectById.get(item.projectId);
      const hubSet = sets.get(item.projectId) ?? new Set();
      const paths = item.stale.paths.map((path) => normalizePath(path, project.context));
      if (paths.length > 0 && paths.every((path) => hubSet.has(path))) stale.allPathsHub += 1;
      const trigger = sessionFileCount.get(item.stale.sessionId);
      if (trigger && trigger.n > BROAD_FILES) stale.triggeredByOver20FileSession += 1;
    }
    impact.staleness = {
      ...stale,
      possiblyStaleShare: ratio(stale.possiblyStale, stale.activeWithAppliesTo),
      allPathsHubShare: ratio(stale.allPathsHub, stale.possiblyStale),
    };

    // derived graph
    const derived = { projectsTried: 0, projectsFailed: 0, errorClasses: {} };
    for (const project of callProjects) {
      derived.projectsTried += 1;
      try {
        store.getGraph({ projectId: project.id, includeDerived: true });
      } catch (error) {
        derived.projectsFailed += 1;
        bump(derived.errorClasses, errorClass(error));
      }
    }
    impact.derivedGraph = { ...derived, derivedGraphError: derived.projectsFailed > 0 };
    report.hubs = { ...hubSections, impact };
  }

  // ---- section 4: confirmed Knowledge protection -------------------------------------------------------------
  /** Breadth of active Knowledge appliesTo over the project's non-voided Sessions with changed files. */
  const appliesToBreadth = (active, staleByVariant) => {
    const bucketOf = (value) =>
      value === 0 ? "0" : value <= 0.05 ? "(0,0.05]" : value <= 0.1 ? "(0.05,0.1]" : value <= 0.2 ? "(0.1,0.2]" : value <= 0.4 ? "(0.2,0.4]" : "(0.4,1]";
    const newDistribution = () => ({ values: [], buckets: { "0": 0, "(0,0.05]": 0, "(0.05,0.1]": 0, "(0.1,0.2]": 0, "(0.2,0.4]": 0, "(0.4,1]": 0 } });
    const add = (distribution, value) => {
      distribution.values.push(value);
      distribution.buckets[bucketOf(value)] += 1;
    };
    const finish = (distribution) => ({ buckets: distribution.buckets, ...summary(distribution.values) });
    const sessionsByProject = new Map();
    for (const data of sessionFiles().values()) {
      if (data.paths.size === 0) continue;
      if (!sessionsByProject.has(data.projectId)) sessionsByProject.set(data.projectId, []);
      sessionsByProject.get(data.projectId).push(data);
    }
    const coverCache = new Map(); // projectId -> Map(entry -> Set of distinct covered paths)
    const coveredPaths = (projectId, entry, sessions) => {
      if (!coverCache.has(projectId)) coverCache.set(projectId, new Map());
      const cache = coverCache.get(projectId);
      if (cache.has(entry)) return cache.get(entry);
      const distinct = new Set();
      for (const data of sessions) for (const path of data.paths) distinct.add(path);
      const covered = new Set();
      for (const path of distinct) if (entryCovers(entry, path)) covered.add(path);
      cache.set(entry, covered);
      return covered;
    };
    const all = newDistribution();
    const focusedAll = newDistribution();
    const byStale = { yes: newDistribution(), no: newDistribution() };
    const staleByTrigger = { 1: newDistribution(), "2-9": newDistribution(), "10+": newDistribution() };
    const baselineStale = staleByVariant.baseline;
    const cappedStale = staleByVariant.excludeOver20;
    const focusedCounts = { atLeast0_1: 0, atLeast0_2: 0, stale0_1: 0, stale0_2: 0, cappedStale0_1: 0, cappedStale0_2: 0 };
    const entries = { total: 0, broad: 0, knowledgeWithBroadEntry: 0, knowledge: 0 };
    let knowledgeCount = 0;
    for (const item of active) {
      if (item.appliesTo === 0) continue;
      const patterns = appliesToOf(item.id);
      const sessions = sessionsByProject.get(item.projectId) ?? [];
      if (patterns.length === 0 || sessions.length === 0) continue;
      knowledgeCount += 1;
      const focusedSessions = sessions.filter((data) => data.count <= BROAD_FILES);
      const covers = patterns.map((pattern) => coveredPaths(item.projectId, pattern, sessions));
      const share = (list, sets) =>
        list.length === 0 ? 0 : list.filter((data) => sets.some((set) => [...data.paths].some((path) => set.has(path)))).length / list.length;
      const breadth = share(sessions, covers);
      const breadthFocused = share(focusedSessions, covers);
      add(all, breadth);
      add(focusedAll, breadthFocused);
      const staleInfo = baselineStale ? baselineStale.get(item.id) : item.stale;
      const isStale = Boolean(staleInfo);
      add(isStale ? byStale.yes : byStale.no, breadth);
      if (isStale) {
        const count = staleInfo.sessionCount ?? 0;
        add(staleByTrigger[count <= 1 ? "1" : count <= 9 ? "2-9" : "10+"], breadth);
      }
      for (const [threshold, key] of [
        [0.1, "0_1"],
        [0.2, "0_2"],
      ]) {
        if (breadthFocused < threshold - 1e-9) continue;
        focusedCounts[`atLeast${key}`] += 1;
        if (isStale) focusedCounts[`stale${key}`] += 1;
        if (cappedStale?.has(item.id)) focusedCounts[`cappedStale${key}`] += 1;
      }
      let anyBroad = false;
      for (const set of covers) {
        entries.total += 1;
        if (share(sessions, [set]) >= 0.1 - 1e-9) {
          entries.broad += 1;
          anyBroad = true;
        }
      }
      entries.knowledge += 1;
      if (anyBroad) entries.knowledgeWithBroadEntry += 1;
    }
    return {
      definition:
        "share of the project's non-voided Sessions with changed files covered (appliesToStrength > 0, normalized paths) by any appliesTo entry; breadthFocused only over Sessions with <= 20 changed files",
      knowledge: knowledgeCount,
      breadth: finish(all),
      breadthFocused: finish(focusedAll),
      byBaselinePossiblyStale: { yes: finish(byStale.yes), no: finish(byStale.no) },
      possiblyStaleByTriggerSessionCount: {
        1: finish(staleByTrigger["1"]),
        "2-9": finish(staleByTrigger["2-9"]),
        "10+": finish(staleByTrigger["10+"]),
      },
      breadthFocusedAtLeast: {
        "0.1": {
          knowledge: focusedCounts.atLeast0_1,
          possiblyStaleBaseline: focusedCounts.stale0_1,
          possiblyStaleExcludeOver20: focusedCounts.cappedStale0_1,
        },
        "0.2": {
          knowledge: focusedCounts.atLeast0_2,
          possiblyStaleBaseline: focusedCounts.stale0_2,
          possiblyStaleExcludeOver20: focusedCounts.cappedStale0_2,
        },
      },
      broadEntries: {
        entries: entries.total,
        broad: entries.broad,
        broadShare: ratio(entries.broad, entries.total),
        knowledgeWithBroadEntry: entries.knowledgeWithBroadEntry,
        knowledgeWithBroadEntryShare: ratio(entries.knowledgeWithBroadEntry, entries.knowledge),
      },
    };
  };
  /**
   * Write-time width estimate on the temp copy: the product's read-only scan (newest focused Sessions of the project,
   * run now, not as of the day the Knowledge was written) for each active Knowledge with appliesTo. Nothing is written.
   */
  const writeTimeBreadth = (active, staleById) => {
    if (!scanAppliesToBreadth) return { available: false, reason: "scanAppliesToBreadth is not exported by this build" };
    const shareBuckets = { "0": 0, "(0,0.05]": 0, "(0.05,0.15]": 0, "(0.15,0.3]": 0, "(0.3,0.6]": 0, "(0.6,1]": 0 };
    const rawApplies = raw.prepare("SELECT applies_to_json AS j FROM knowledge WHERE id = ?");
    const shares = [];
    const sessionCounts = [];
    const record = {
      scanned: 0,
      errors: {},
      noBreadth: 0,
      unchecked: 0,
      truncated: 0,
      broad: 0,
      broadAndPossiblyStale: 0,
      notBroadAndPossiblyStale: 0,
      broadAndBroadStaleReason: 0,
      broadStaleReasonButNotBroad: 0,
    };
    for (const item of active) {
      if (item.appliesTo === 0) continue;
      const project = projectById.get(item.projectId);
      if (!project) continue;
      let entries = [];
      try {
        const parsed = JSON.parse(rawApplies.get(item.id)?.j ?? "[]");
        if (Array.isArray(parsed)) entries = parsed.filter((entry) => typeof entry === "string");
      } catch {
        entries = [];
      }
      try {
        const scan = scanAppliesToBreadth(raw, item.projectId, project.context, entries);
        record.scanned += 1;
        if (scan.unchecked) record.unchecked += 1;
        if (!scan.breadth) {
          record.noBreadth += 1;
          continue;
        }
        shares.push(scan.breadth.share);
        sessionCounts.push(scan.breadth.sessions);
        const share = scan.breadth.share;
        bump(
          shareBuckets,
          share <= 0 ? "0" : share <= 0.05 ? "(0,0.05]" : share <= 0.15 ? "(0.05,0.15]" : share <= 0.3 ? "(0.15,0.3]" : share <= 0.6 ? "(0.3,0.6]" : "(0.6,1]",
        );
        if (scan.breadth.truncated) record.truncated += 1;
        const stale = staleById.get(item.id);
        if (scan.broad) {
          record.broad += 1;
          if (stale) record.broadAndPossiblyStale += 1;
          if (stale?.reason === "broad_applies_to") record.broadAndBroadStaleReason += 1;
        } else {
          if (stale) record.notBroadAndPossiblyStale += 1;
          if (stale?.reason === "broad_applies_to") record.broadStaleReasonButNotBroad += 1;
        }
      } catch (error) {
        bump(record.errors, errorClass(error));
      }
    }
    return {
      available: true,
      definition:
        "knowledge-breadth scan on the temp copy: share of the project's newest 200 focused Sessions (1-20 changed files) touched by appliesTo, as of now; broad = share > 0.15 over >= 10 Sessions",
      ...record,
      broadShare: ratio(record.broad, record.scanned - record.noBreadth),
      share: { buckets: shareBuckets, ...summary(shares) },
      sessions: summary(sessionCounts),
    };
  };
  const scope = `FROM knowledge k JOIN projects p ON p.id = k.project_id WHERE p.status = 'tracked'`;
  const one = (sql, ...params) => raw.prepare(sql).get(...params).c;
  if (sections.has("4")) {
    const feedback = {};
    for (const row of raw
      .prepare(
        `SELECT f.kind, COUNT(*) AS c FROM knowledge_feedback f JOIN projects p ON p.id = f.project_id
         WHERE p.status = 'tracked' GROUP BY f.kind`,
      )
      .all()) {
      feedback[row.kind] = row.c;
    }
    const manualIds = new Set(
      raw
        .prepare(
          `SELECT DISTINCT f.knowledge_id AS id FROM knowledge_feedback f JOIN projects p ON p.id = f.project_id
           WHERE p.status = 'tracked' AND f.kind = 'manual_confirm'`,
        )
        .all()
        .map((row) => row.id),
    );
    const active = activeKnowledge();
    const confirmedStale = active.filter((item) => item.stale && (item.lastConfirmedAt || item.confirmed > 0));
    const gapDays = [];
    const gapBuckets = {};
    for (const item of confirmedStale) {
      if (!item.lastConfirmedAt) continue;
      const days = (Date.parse(item.stale.completedAt) - Date.parse(item.lastConfirmedAt)) / DAY_MS;
      if (!Number.isFinite(days)) continue;
      gapDays.push(days);
      bump(gapBuckets, days < 0 ? "<0" : days < 1 ? "0-1" : days < 7 ? "1-7" : days < 30 ? "7-30" : days < 90 ? "30-90" : "90+");
    }
    const rolledByManual = one(
      `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.last_confirmed_at IS NOT NULL AND k.last_confirmed_at <
         (SELECT MAX(f.occurred_at) FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.kind = 'manual_confirm')`,
    );
    const rolledByCreation = one(
      `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.last_confirmed_at IS NOT NULL
         AND k.last_confirmed_at < k.created_at`,
    );
    const rolledUnion = one(
      `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.last_confirmed_at IS NOT NULL AND (
         k.last_confirmed_at < k.created_at OR k.last_confirmed_at <
         COALESCE((SELECT MAX(f.occurred_at) FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.kind = 'manual_confirm'), ''))`,
    );
    report.protection = {
      knowledge: {
        total: one(`SELECT COUNT(*) AS c ${scope}`),
        active: one(`SELECT COUNT(*) AS c ${scope} AND k.status = 'active'`),
        archived: one(`SELECT COUNT(*) AS c ${scope} AND k.status = 'archived'`),
        activeWithLastConfirmedAt: one(`SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.last_confirmed_at IS NOT NULL`),
      },
      feedbackByKind: feedback,
      activeWithManualConfirm: active.filter((item) => manualIds.has(item.id)).length,
      confirmedAndPossiblyStale: confirmedStale.length,
      manualConfirmAndPossiblyStale: active.filter((item) => item.stale && manualIds.has(item.id)).length,
      daysFromConfirmationToStaleTrigger: { buckets: gapBuckets, ...summary(gapDays) },
      archivedManualConfirmedAndSuperseded: one(
        `SELECT COUNT(*) AS c ${scope} AND k.status = 'archived'
           AND EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.kind = 'manual_confirm')
           AND EXISTS (SELECT 1 FROM knowledge n WHERE n.supersedes_id = k.id)`,
      ),
      baselineRolledBack: { total: rolledUnion, behindManualConfirm: rolledByManual, behindCreation: rolledByCreation },
      feedbackOnVoidedSession: one(
        `SELECT COUNT(*) AS c FROM knowledge_feedback f JOIN projects p ON p.id = f.project_id
         JOIN sessions s ON s.id = f.session_id WHERE p.status = 'tracked' AND s.voided_at IS NOT NULL`,
      ),
      supersedeConflict: one(
        `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.supersedes_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM knowledge o WHERE o.id = k.supersedes_id AND o.status = 'active')`,
      ),
    };

    // Staleness counterfactuals on second temp copies (the first copy and its store stay as they are).
    const variantSpecs = {
      baseline: { over20: false, hubs: false },
      excludeOver20: { over20: true, hubs: false },
      excludeHubs: { over20: false, hubs: true },
      both: { over20: true, hubs: true },
    };
    const hubSets = hubs().sets;
    const variantReport = {};
    const staleByVariant = {};
    for (const [name, spec] of Object.entries(variantSpecs)) {
      const target = join(sourceInfo.directory, `variant-${name}.sqlite`);
      let variantStore;
      try {
        writeStalenessVariant(sourceInfo.copyPath, target, spec, hubSets, projectById);
        variantStore = new WorkIntelligenceStore(target);
        const items = loadActiveKnowledge(variantStore, projects);
        const withApplies = items.filter((item) => item.appliesTo > 0);
        const staleItems = withApplies.filter((item) => item.stale);
        staleByVariant[name] = new Map(staleItems.map((item) => [item.id, item.stale]));
        variantReport[name] = stalenessShape(items, manualIds);
        if (name === "baseline") {
          const histogram = { 1: 0, 2: 0, "3-5": 0, "6-10": 0, "11+": 0 };
          for (const item of staleItems) {
            const count = item.stale.sessionCount ?? 0;
            bump(histogram, count <= 2 ? String(Math.max(1, count)) : count <= 5 ? "3-5" : count <= 10 ? "6-10" : "11+");
          }
          report.protection.stalenessCounterfactuals = { possiblyStaleTriggerSessionCount: histogram };
        }
      } catch (error) {
        variantReport[name] = { error: errorClass(error) };
      } finally {
        try {
          variantStore?.close();
        } catch {
          // The variant copy is deleted next.
        }
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
      }
    }
    // Validation: with the broad-Session split in the product, excludeOver20 should be close to the baseline.
    if (staleByVariant.baseline && staleByVariant.excludeOver20 && variantReport.excludeOver20?.possiblyStale !== undefined) {
      let onlyBaseline = 0;
      let onlyVariant = 0;
      for (const id of staleByVariant.baseline.keys()) if (!staleByVariant.excludeOver20.has(id)) onlyBaseline += 1;
      for (const id of staleByVariant.excludeOver20.keys()) if (!staleByVariant.baseline.has(id)) onlyVariant += 1;
      variantReport.excludeOver20.differenceFromBaseline = {
        possiblyStaleOnlyInBaseline: onlyBaseline,
        possiblyStaleOnlyInVariant: onlyVariant,
      };
    }
    report.protection.stalenessShape = {
      definition:
        "active Knowledge with appliesTo as the first copy's store reports it; possiblyStaleReason counts '(absent)' on builds without the field; broadChangesSinceOnly = broadChangesSince > 0 and no possiblyStale",
      ...stalenessShape(active, manualIds),
    };
    report.protection.writeTimeBreadth = writeTimeBreadth(
      active,
      new Map(active.filter((item) => item.stale).map((item) => [item.id, item.stale])),
    );
    let staleDroppedByCap;
    if (staleByVariant.baseline && staleByVariant.excludeOver20) {
      const histogram = { "21-50": 0, "51-100": 0, "101-300": 0, "301+": 0, "<=20": 0, unknown: 0 };
      let dropped = 0;
      const fileCount = raw.prepare(
        `SELECT CASE WHEN json_valid(changed_files_json) AND json_type(changed_files_json) = 'array'
           THEN json_array_length(changed_files_json) END AS c FROM sessions WHERE id = ?`,
      );
      for (const [id, stale] of staleByVariant.baseline) {
        if (staleByVariant.excludeOver20.has(id)) continue;
        dropped += 1;
        const count = stale.sessionId ? fileCount.get(stale.sessionId)?.c : undefined;
        bump(
          histogram,
          typeof count !== "number"
            ? "unknown"
            : count <= BROAD_FILES
              ? "<=20"
              : count <= 50
                ? "21-50"
                : count <= 100
                  ? "51-100"
                  : count <= 300
                    ? "101-300"
                    : "301+",
        );
      }
      staleDroppedByCap = {
        n: dropped,
        method:
          "approximation: changed-file count of the Session baseline reports in possiblyStale.sessionId; other >20-file triggers of the same Knowledge are not recomputed",
        changedFilesHistogram: histogram,
      };
    }
    report.protection.appliesToBreadth = appliesToBreadth(activeKnowledge(), staleByVariant);
    report.protection.stalenessCounterfactuals = {
      ...report.protection.stalenessCounterfactuals,
      ...(staleDroppedByCap ? { staleDroppedByCap } : {}),
      definition: "hub = path touched by >= hubShare of a project's Sessions with changed files (and >= 5 Sessions)",
      variants: variantReport,
    };
  }

  // ---- section 5: health checklist ---------------------------------------------------------------------------
  if (sections.has("5")) {
    const byKind = {};
    for (const row of raw
      .prepare(
        `SELECT k.kind AS kind, COUNT(*) AS c ${scope} AND k.status = 'active'
           AND (CASE WHEN json_valid(k.applies_to_json) THEN json_array_length(k.applies_to_json) ELSE 0 END) = 0
         GROUP BY k.kind`,
      )
      .all()) {
      byKind[row.kind] = row.c;
    }
    const pageReport = { projects: 0, errors: {}, total: 0, needsReview: 0, reasonsByPage: {}, needsReviewWithoutReasons: 0 };
    for (const project of projects) {
      try {
        const result = store.listKnowledgePages({ projectId: project.id });
        if (result.outcome !== "knowledge_pages") continue;
        pageReport.projects += 1;
        for (const page of result.items) {
          pageReport.total += 1;
          if (!page.needsReview) continue;
          pageReport.needsReview += 1;
          const reasons = new Set();
          for (const section of page.reviewSections ?? []) {
            for (const reason of section.reasons ?? []) reasons.add(reason);
            for (const source of section.sources ?? []) for (const reason of source.reasons ?? []) reasons.add(reason);
          }
          if (reasons.size === 0) pageReport.needsReviewWithoutReasons += 1;
          for (const reason of reasons) bump(pageReport.reasonsByPage, reason);
        }
      } catch (error) {
        bump(pageReport.errors, errorClass(error));
      }
    }
    report.health = {
      activeWithoutSession: {
        orphanedAfterSessionDeletion: one(
          `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.session_id IS NULL AND EXISTS (
             SELECT 1 FROM knowledge_audit a WHERE a.knowledge_id = k.id AND a.action = 'created'
               AND json_extract(a.after_json, '$.sessionId') IS NOT NULL)`,
        ),
        manual: one(
          `SELECT COUNT(*) AS c ${scope} AND k.status = 'active' AND k.session_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM knowledge_audit a WHERE a.knowledge_id = k.id AND a.action = 'created'
               AND json_extract(a.after_json, '$.sessionId') IS NOT NULL)`,
        ),
      },
      activeWithoutAppliesToByKind: byKind,
      activeWithVoidedSession: one(
        `SELECT COUNT(*) AS c ${scope} AND k.status = 'active'
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = k.session_id AND s.voided_at IS NOT NULL)`,
      ),
      supersedesMissingRow: one(
        `SELECT COUNT(*) AS c ${scope} AND k.supersedes_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM knowledge o WHERE o.id = k.supersedes_id)`,
      ),
      knowledgePages: pageReport,
      searchDirtyRowsOnSource: sourceInfo.searchDirty,
      sessionsWithMalformedChangedFiles: one(
        `SELECT COUNT(*) AS c FROM sessions
         WHERE CASE WHEN json_valid(changed_files_json) THEN json_type(changed_files_json) <> 'array' ELSE 1 END`,
      ),
    };
  }
  return { report, known };
}

// ---------------------------------------------------------------------------------------------------------------
// Leak scan
// ---------------------------------------------------------------------------------------------------------------
/** The fixed vocabulary of the output: every key and string value (all defined by this file, never by the data). */
function vocabulary(value, into = new Set()) {
  if (Array.isArray(value)) for (const item of value) vocabulary(item, into);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      vocabulary(child, into);
    }
  } else if (typeof value === "string") into.add(value);
  return into;
}

/** True when the serialized output contains a database string that is not itself one of its fixed labels. */
function leaks(report, known) {
  const text = JSON.stringify(report);
  const fixed = vocabulary(report);
  for (const value of known) {
    if (fixed.has(value)) continue;
    if (text.includes(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------
async function probe(databasePath, options) {
  const directory = mkdtempSync(join(tmpdir(), "wi-retrieval-trust-"));
  chmodSync(directory, 0o700);
  let store;
  let raw;
  try {
    const copied = await copyDatabase(databasePath, directory);
    if (options.treatAllTracked) treatAllTracked(copied.copyPath, directory);
    store = new WorkIntelligenceStore(copied.copyPath);
    raw = new DatabaseSync(copied.copyPath, { readOnly: true });
    return analyze(store, raw, options, { ...copied, directory });
  } finally {
    try {
      raw?.close();
    } catch {
      // The temp copy is deleted next.
    }
    try {
      store?.close();
    } catch {
      // The temp copy is deleted next.
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check: a fictional database
// ---------------------------------------------------------------------------------------------------------------
function seedSynthetic(databasePath, base) {
  const rootA = join(base, "fictional-harbor");
  const rootB = join(base, "fictional-meadow");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  const store = new WorkIntelligenceStore(databasePath);
  const observed = {};
  let counter = 0;
  const addProject = (name, root) => {
    const project = store.addProject(name, root);
    store.updateProject(project.id, { status: "tracked" });
    return project;
  };
  const session = (root, title, files, extra = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `trust-session-${counter++}`,
      startedAt: new Date().toISOString(),
      title,
      summary: `${title}.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: files,
      verification: { status: "passed" },
      ...extra,
    });
    if (result.outcome !== "finalized") throw new Error("seed session failed");
    return result.session.id;
  };
  const knowledge = (root, title, body, extra = {}) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `trust-knowledge-${counter++}`,
      kind: "pattern",
      title,
      body,
      ...extra,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("seed knowledge failed");
    return result.knowledge.id;
  };
  const projectA = addProject("Fictional harbor", rootA);
  addProject("Fictional meadow", rootB);

  // Confirmed Knowledge scoped to the hub file, recorded before the Sessions so they make it possibly stale.
  const hubKnowledge = knowledge(rootA, "Plover dock manifest rule", "Keep the dock manifest sorted.", { appliesTo: ["package.json"] });
  tick();
  assert.equal(store.updateKnowledge({ projectRoot: rootA, knowledgeId: hubKnowledge, confirm: true }).outcome, "knowledge_updated");

  // Fourteen Sessions; package.json is in nine of them. Two share one feature file (not a hub).
  const themes = ["lantern", "buoy", "mooring", "kelp", "tide"];
  for (let i = 0; i < 14; i += 1) {
    const files = [`src/${themes[i % themes.length]}/part-${i}.ts`];
    if (i < 9) files.push("package.json");
    if (i === 12 || i === 13) files.push("src/tide/gauge.ts");
    session(rootA, `Calibrate ${themes[i % themes.length]} winch batch ${i}`, files);
  }
  // Dilution demo: two Sessions share a distinctive phrase.
  session(rootA, "Quokka marmalade resonance tuning", ["src/quokka/tune.ts"]);
  session(rootA, "Quokka marmalade resonance cleanup", ["src/quokka/clean.ts"]);
  // A voided Session carrying feedback.
  const voided = session(rootA, "Rinse bilge pump sample", ["src/bilge/pump.ts"]);

  // Past-only recall, Knowledge search quality and staleness counterfactuals: Sessions on earlier calendar days, a
  // Session that applied an earlier Knowledge (a positive query), and a >20-file Session that alone makes it stale.
  const dayMs = 24 * 60 * 60 * 1000;
  const capstan = knowledge(rootA, "Capstan grease schedule rule", "Grease the capstan monthly.", {
    appliesTo: ["src/wide/file-3.ts"],
  });
  for (let i = 0; i < 3; i += 1) {
    const start = Date.now() - 5 * dayMs - i * 3_600_000;
    session(rootA, `Capstan grease schedule survey ${i}`, [`src/capstan/old-${i}.ts`], {
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(start + 600_000).toISOString(),
    });
  }
  session(rootA, "Capstan grease schedule inspection", ["src/capstan/inspect.ts"], { appliedKnowledgeIds: [capstan] });
  // A second positive whose truth Knowledge is updated after the Session started (invisible to pastOnly).
  const sextant = knowledge(rootA, "Sextant polish routine rule", "Polish the sextant lenses weekly.", {
    appliesTo: ["src/sextant/check.ts"],
  });
  session(rootA, "Sextant polish routine check", ["src/sextant/check.ts"], { appliedKnowledgeIds: [sextant] });
  const gaugeSession = session(rootA, "Gauge calibration log review", ["src/gauge/log.ts"]);
  knowledge(rootA, "Gauge calibration log convention", "Review gauge logs weekly.", { sessionId: gaugeSession });
  session(
    rootA,
    "Resurface the wide deck",
    Array.from({ length: 22 }, (_, index) => `src/wide/file-${index}.ts`),
  );

  // Only a broad Session (> 20 changed files) touches this Knowledge: broadChangesSince without possiblyStale.
  knowledge(rootA, "Windlass rigging inspection rule", "Inspect the windlass rigging before sailing.", {
    appliesTo: ["src/bulk/zone.ts"],
  });
  session(
    rootA,
    "Sweep the bulk zone",
    ["src/bulk/zone.ts", ...Array.from({ length: 24 }, (_, index) => `src/bulk/other-${index}.ts`)],
  );
  // One narrow appliesTo touched by a single small Session: possiblyStale with reason applies_to_changed.
  knowledge(rootA, "Reef survey cadence rule", "Survey the reef every spring.", { appliesTo: ["src/reef/survey.ts"] });
  session(rootA, "Reef survey redo", ["src/reef/survey.ts"]);
  // Synonym-only matches: "endpoint" and "route" are built-in synonyms and these titles share no other word.
  session(rootA, "Aurora endpoint", ["src/aurora/endpoint.ts"]);
  session(rootA, "Borealis route", ["src/borealis/route.ts"]);

  // Project C: more Sessions than the 50 a path search loads, every fourth one sharing a hub file.
  const rootC = join(base, "fictional-orchard");
  mkdirSync(rootC, { recursive: true });
  addProject("Fictional orchard", rootC);
  for (let i = 0; i < 55; i += 1) {
    session(rootC, `Prune orchard row ${i}`, i % 4 === 0 ? [`src/row/r-${i}.ts`, "src/row/shared.ts"] : [`src/row/r-${i}.ts`]);
  }

  // Project B: Sessions with two files each, two of them later broken by SQL.
  const brokenIds = [];
  for (let i = 0; i < 4; i += 1) {
    const id = session(rootB, `Weed meadow plot ${i}`, [`src/plot/a-${i}.ts`, `src/plot/b-${i}.ts`]);
    if (i < 2) brokenIds.push(id);
  }

  // A wide appliesTo (a whole directory) touched by twelve small Sessions after it was recorded: broad_applies_to.
  knowledge(rootB, "Quarry bed tilling convention", "Till the quarry beds in rows.", { appliesTo: ["src/quarry/"] });
  for (let i = 0; i < 12; i += 1) session(rootB, `Till quarry bed ${i}`, [`src/quarry/bed-${i}.ts`]);

  // Baseline rollback: a manual confirmation followed by a backdated "applied" feedback.
  const rollback = knowledge(rootA, "Teal ferry timetable fact", "The ferry runs hourly.");
  tick();
  store.updateKnowledge({ projectRoot: rootA, knowledgeId: rollback, confirm: true });
  const afterManual = store.searchKnowledge({ projectId: projectA.id, status: "active", pageSize: 200 }).items.find((item) => item.id === rollback);
  session(rootA, "Apply the ferry fact backdated", ["src/ferry/note.ts"], {
    appliedKnowledgeIds: [rollback],
    completedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const afterBackdated = store.searchKnowledge({ projectId: projectA.id, status: "active", pageSize: 200 }).items.find((item) => item.id === rollback);
  observed.backdatedFinalize = {
    lastConfirmedAtMovedBackwards: afterBackdated.lastConfirmedAt < afterManual.lastConfirmedAt,
  };

  // Supersede conflict: restore a superseded record.
  const older = knowledge(rootA, "Amber ledger convention", "Write ledgers in amber ink.");
  knowledge(rootA, "Amber ledger convention revised", "Write ledgers in teal ink.", { supersedesId: older });
  const restored = store.updateKnowledge({ projectRoot: rootA, knowledgeId: older, status: "active" });
  observed.restoreSuperseded = { outcome: restored.outcome };
  knowledge(rootA, "Free-standing manual note", "A note without a Session.");

  // A manual confirmation on a Knowledge whose feedback Session is voided later.
  const voidedKnowledge = knowledge(rootA, "Pelican roost count", "Counted weekly.", { sessionId: voided });
  store.setSessionVoid({ sessionId: voided, voided: true, reason: "synthetic" });
  observed.voidedKnowledgeExists = Boolean(voidedKnowledge);
  store.close();

  // Malformed changed_files_json by SQL, then see what the derived graph does with it.
  const writer = new DatabaseSync(databasePath);
  writer.prepare("UPDATE sessions SET changed_files_json = 'not json' WHERE id = ?").run(brokenIds[0]);
  writer.prepare("UPDATE sessions SET changed_files_json = 'null' WHERE id = ?").run(brokenIds[1]);
  const earlier = new Date(Date.now() - 6 * dayMs).toISOString();
  writer.prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?").run(earlier, earlier, capstan);
  writer
    .prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(earlier, new Date(Date.now() + 3_600_000).toISOString(), sextant);
  writer.close();
  return { rootA, rootB, observed };
}

async function selfCheck() {
  const base = mkdtempSync(join(tmpdir(), "wi-retrieval-trust-selfcheck-"));
  chmodSync(base, 0o700);
  try {
    const databasePath = join(base, "synthetic.sqlite");
    const { rootA, observed } = seedSynthetic(databasePath, base);
    const options = {
      sample: 200,
      seed: 1,
      hubShare: 0.2,
      sections: new Set(ALL_SECTIONS),
      contextSample: 50,
      relatedSample: 100,
      pairSample: 60,
      windowPairSample: 40,
      hotspotLimit: 20,
    };
    const { report, known } = await probe(databasePath, options);

    // Hubs: package.json is in 9 of 14+ Sessions of the harbor project.
    const harbor = report.hubs.projects.listed.find(
      (row) => row.sessionsWithChangedFiles > 10 && row.pathsAtLeast["25%"] >= 1,
    );
    assert(harbor, "the harbor project is listed with a 25% hub (package.json)");
    assert(report.hubs.pooled.hubCategories.manifest >= 1, "the manifest hub is categorized");
    assert(report.hubs.impact.relatedWork.hubOnlyRelated > 0, "a related-work result is hub-only");
    assert(report.hubs.impact.staleness.possiblyStale >= 1, "the hub-scoped Knowledge is possibly stale");
    assert(report.hubs.impact.staleness.allPathsHub >= 1, "its stale paths are all hub paths");
    assert.equal(report.hubs.pooled.malformedChangedFiles, 2, "the two planted rows are counted");
    assert.equal(report.health.sessionsWithMalformedChangedFiles, 2);

    // Answerability controls.
    const answer = report.answerability;
    assert(answer.queries > 10, "queries ran");
    assert.equal(answer.controls.nonsenseOnly.confidence.none, answer.controls.nonsenseOnly.queries, "nonsense -> none");
    assert.equal(answer.controls.nonsenseOnly.allTermsZero, answer.controls.nonsenseOnly.queries, "nonsense terms are all zero");
    assert(report.producedBy.matchedInCombos && Object.keys(report.producedBy.matchedInCombos).length > 0);
    // The current build names synonym-only hits through matchedVia and trims matchedIn at the MCP layer, not here.
    assert.equal(report.producedBy.synonymOnlyDetectable, report.productShape.recallHasKnowledgeConfidence);
    assert.equal(Object.values(report.producedBy.matchedInLengthHistogram).reduce((a, b) => a + b, 0), report.producedBy.nonSelfHits);

    // Protection / health: shapes and counts that do not depend on the suspected defects.
    assert(report.protection.knowledge.active >= 5);
    assert(report.protection.feedbackByKind.manual_confirm >= 2);
    assert(report.protection.activeWithManualConfirm >= 2);
    assert.equal(report.health.activeWithoutSession.manual >= 1, true);
    assert.equal(report.health.activeWithoutAppliesToByKind.pattern >= 1, true);

    // Past-only recall: Sessions on earlier days, one positive query (it applied an earlier Knowledge).
    const past = answer.pastOnly;
    assert(past.queries > 10, "past-only queries ran");
    assert.equal(past.positives.n + past.negatives.n, past.queries, "every past-only query is a positive or a negative");
    assert(past.positives.n >= 1, "the Session that applied the capstan Knowledge is a positive");
    assert(past.positives.hitAt8 >= 1, "the applied Knowledge is found asking the day before");
    assert.equal(Object.values(past.hitsHistogram).reduce((a, b) => a + b, 0), past.queries);
    // Positive recall bounds: same split, no date filter, task-only getContext, truth updated after start.
    const bound = answer.positiveRecallBounds;
    assert.deepEqual(bound.errors, {}, "no bound errors");
    assert.equal(bound.noDateFilter.positives.n, past.positives.n, "bounds positives equal pastOnly positives");
    assert.equal(bound.noDateFilter.negatives.n, past.negatives.n, "bounds negatives equal pastOnly negatives");
    assert(past.positives.n >= 2, "capstan and sextant are both positives");
    assert(bound.noDateFilter.positives.hitAt8 >= past.positives.hitAt8, "no date filter never loses a hit");
    assert(bound.noDateFilter.positives.hitAt8 >= 2, "both truth Knowledge are found without the date filter");
    assert(bound.noDateFilter.positives.limit20.hitAt20 >= bound.noDateFilter.positives.hitAt8, "limit 20 never loses a hit");
    assert.equal(bound.noDateFilter.positives.limit20.n, past.positives.n);
    assert.equal(Object.values(bound.noDateFilter.positives.confidence).reduce((a, b) => a + b, 0), past.positives.n);
    assert.equal(bound.truthUpdatedAfterStart.positives, past.positives.n);
    assert(bound.truthUpdatedAfterStart.allTruthUpdatedAfterStart >= 1, "the sextant truth was updated after start");
    assert(bound.truthUpdatedAfterStart.allTruthUpdatedAfterStart < past.positives.n, "the capstan truth was not");
    assert(bound.truthUpdatedAfterStart.anyTruthUpdatedAfterStart >= bound.truthUpdatedAfterStart.allTruthUpdatedAfterStart);
    const taskOnly = bound.getContextTaskOnly;
    const taskPositives = taskOnly.positives;
    assert.equal(taskOnly.timeSliced, false);
    assert.equal(taskPositives.n + taskPositives.skipped + Object.values(taskPositives.errors).reduce((a, b) => a + b, 0), past.positives.n);
    assert(
      taskPositives.truthInRelevantKnowledge + taskPositives.truthInRecentKnowledgeOnly + taskPositives.truthNowhere <= taskPositives.n,
      "relevant, recent-only and nowhere are disjoint",
    );
    assert(taskPositives.truthInSupplements <= taskPositives.n);
    assert(taskPositives.truthInRelevantKnowledge >= 1, "a truth Knowledge appears in relevant.knowledge for a task-only query");
    assert(Object.values(taskPositives.relevantConfidence).reduce((a, b) => a + b, 0) === taskPositives.n);
    assert(taskOnly.negatives.n >= 1 && taskOnly.negatives.n <= taskOnly.negativeSampleLimit);
    assert(Object.values(taskOnly.negatives.relevantConfidence).reduce((a, b) => a + b, 0) === taskOnly.negatives.n);
    // Path recall baseline: the sextant truth Knowledge is scoped to the positive Session's own file.
    const pathRecall = answer.pathRecallBaseline;
    const pathPositives = pathRecall.positives;
    assert.equal(pathRecall.timeSliced, false);
    assert.equal(pathPositives.n + pathPositives.skipped + Object.values(pathPositives.errors).reduce((a, b) => a + b, 0), past.positives.n);
    assert.deepEqual(pathPositives.errors, {}, "no path recall errors");
    assert.equal(pathPositives.truthHasAppliesTo, pathPositives.n, "sextant and capstan both have appliesTo");
    assert(pathPositives.truthCoversSessionFiles < pathPositives.n, "the capstan appliesTo does not cover its Session files");
    assert(pathPositives.truthCoversSessionFiles >= 1, "the sextant appliesTo covers its Session's own file");
    assert(pathPositives.truthCoversSessionFiles <= pathPositives.truthHasAppliesTo);
    assert(pathPositives.truthInRelevantKnowledge + pathPositives.truthInSupplements >= 1, "found with the right paths");
    assert(pathPositives.foundInRelevantOrSupplementsWhenCovered >= 1, "a covered positive is found");
    assert(
      pathPositives.foundInRelevantOrSupplementsWhenCovered <= pathPositives.truthCoversSessionFiles &&
        pathPositives.foundInRelevantOrSupplementsWhenNotCovered <= pathPositives.n - pathPositives.truthCoversSessionFiles,
    );
    assert(
      pathPositives.truthInRelevantKnowledge + pathPositives.truthInRecentKnowledgeOnly + pathPositives.truthNowhere <= pathPositives.n,
      "path recall: relevant, recent-only and nowhere are disjoint",
    );
    assert.equal(Object.values(pathPositives.relevantConfidence).reduce((a, b) => a + b, 0), pathPositives.n);
    assert(pathPositives.relevantKnowledgeEmpty <= pathPositives.n);
    assert(pathRecall.negatives.n >= 1 && pathRecall.negatives.n <= pathRecall.negativeSampleLimit);
    assert.equal(Object.values(pathRecall.negatives.relevantConfidence).reduce((a, b) => a + b, 0), pathRecall.negatives.n);
    assert(pathRecall.negatives.withRelevantKnowledge <= pathRecall.negatives.n);
    // Relaxed Knowledge search quality.
    const quality = answer.knowledgeSearchQuality;
    assert(quality.queriesWithTruth >= 2, "queries with truth Knowledge exist");
    assert(quality.byMatch.relaxed.n >= 1 && quality.byMatch.relaxed.hitAt3 >= 1, "a relaxed match finds the truth Knowledge");
    assert(quality.relaxedTopMatchTermCoverage.n >= 1 && quality.relaxedTopMatchTermCoverage.max <= 1);
    // Graph path classification and the newest-50 window.
    const pathReport = report.hubs.impact.graphPath;
    const classified = pathReport.classification;
    assert.equal(classified.found + classified.noPath + classified.endpointOutsideRange, pathReport.pairs);
    assert.equal(classified.found, pathReport.found);
    const windowClassified = pathReport.inWindowPairs.classification;
    assert(pathReport.inWindowPairs.pairs > 0, "in-window pairs ran");
    assert.equal(windowClassified.endpointOutsideRange, 0, "an in-window pair is never outside the search range");
    assert(pathReport.pathGraph.projectsMeasured >= 1 && pathReport.pathGraph.newestWindowSessionsPresentShare.p50 === 1);
    assert(report.hubs.impact.hotspots.byRank.length === 10 && report.hubs.impact.hotspots.top10SessionShare.n > 0);
    // Staleness counterfactuals: the wide Session alone stales the capstan Knowledge; package.json (a hub) the other.
    const counterfactual = report.protection.stalenessCounterfactuals;
    const variants = counterfactual.variants;
    // With the broad-Session split a >20-file Session no longer triggers possiblyStale on its own (it counts in
    // broadChangesSince), so excludeOver20 equals the baseline; older builds drop the wide-Session flag instead.
    const splitShape = report.protection.stalenessShape.withBroadChangesSince > 0;
    assert(variants.baseline.possiblyStale >= (splitShape ? 1 : 2), "Knowledge is possibly stale at baseline");
    if (splitShape) {
      assert.equal(variants.excludeOver20.possiblyStale, variants.baseline.possiblyStale, "excludeOver20 is close to the baseline");
      assert.deepEqual(variants.excludeOver20.differenceFromBaseline, { possiblyStaleOnlyInBaseline: 0, possiblyStaleOnlyInVariant: 0 });
      assert.equal(variants.excludeHubs.possiblyStale, variants.baseline.possiblyStale - 1, "excludeHubs drops the package.json flag");
      assert.equal(variants.both.possiblyStale, variants.baseline.possiblyStale - 1);
    } else {
      assert.equal(variants.excludeOver20.possiblyStale, variants.baseline.possiblyStale - 1, "excludeOver20 drops the wide-Session flag");
      assert.equal(variants.excludeOver20.confirmedAndPossiblyStale, variants.baseline.confirmedAndPossiblyStale - 1);
      assert.equal(variants.excludeHubs.possiblyStale, variants.baseline.possiblyStale - 1, "excludeHubs drops the package.json flag");
      assert.equal(variants.both.possiblyStale, variants.baseline.possiblyStale - 2);
    }
    assert.equal(
      Object.values(counterfactual.possiblyStaleTriggerSessionCount).reduce((a, b) => a + b, 0),
      variants.baseline.possiblyStale,
    );
    const dropped = counterfactual.staleDroppedByCap;
    assert.equal(dropped.n, variants.baseline.possiblyStale - variants.excludeOver20.possiblyStale, "dropped = baseline minus excludeOver20");
    assert.equal(dropped.n, splitShape ? 0 : 1, "the capstan Knowledge is dropped by the cap only on builds without the split");
    assert.equal(dropped.changedFilesHistogram["21-50"], splitShape ? 0 : 1, "its 22-file trigger Session falls in 21-50");
    assert.equal(Object.values(dropped.changedFilesHistogram).reduce((a, b) => a + b, 0), dropped.n);
    // appliesTo breadth: package.json (nine Sessions of the harbor project) is broad; the single-file Knowledge is not.
    const breadth = report.protection.appliesToBreadth;
    assert(breadth.knowledge >= 3 && breadth.knowledge <= variants.baseline.activeWithAppliesTo, "breadth covers the active Knowledge with appliesTo");
    assert.equal(Object.values(breadth.breadth.buckets).reduce((a, b) => a + b, 0), breadth.knowledge);
    assert.equal(Object.values(breadth.breadthFocused.buckets).reduce((a, b) => a + b, 0), breadth.knowledge);
    assert.equal(breadth.byBaselinePossiblyStale.yes.n + breadth.byBaselinePossiblyStale.no.n, breadth.knowledge);
    assert.equal(breadth.byBaselinePossiblyStale.yes.n, variants.baseline.possiblyStale);
    assert.equal(
      Object.values(breadth.possiblyStaleByTriggerSessionCount).reduce((a, b) => a + (b.n ?? 0), 0),
      breadth.byBaselinePossiblyStale.yes.n,
    );
    assert(breadth.breadth.max > 0.2, "the package.json Knowledge covers many Sessions");
    assert(breadth.breadthFocusedAtLeast["0.1"].knowledge >= 1 && breadth.breadthFocusedAtLeast["0.2"].knowledge >= 1);
    assert(breadth.breadthFocusedAtLeast["0.2"].knowledge <= breadth.breadthFocusedAtLeast["0.1"].knowledge);
    assert(breadth.breadthFocusedAtLeast["0.1"].possiblyStaleBaseline >= 1, "the broad hub Knowledge is possibly stale at baseline");
    assert(breadth.breadthFocusedAtLeast["0.1"].possiblyStaleExcludeOver20 <= breadth.breadthFocusedAtLeast["0.1"].possiblyStaleBaseline);
    assert(breadth.broadEntries.broad >= 1 && breadth.broadEntries.broad <= breadth.broadEntries.entries);
    assert(breadth.broadEntries.knowledgeWithBroadEntry >= 1 && breadth.broadEntries.knowledgeWithBroadEntry < breadth.knowledge);
    assert(breadth.breadth.buckets["0"] + breadth.breadth.buckets["(0,0.05]"] < breadth.knowledge, "not every Knowledge is narrow");
    // Staleness shape (new product fields), write-time breadth estimate, confidence and synonym measures.
    const shape = report.protection.stalenessShape;
    assert(report.productShape.scanAppliesToBreadthExported, "the breadth scan is exported by this build");
    assert.equal(shape.activeWithAppliesTo, variants.baseline.activeWithAppliesTo);
    assert.equal(shape.possiblyStale, variants.baseline.possiblyStale);
    assert.equal(Object.values(shape.possiblyStaleReason).reduce((a, b) => a + b, 0), shape.possiblyStale);
    assert(shape.possiblyStaleReason.broad_applies_to >= 1, "a wide appliesTo touched by >= 10 small Sessions is broad_applies_to");
    assert(shape.possiblyStaleReason.applies_to_changed >= 1, "a narrow appliesTo touched by one small Session is applies_to_changed");
    assert(shape.withBroadChangesSince >= 1 && shape.broadChangesSince.max >= 1, "a >20-file Session counts in broadChangesSince");
    assert(shape.broadChangesSinceOnly >= 1, "a Knowledge touched only by a >20-file Session is not possibly stale");
    assert.equal(shape.broadChangesSinceOnly + shape.possiblyStaleAlsoWithBroadChangesSince, shape.withBroadChangesSince);
    assert.equal(shape.possiblyStaleAppliesToBreadth.present + shape.possiblyStaleAppliesToBreadth.absent, shape.possiblyStale);
    assert(shape.possiblyStaleAppliesToBreadth.sessions.max >= 10, "the breadth compares at least ten Sessions");
    assert(shape.confirmedAndPossiblyStale >= 1 && shape.manualConfirmAndPossiblyStale >= 1);
    const writeBreadth = report.protection.writeTimeBreadth;
    assert.equal(writeBreadth.available, true);
    assert.deepEqual(writeBreadth.errors, {});
    assert.equal(writeBreadth.scanned, shape.activeWithAppliesTo);
    assert(writeBreadth.broad >= 2, "the package.json and quarry appliesTo are broad at write time");
    assert(writeBreadth.broad < writeBreadth.scanned, "narrow appliesTo are not broad");
    assert(writeBreadth.share.max > 0.15 && writeBreadth.sessions.max >= 10);
    assert.equal(Object.values(writeBreadth.share.buckets).reduce((a, b) => a + b, 0), writeBreadth.scanned - writeBreadth.noBreadth);
    assert(writeBreadth.truncated <= writeBreadth.scanned);
    assert(writeBreadth.broadAndBroadStaleReason >= 1, "a broad write-time appliesTo carries the broad_applies_to reason");
    assert.equal(Object.values(answer.knowledgeConfidence).reduce((a, b) => a + b, 0), answer.queries);
    assert(answer.zeroKnowledgeHitsButHighConfidence.n >= 1, "a Session-only match gives high confidence with no Knowledge hit");
    assert.equal(answer.zeroKnowledgeHitsButHighConfidence.byKnowledgeConfidence.none, answer.zeroKnowledgeHitsButHighConfidence.n);
    assert.equal(
      Object.values(past.positives.knowledgeConfidence).reduce((a, b) => a + b, 0) + Object.values(past.negatives.knowledgeConfidence).reduce((a, b) => a + b, 0),
      past.queries,
    );
    assert(answer.getContext.relevantKnowledgeConfidence.none >= 1 && answer.getContext.knowledgeHintShare > 0, "getContext reports knowledgeConfidence and the hint");
    assert(answer.knowledgeSearch.fallbackTermHits.noneAnswers >= 1 && answer.knowledgeSearch.fallbackTermHits.noneTermHitsPresentShare === 1);
    assert(answer.knowledgeSearch.fallbackTermHits.noneAllTermsZeroShare > 0, "a zero-hit Knowledge search lists every word as 0");
    assert(report.producedBy.synonymOnlyHits >= 1, "a synonym-only hit is marked matchedVia synonym");
    assert(report.producedBy.getContextKnowledgeItems.n >= 1);
    // Policy: with no tracked project the run warns; --treat-all-tracked fixes it on the copy only.
    assert.equal(report.warnings, undefined, "a tracked run carries no warning");
    const untrackedPath = join(base, "untracked.sqlite");
    copyFileSync(databasePath, untrackedPath);
    const flipper = new DatabaseSync(untrackedPath);
    flipper.exec("UPDATE projects SET status = 'paused'");
    flipper.close();
    const warned = await probe(untrackedPath, { ...options, sections: new Set(["1"]), sample: 20 });
    assert.deepEqual(warned.report.warnings, ["no_tracked_projects"]);
    assert.equal(warned.report.counts.trackedProjects, 0);
    const treated = await probe(untrackedPath, { ...options, sections: new Set(["1"]), sample: 20, treatAllTracked: true });
    assert.equal(treated.report.options.treatAllTracked, true);
    assert.equal(treated.report.counts.trackedProjects, 3, "all projects are tracked on the copy");
    assert.equal(treated.report.warnings, undefined);
    const recheck = new DatabaseSync(untrackedPath, { readOnly: true });
    assert.equal(recheck.prepare("SELECT COUNT(*) AS c FROM projects WHERE status = 'tracked'").get().c, 0, "the source stays untouched");
    recheck.close();

    // Dilution demo on the distinctive phrase (printed, not asserted); a 40-word query for the truncation flag.
    const longQuery = Array.from({ length: 40 }, (_, index) => `word${index}x`).join(" ");
    const store = new WorkIntelligenceStore(databasePath);
    const demo = {};
    try {
      const tokens = ["zqvxblorp7", "quandlezz9", "wrkjtvh3"];
      for (const [name, count] of [
        ["base", 0],
        ["plus1", 1],
        ["plus3", 3],
      ]) {
        const result = store.recall({ q: ["quokka marmalade resonance", ...tokens.slice(0, count)].join(" "), projectRoot: rootA, limit: RECALL_LIMIT });
        demo[name] = {
          confidence: result.confidence,
          hits: result.hits.length,
          termHitsZeroTokens: (result.termHits ?? []).filter((entry) => entry.count === 0).length,
        };
      }
      const longResult = store.recall({ q: longQuery, projectRoot: rootA, limit: RECALL_LIMIT });
      demo.longQuery = { termHitsTruncated: longResult.termHitsTruncated === true, termHits: (longResult.termHits ?? []).length };
    } finally {
      store.close();
    }

    // The leak scan must catch a planted leak and pass the real output.
    assert.equal(leaks(report, known), false, "the report leaks nothing from the synthetic data");
    assert.equal(leaks({ x: "see Quokka marmalade resonance tuning here" }, known), true, "the scan detects a title");

    observed.derivedGraph = report.hubs.impact.derivedGraph;
    observed.baselineRolledBack = report.protection.baselineRolledBack;
    observed.supersedeConflict = report.protection.supersedeConflict;
    observed.dilutionDemo = demo;
    observed.stalenessShape = {
      possiblyStale: shape.possiblyStale,
      possiblyStaleReason: shape.possiblyStaleReason,
      withBroadChangesSince: shape.withBroadChangesSince,
      broadChangesSinceOnly: shape.broadChangesSinceOnly,
      possiblyStaleAppliesToBreadth: shape.possiblyStaleAppliesToBreadth,
    };
    observed.writeTimeBreadth = {
      scanned: writeBreadth.scanned,
      broad: writeBreadth.broad,
      truncated: writeBreadth.truncated,
      unchecked: writeBreadth.unchecked,
      share: writeBreadth.share,
    };
    observed.knowledgeConfidence = {
      recall: answer.knowledgeConfidence,
      zeroKnowledgeHitsButHigh: answer.zeroKnowledgeHitsButHighConfidence,
      pastOnlyPositives: past.positives.knowledgeConfidence,
      pastOnlyNegatives: past.negatives.knowledgeConfidence,
      getContextRelevant: answer.getContext.relevantKnowledgeConfidence,
      knowledgeHintShare: answer.getContext.knowledgeHintShare,
    };
    observed.synonymAndFallback = {
      synonymOnlyHits: report.producedBy.synonymOnlyHits,
      matchedInLengthHistogram: report.producedBy.matchedInLengthHistogram,
      knowledgeSearchFallbackTermHits: answer.knowledgeSearch.fallbackTermHits,
    };
    observed.appliesToBreadth = {
      knowledge: breadth.knowledge,
      breadth: breadth.breadth,
      breadthFocusedAtLeast: breadth.breadthFocusedAtLeast,
      broadEntries: breadth.broadEntries,
    };
    observed.pathRecallBaseline = {
      positives: {
        n: pathPositives.n,
        truthHasAppliesTo: pathPositives.truthHasAppliesTo,
        truthCoversSessionFiles: pathPositives.truthCoversSessionFiles,
        truthInRelevantKnowledge: pathPositives.truthInRelevantKnowledge,
        truthInSupplements: pathPositives.truthInSupplements,
        truthInSupplementsByKind: pathPositives.truthInSupplementsByKind,
        truthNowhere: pathPositives.truthNowhere,
        relevantKnowledgeEmpty: pathPositives.relevantKnowledgeEmpty,
      },
      negatives: {
        n: pathRecall.negatives.n,
        withRelevantKnowledge: pathRecall.negatives.withRelevantKnowledge,
        relevantKnowledgeEmpty: pathRecall.negatives.relevantKnowledgeEmpty,
      },
    };
    return { selfCheck: "passed", observed, report };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) {
    console.log(JSON.stringify(await selfCheck(), null, 2));
    return;
  }
  const databasePath = positional(args) ?? process.env.WORK_INTELLIGENCE_DB;
  if (!databasePath) throw Object.assign(new Error("database"), { code: "NO_DATABASE_PATH" });
  if (!existsSync(databasePath)) throw Object.assign(new Error("database"), { code: "DATABASE_NOT_FOUND" });
  const sample = intFlag(args, "--sample", 200);
  const sections = new Set((flagValue(args, "--sections") ?? ALL_SECTIONS.join(",")).split(",").map((s) => s.trim()));
  if ([...sections].some((section) => !ALL_SECTIONS.includes(section))) throw Object.assign(new Error("sections"), { code: "BAD_SECTIONS" });
  const hubShare = Number(flagValue(args, "--hub-share") ?? 0.2);
  if (!(hubShare > 0 && hubShare <= 1)) throw Object.assign(new Error("hub"), { code: "BAD_HUB_SHARE" });
  const options = {
    sample,
    seed: intFlag(args, "--seed", 1),
    hubShare,
    sections,
    contextSample: intFlag(args, "--context-sample", Math.min(50, sample)),
    relatedSample: intFlag(args, "--related-sample", Math.min(100, sample)),
    pairSample: intFlag(args, "--pair-sample", Math.min(100, sample)),
    windowPairSample: intFlag(args, "--window-pair-sample", 100),
    treatAllTracked: args.includes("--treat-all-tracked"),
    hotspotLimit: Math.min(100, Math.max(1, intFlag(args, "--hotspot-limit", 20))),
  };
  const { report, known } = await probe(databasePath, options);
  if (leaks(report, known)) {
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`error: ${errorClass(error)}\n`);
  process.exitCode = 1;
}
