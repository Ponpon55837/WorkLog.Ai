// Outstanding items probe (research experiment, read-only).
//
// Usage:
//   node docs/experiments/outstanding-items-probe.mjs --db <path> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--split YYYY-MM-DD] [--now <ISO time>]
//   node docs/experiments/outstanding-items-probe.mjs --self-check
//
// Opens the database with { readOnly: true } and prints ONE JSON object of aggregate numbers (counts, ratios,
// medians, percentiles, histogram buckets). It never prints a text, title, id, path or project name from the
// database, and its error messages are codes, never SQLite messages (which can contain data).
// Needs packages/storage/dist (pnpm build) for the reword matcher; without it the rewording numbers are null.
import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLEANUP_TABLES = [
  "outstanding_cleanup_requests",
  "outstanding_cleanup_request_items",
  "outstanding_cleanup_submissions",
  "outstanding_cleanup_proposals",
  "outstanding_cleanup_proposal_evidence",
];

// Transient-state wording (zh-TW + English). These only CLASSIFY an item; matches are never printed. All patterns are
// case-insensitive and use bounded gaps so they cannot backtrack badly. Review and tune them here.
export const TRANSIENT_CATEGORIES = {
  // Work exists in the tree but is not committed yet.
  uncommitted: /尚未\s*(?:commit|提交)|未\s*commit|未提交|待\s*commit|uncommitted|not\s+(?:yet\s+)?committed|commit\s+pending/i,
  // Commit exists locally but is not pushed.
  not_pushed: /尚未\s*push|未\s*push|未推送|尚未推送|待\s*push|unpushed|not\s+(?:yet\s+)?pushed/i,
  // PR is open: waiting for review or merge.
  pr_pending:
    /(?:待|等待).{0,6}(?:merge|合併|review|審查)|PR.{0,6}(?:尚未|未|待).{0,6}(?:merge|合併|review|審查)|未合併|尚未合併|(?:awaiting|pending|waiting\s+(?:for|on)).{0,20}(?:review|merge)|PR.{0,20}not\s+(?:yet\s+)?merged/i,
  // CI / pipeline still running.
  ci_running:
    /(?:等待|waiting\s+(?:for|on)).{0,12}\bCI\b|\bCI\b.{0,12}(?:執行中|跑完|running|in\s+progress|pending)|pipeline.{0,12}(?:running|in\s+progress)|checks?\s+(?:running|pending)/i,
  // Waiting for a subagent or a report.
  waiting_subagent:
    /(?:等待|等候|待).{0,12}(?:subagent|sub-agent|子\s*agent|子代理|回報|報告|結果)|(?:waiting\s+(?:for|on)|awaiting).{0,20}(?:subagent|sub-agent|agent|report|result)/i,
  // A phase or step that has not started.
  phase_not_started:
    /(?:階段|phase|stage|步驟|step)\s*\d*.{0,8}(?:尚未|還沒|未)\s*(?:開始|進行|執行)|(?:phase|stage|step)\s*\d*.{0,12}not\s+(?:yet\s+)?started|尚未開始|還沒開始/i,
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------
class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank percentile of an ascending array; null when empty. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)) };
}

function share(part, whole) {
  return whole === 0 ? null : round(part / whole);
}

function utcDay(iso) {
  return iso.slice(0, 10);
}

/** First index whose value is strictly greater than `value`. */
function upperBound(times, value) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] > value) high = mid;
    else low = mid + 1;
  }
  return low;
}

function emptyHistogram() {
  return Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`, 0]));
}

function bucketKey(similarity) {
  const index = Math.min(9, Math.max(0, Math.floor(similarity * 10 + 1e-9)));
  return `${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}`;
}

function changedFilePaths(json) {
  try {
    const value = JSON.parse(json ?? "[]");
    if (!Array.isArray(value)) return [];
    const paths = new Set();
    for (const entry of value) {
      if (typeof entry === "string") paths.add(entry);
      else if (entry && typeof entry.path === "string") paths.add(entry.path);
    }
    return [...paths];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Loading (single pass per table, no per-item queries)
// ---------------------------------------------------------------------------------------------------------------
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function loadData(db) {
  if (!tableExists(db, "outstanding_items") || !tableExists(db, "sessions")) throw new ProbeError("E_SCHEMA");
  const has = {
    events: tableExists(db, "outstanding_item_events"),
    links: tableExists(db, "session_links"),
    summaryUpdates: tableExists(db, "session_work_summary_updates"),
    cleanupColumn: tableExists(db, "outstanding_item_events") && columnExists(db, "outstanding_item_events", "cleanup_request_id"),
    voidedAt: columnExists(db, "sessions", "voided_at"),
  };
  const items = new Map();
  for (const row of db
    .prepare("SELECT id, source_session_id, project_id, position, text, status, created_at, updated_at FROM outstanding_items")
    .all()) {
    items.set(row.id, {
      id: row.id,
      session: row.source_session_id,
      project: row.project_id,
      position: row.position,
      text: row.text,
      status: row.status,
      createdAt: row.created_at,
      createdMs: Date.parse(row.created_at),
      updatedAt: row.updated_at,
      events: [],
      closeEvent: null,
      selfClosed: false,
    });
  }
  let maxTime = 0;
  for (const info of items.values()) maxTime = Math.max(maxTime, info.createdMs, Date.parse(info.updatedAt) || 0);
  if (has.events) {
    const cleanup = has.cleanupColumn ? ", cleanup_request_id" : "";
    for (const row of db
      .prepare(
        `SELECT item_id, from_status, to_status, source, actor_session_id, created_at${cleanup}
         FROM outstanding_item_events ORDER BY created_at, id`,
      )
      .all()) {
      const info = items.get(row.item_id);
      if (!info) continue;
      const event = {
        from: row.from_status,
        to: row.to_status,
        source: row.source,
        actor: row.actor_session_id,
        createdAt: row.created_at,
        ms: Date.parse(row.created_at),
        viaCleanup: has.cleanupColumn && row.cleanup_request_id !== null,
      };
      info.events.push(event);
      maxTime = Math.max(maxTime, event.ms || 0);
    }
  }
  for (const info of items.values()) {
    if (info.status !== "pending") {
      for (let index = info.events.length - 1; index >= 0; index -= 1) {
        const event = info.events[index];
        if (event.from === "pending" && event.to === info.status) {
          info.closeEvent = event;
          break;
        }
      }
    }
    info.selfClosed = info.status === "not_needed" && info.closeEvent !== null && info.closeEvent.actor === info.session;
  }
  const voided = has.voidedAt ? "voided_at" : "NULL";
  const sessions = new Map();
  for (const row of db
    .prepare(
      `SELECT id, project_id, COALESCE(completed_at, created_at) AS at, ${voided} AS voided_at, changed_files_json FROM sessions`,
    )
    .all()) {
    const ms = Date.parse(row.at);
    sessions.set(row.id, {
      id: row.id,
      project: row.project_id,
      ms,
      voided: row.voided_at !== null,
      files: changedFilePaths(row.changed_files_json),
    });
    if (Number.isFinite(ms)) maxTime = Math.max(maxTime, ms);
  }
  const links = new Map();
  if (has.links) {
    for (const row of db.prepare("SELECT session_id, related_session_id FROM session_links").all()) {
      for (const [from, to] of [
        [row.session_id, row.related_session_id],
        [row.related_session_id, row.session_id],
      ]) {
        const set = links.get(from) ?? new Set();
        set.add(to);
        links.set(from, set);
      }
    }
  }
  const summaryUpdates = [];
  if (has.summaryUpdates) {
    for (const row of db.prepare("SELECT created_at FROM session_work_summary_updates").all()) summaryUpdates.push(row.created_at);
  }
  return { has, items, sessions, links, summaryUpdates, maxTime };
}

/** Per-project sorted Session lists and a (project, file) inverted index of non-voided Sessions, built once. */
function buildSessionIndex(sessions) {
  const byFile = new Map();
  const ordered = [...sessions.values()].filter((s) => !s.voided && Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
  for (const session of ordered) {
    for (const file of session.files) {
      const key = `${session.project}\u0000${file}`;
      let entry = byFile.get(key);
      if (!entry) {
        entry = { times: [], ids: [] };
        byFile.set(key, entry);
      }
      entry.times.push(session.ms);
      entry.ids.push(session.id);
    }
  }
  return byFile;
}

function buildCreatedIndex(items) {
  const index = new Map();
  for (const info of items.values()) {
    const key = `${info.session}\u0000${info.createdAt}`;
    const list = index.get(key);
    if (list) list.push(info);
    else index.set(key, [info]);
  }
  return index;
}

// ---------------------------------------------------------------------------------------------------------------
// Metrics for one group of items
// ---------------------------------------------------------------------------------------------------------------
function hoursStats(infos) {
  const hours = infos.map((info) => Math.max(0, (info.closeEvent.ms - info.createdMs) / HOUR_MS));
  const within = (limit) => hours.filter((h) => h <= limit).length;
  return {
    ...summarize(hours),
    within1hShare: share(within(1), hours.length),
    within24hShare: share(within(24), hours.length),
  };
}

function totalsMetrics(group) {
  const perSession = new Map();
  const status = { pending: 0, completed: 0, not_needed: 0 };
  for (const info of group) {
    perSession.set(info.session, (perSession.get(info.session) ?? 0) + 1);
    status[info.status] = (status[info.status] ?? 0) + 1;
  }
  const counts = [...perSession.values()].sort((a, b) => a - b);
  return {
    items: group.length,
    sessionsWithItems: perSession.size,
    itemsPerSession: { median: percentile(counts, 0.5), p90: percentile(counts, 0.9), max: counts.at(-1) ?? null },
    status,
  };
}

function notNeededMetrics(group, data) {
  const notNeeded = group.filter((info) => info.status === "not_needed");
  const bySource = { agent: 0, web: 0, migration: 0, none: 0 };
  let viaCleanup = 0;
  for (const info of notNeeded) {
    bySource[info.closeEvent ? info.closeEvent.source : "none"] += 1;
    if (info.closeEvent?.viaCleanup) viaCleanup += 1;
  }
  const withClose = notNeeded.filter((info) => info.closeEvent);
  const selfClosed = notNeeded.filter((info) => info.selfClosed);
  return {
    count: notNeeded.length,
    byEventSource: bySource,
    viaCleanupProposal: data.has.cleanupColumn ? viaCleanup : null,
    selfClosed: selfClosed.length,
    selfClosedShare: share(selfClosed.length, notNeeded.length),
    hoursToClose: hoursStats(withClose),
    selfClosedHoursToClose: hoursStats(selfClosed),
  };
}

function rewordingMetrics(group, data, ctx) {
  const selfClosed = group.filter((info) => info.selfClosed);
  const buckets = new Map();
  for (const info of selfClosed) {
    const key = `${info.session}\u0000${info.closeEvent.createdAt}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(info);
    else buckets.set(key, [info]);
  }
  const syncInstants = new Set();
  for (const info of group) {
    for (const event of info.events) {
      if ((event.source === "agent" || event.source === "web") && event.actor === info.session) {
        syncInstants.add(`${info.session}\u0000${event.createdAt}`);
      }
    }
  }
  const summaryUpdates = data.has.summaryUpdates ? ctx.summaryUpdatesInGroup : null;
  const base = {
    threshold: ctx.matcher?.threshold ?? null,
    selfClosed: selfClosed.length,
    syncInstants: syncInstants.size,
    summaryUpdates,
  };
  if (!ctx.matcher) {
    return { ...base, matcherAvailable: false, withSameInstantReplacement: null, pureRemoval: null, keptByMatcher: null, closeCreateBursts: null };
  }
  const histogram = emptyHistogram();
  let withReplacement = 0;
  let pure = 0;
  let kept = 0;
  let unpaired = 0;
  let skipped = 0;
  let bursts = 0;
  for (const [key, previous] of buckets) {
    const previousIds = new Set(previous.map((info) => info.id));
    const next = (ctx.createdIndex.get(key) ?? []).filter((info) => !previousIds.has(info.id));
    if (next.length === 0) {
      pure += previous.length;
      continue;
    }
    bursts += 1;
    withReplacement += previous.length;
    if (previous.length * next.length > 2_500) {
      skipped += previous.length;
      continue;
    }
    const pairs = ctx.matcher.pair(
      previous.map((info) => ({ id: info.id, position: info.position, text: info.text })),
      next.map((info, index) => ({ index, text: info.text })),
    );
    unpaired += previous.length - pairs.length;
    for (const pair of pairs) {
      histogram[bucketKey(pair.similarity)] += 1;
      if (pair.similarity >= ctx.matcher.threshold) kept += 1;
    }
  }
  return {
    ...base,
    matcherAvailable: true,
    withSameInstantReplacement: withReplacement,
    pureRemoval: pure,
    keptByMatcher: kept,
    wouldNotBeKept: withReplacement - skipped - unpaired - kept,
    withReplacementUnpaired: unpaired,
    skippedOverPairLimit: skipped,
    keptShareOfReplaced: share(kept, withReplacement),
    similarityHistogram: histogram,
    closeCreateBursts: bursts,
    burstsPerSyncInstant: share(bursts, syncInstants.size),
    burstsPerSummaryUpdate: summaryUpdates ? share(bursts, summaryUpdates) : null,
  };
}

function transientMetrics(group) {
  const blank = () => ({ total: 0, pending: 0, completed: 0, not_needed: 0, selfClosed: 0 });
  const categories = Object.fromEntries(Object.keys(TRANSIENT_CATEGORIES).map((name) => [name, blank()]));
  const any = blank();
  const bump = (cell, info) => {
    cell.total += 1;
    cell[info.status] += 1;
    if (info.selfClosed) cell.selfClosed += 1;
  };
  for (const info of group) {
    let matched = false;
    for (const [name, pattern] of Object.entries(TRANSIENT_CATEGORIES)) {
      if (pattern.test(info.text)) {
        bump(categories[name], info);
        matched = true;
      }
    }
    if (matched) bump(any, info);
  }
  const finish = (cell) => ({ ...cell, selfClosedShare: share(cell.selfClosed, cell.total) });
  return {
    categories: Object.fromEntries(Object.entries(categories).map(([name, cell]) => [name, finish(cell)])),
    anyTransient: finish(any),
    anyTransientShareOfItems: share(any.total, group.length),
  };
}

function completionMetrics(group, data) {
  const completed = group.filter((info) => info.status === "completed");
  const bySource = { web: 0, agent: 0, migration: 0, none: 0 };
  const days = { web: [], agent: [], migration: [] };
  const agent = { sameSession: 0, laterSession: 0, unknownActor: 0 };
  const perDay = new Map();
  for (const info of completed) {
    const event = info.closeEvent;
    const source = event ? event.source : "none";
    bySource[source] += 1;
    if (!event) continue;
    days[source]?.push(Math.max(0, (event.ms - info.createdMs) / DAY_MS));
    if (source === "agent") {
      if (!event.actor) agent.unknownActor += 1;
      else if (event.actor === info.session) agent.sameSession += 1;
      else agent.laterSession += 1;
    }
    if (source === "web") perDay.set(utcDay(event.createdAt), (perDay.get(utcDay(event.createdAt)) ?? 0) + 1);
  }
  const dayCounts = [...perDay.values()].sort((a, b) => b - a);
  const top3 = dayCounts.slice(0, 3).reduce((sum, n) => sum + n, 0);
  void data;
  return {
    completed: completed.length,
    bySource,
    agent,
    daysToCompletion: { web: summarize(days.web), agent: summarize(days.agent), migration: summarize(days.migration) },
    webConcentration: {
      distinctDays: perDay.size,
      maxPerDay: dayCounts[0] ?? null,
      top3DaysShare: share(top3, bySource.web),
    },
  };
}

function missedOpportunityMetrics(group, data, ctx) {
  const web = group.filter((info) => info.status === "completed" && info.closeEvent?.source === "web");
  let linked = 0;
  let shared = 0;
  let either = 0;
  for (const info of web) {
    const created = info.createdMs;
    const resolved = info.closeEvent.ms;
    const source = data.sessions.get(info.session);
    let byLink = false;
    for (const neighborId of data.links.get(info.session) ?? []) {
      const neighbor = data.sessions.get(neighborId);
      if (neighbor && !neighbor.voided && neighbor.project === info.project && neighbor.ms > created && neighbor.ms < resolved) {
        byLink = true;
        break;
      }
    }
    let byFile = false;
    for (const file of source?.files ?? []) {
      const entry = ctx.byFile.get(`${info.project}\u0000${file}`);
      if (!entry) continue;
      for (let index = upperBound(entry.times, created); index < entry.times.length && entry.times[index] < resolved; index += 1) {
        if (entry.ids[index] !== info.session) {
          byFile = true;
          break;
        }
      }
      if (byFile) break;
    }
    if (byLink) linked += 1;
    if (byFile) shared += 1;
    if (byLink || byFile) either += 1;
  }
  return {
    webCompleted: web.length,
    laterSessionLinked: data.has.links ? linked : null,
    laterSessionSharesChangedFile: shared,
    either,
    eitherShare: share(either, web.length),
  };
}

function agentPostFinalizeMetrics(group, data) {
  const result = { events: 0, postFinalize: 0, sameInstantAsFinalize: 0, beforeActorCompleted: 0, actorUnknown: 0 };
  for (const info of group) {
    for (const event of info.events) {
      if (event.source !== "agent" || (event.to !== "completed" && event.to !== "not_needed")) continue;
      if (!event.actor || event.actor === info.session) continue;
      result.events += 1;
      const actor = data.sessions.get(event.actor);
      if (!actor || !Number.isFinite(actor.ms)) result.actorUnknown += 1;
      else if (event.ms > actor.ms) result.postFinalize += 1;
      else if (event.ms === actor.ms) result.sameInstantAsFinalize += 1;
      else result.beforeActorCompleted += 1;
    }
  }
  return result;
}

function pendingMetrics(group, nowMs) {
  const pending = group.filter((info) => info.status === "pending");
  const buckets = { under1d: 0, from1dTo7d: 0, from7dTo30d: 0, over30d: 0 };
  let oldest = null;
  for (const info of pending) {
    const age = Math.max(0, (nowMs - info.createdMs) / DAY_MS);
    oldest = oldest === null ? age : Math.max(oldest, age);
    if (age < 1) buckets.under1d += 1;
    else if (age < 7) buckets.from1dTo7d += 1;
    else if (age < 30) buckets.from7dTo30d += 1;
    else buckets.over30d += 1;
  }
  return { count: pending.length, oldestAgeDays: round(oldest), ageBuckets: buckets };
}

function groupMetrics(group, data, ctx, nowMs) {
  return {
    totals: totalsMetrics(group),
    notNeeded: notNeededMetrics(group, data),
    rewording: rewordingMetrics(group, data, ctx),
    transientWording: transientMetrics(group),
    completion: completionMetrics(group, data),
    missedOpportunities: missedOpportunityMetrics(group, data, ctx),
    agentPostFinalize: agentPostFinalizeMetrics(group, data),
    currentPending: pendingMetrics(group, nowMs),
  };
}

function cleanupMetrics(db) {
  const tables = {};
  for (const name of CLEANUP_TABLES) {
    tables[name] = tableExists(db, name) ? db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n : null;
  }
  const grouped = (table, column) => {
    if (!tableExists(db, table)) return null;
    const out = {};
    for (const row of db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all()) out[row.k] = row.n;
    return out;
  };
  return {
    rowCounts: tables,
    requestsByStatus: grouped("outstanding_cleanup_requests", "status"),
    proposalsByReviewStatus: grouped("outstanding_cleanup_proposals", "review_status"),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point for the analysis
// ---------------------------------------------------------------------------------------------------------------
async function loadMatcher() {
  try {
    const storage = await import("../../packages/storage/dist/index.js");
    if (typeof storage.pairRewordedItems !== "function" || typeof storage.REWORD_SIMILARITY_THRESHOLD !== "number") return null;
    return {
      // Threshold 0 returns the best one-to-one pairing at any similarity; the caller applies the real threshold.
      pair: (previous, next) => storage.pairRewordedItems(previous, next, 0),
      threshold: storage.REWORD_SIMILARITY_THRESHOLD,
    };
  } catch {
    return null;
  }
}

/** options: { since, until, split, now } with date strings (now: ISO time). `db` must be a read-only connection. */
export async function analyze(db, options = {}) {
  const data = loadData(db);
  const matcher = await loadMatcher();
  const sinceKey = options.since ? `${options.since}T00:00:00.000Z` : null;
  const untilKey = options.until ? `${options.until}T23:59:59.999Z` : null;
  const splitKey = options.split ? `${options.split}T00:00:00.000Z` : null;
  const nowMs = options.now ? Date.parse(options.now) : data.maxTime;
  const inScope = (info) => (!sinceKey || info.createdAt >= sinceKey) && (!untilKey || info.createdAt <= untilKey);
  const scoped = [...data.items.values()].filter(inScope);
  const ctx = {
    matcher,
    createdIndex: buildCreatedIndex(data.items),
    byFile: buildSessionIndex(data.sessions),
    summaryUpdatesInGroup: 0,
  };
  const inRange = (key) => (!sinceKey || key >= sinceKey) && (!untilKey || key <= untilKey);
  const updatesFor = (predicate) => data.summaryUpdates.filter((at) => inRange(at) && predicate(at)).length;
  const meta = {
    schema: { ...data.has },
    matcherAvailable: matcher !== null,
    since: options.since ?? null,
    until: options.until ?? null,
    split: options.split ?? null,
    now: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    itemsInDatabase: data.items.size,
    itemsInScope: scoped.length,
  };
  const cleanup = cleanupMetrics(db);
  if (!splitKey) {
    ctx.summaryUpdatesInGroup = updatesFor(() => true);
    return { meta, metrics: groupMetrics(scoped, data, ctx, nowMs), cleanup };
  }
  ctx.summaryUpdatesInGroup = updatesFor((at) => at < splitKey);
  const before = groupMetrics(
    scoped.filter((info) => info.createdAt < splitKey),
    data,
    ctx,
    nowMs,
  );
  ctx.summaryUpdatesInGroup = updatesFor((at) => at >= splitKey);
  const after = groupMetrics(
    scoped.filter((info) => info.createdAt >= splitKey),
    data,
    ctx,
    nowMs,
  );
  return { meta, split: { before, onOrAfter: after }, cleanup };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ProbeError("E_USAGE");
  return value;
}

function validDate(value) {
  if (value === undefined) return undefined;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) throw new ProbeError("E_USAGE");
  return value;
}

async function runCli(args) {
  const dbPath = flagValue(args, "--db");
  if (!dbPath) throw new ProbeError("E_USAGE");
  const options = {
    since: validDate(flagValue(args, "--since")),
    until: validDate(flagValue(args, "--until")),
    split: validDate(flagValue(args, "--split")),
  };
  const now = flagValue(args, "--now");
  if (now !== undefined) {
    if (Number.isNaN(Date.parse(now))) throw new ProbeError("E_USAGE");
    options.now = now;
  }
  if (!existsSync(dbPath)) throw new ProbeError("E_DB_NOT_FOUND");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    throw new ProbeError("E_DB_OPEN");
  }
  try {
    const result = await analyze(db, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError("E_QUERY");
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check: synthetic fictional database
// ---------------------------------------------------------------------------------------------------------------
const FIXTURE_TEXTS = {
  a1: "Calibrate the walrus index",
  a2: "Changes are uncommitted in the lighthouse folder",
  a3: "Waiting for CI on the pelican branch",
  a4: "Document the kettle protocol",
  b1: "Review the cobalt dashboard",
  d1: "Waiting for the subagent report about topaz",
  d2: "Phase 3 not yet started for the amber module",
  g1: "Archive the plum sketches",
  h1: "Rename the garnet exporter module",
  h2: "Remove the stale cedar fixtures",
  h3: "Draft the willow handoff checklist",
  h4: "Investigate unrelated xylophone latency",
  i1: "Sketch the opal retry policy",
  i2: "Verify the birch cache sizing",
  j1: "Rewrite the indigo parser benchmarks for the nightly run",
  j1b: "Rewrite the indigo parser benchmarks for the nightly job",
  j2: "Tidy the sienna config loader",
  j2b: "Tidy the sienna loader config",
};

async function buildFixture(dir) {
  const { WorkIntelligenceStore, outstandingTextSimilarity } = await import("../../packages/storage/dist/index.js");
  const root = join(dir, "fictional-project");
  mkdirSync(root, { recursive: true });
  const dbPath = join(dir, "fixture.sqlite");
  const store = new WorkIntelligenceStore(dbPath);
  const project = store.addProject("Fictional Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  const workSummary = (nextSteps) => ({ outcomes: [], scope: [], decisions: [], verification: [], nextSteps });
  const ids = {};
  const day = (n) => `2025-03-${String(n).padStart(2, "0")}T00:00:00.000Z`;
  const finalize = (name, dayNumber, files, nextSteps, extra = {}) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `probe-${name}`,
      title: `Fictional session ${name}`,
      summary: `Fictional summary ${name}`,
      workSummary: workSummary(nextSteps),
      changedFiles: files,
      verification: { status: "passed" },
      completedAt: day(dayNumber),
      ...extra,
    });
    assert.equal(result.outcome, "finalized", `fixture finalize ${name}`);
    ids[name] = result.session.id;
  };
  finalize("A", 1, ["src/a.ts", "src/shared.ts"], [FIXTURE_TEXTS.a1, FIXTURE_TEXTS.a2, FIXTURE_TEXTS.a3, FIXTURE_TEXTS.a4]);
  finalize("B", 2, ["src/b.ts", "src/shared.ts"], [FIXTURE_TEXTS.b1], { relatedSessionIds: [ids.A] });
  finalize("C", 3, ["src/c.ts"], []);
  finalize("D", 4, ["src/d.ts"], [FIXTURE_TEXTS.d1, FIXTURE_TEXTS.d2]);
  finalize("E", 5, ["src/e.ts"], []);
  const raw = new DatabaseSync(dbPath);
  const itemId = (text) => raw.prepare("SELECT id FROM outstanding_items WHERE text = ?").get(text).id;
  finalize("F", 6, ["src/f.ts"], [], { resolvedOutstandingItemIds: [itemId(FIXTURE_TEXTS.a2)] });
  finalize("G", 7, ["src/g.ts"], [FIXTURE_TEXTS.g1], { supersededOutstandingItemIds: [itemId(FIXTURE_TEXTS.a3)] });
  finalize("H", 8, ["src/h.ts"], [FIXTURE_TEXTS.h1, FIXTURE_TEXTS.h2, FIXTURE_TEXTS.h3]);
  finalize("I", 9, ["src/i.ts"], [FIXTURE_TEXTS.i1, FIXTURE_TEXTS.i2]);
  finalize("J", 10, ["src/j.ts"], [FIXTURE_TEXTS.j1, FIXTURE_TEXTS.j2]);

  // Web resolutions of items whose later work could have resolved them (only A1 and A4 have a linked, file-sharing later Session).
  for (const text of [FIXTURE_TEXTS.a1, FIXTURE_TEXTS.a4, FIXTURE_TEXTS.b1, FIXTURE_TEXTS.d1]) {
    const result = store.updateOutstandingItemStatus(itemId(text), "completed", "web");
    assert.equal(result.outcome, "outstanding_item_updated", "fixture web completion");
  }
  // Agent edits of the work summary: H2 replaced by a dissimilar item, I2 removed outright.
  assert.equal(
    store.updateSessionWorkSummary(
      { sessionId: ids.H, idempotencyKey: "probe-h-update", mode: "replace", workSummary: workSummary([FIXTURE_TEXTS.h1, FIXTURE_TEXTS.h3, FIXTURE_TEXTS.h4]) },
      "agent",
    ).outcome,
    "work_summary_updated",
  );
  assert.equal(
    store.updateSessionWorkSummary(
      { sessionId: ids.I, idempotencyKey: "probe-i-update", mode: "replace", workSummary: workSummary([FIXTURE_TEXTS.i1]) },
      "agent",
    ).outcome,
    "work_summary_updated",
  );
  store.close();
  raw.close();

  // Legacy-style reword bursts (close + create at one instant) and a post-finalize Agent resolution, written directly.
  const writer = new DatabaseSync(dbPath);
  const burstAt = day(11);
  const insertItem = writer.prepare(
    `INSERT INTO outstanding_items (id, source_session_id, project_id, position, text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = writer.prepare(
    `INSERT INTO outstanding_item_events (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${(counter += 1)}`;
  const itemIdOf = (text) => writer.prepare("SELECT id FROM outstanding_items WHERE text = ?").get(text).id;
  for (const [oldText, newText, position] of [
    [FIXTURE_TEXTS.j1, FIXTURE_TEXTS.j1b, 0],
    [FIXTURE_TEXTS.j2, FIXTURE_TEXTS.j2b, 1],
  ]) {
    const oldId = itemIdOf(oldText);
    writer.prepare("UPDATE outstanding_items SET status = 'not_needed', updated_at = ? WHERE id = ?").run(burstAt, oldId);
    insertEvent.run(nextId("ev"), oldId, project.id, "pending", "not_needed", "agent", ids.J, burstAt);
    const newId = nextId("item");
    insertItem.run(newId, ids.J, project.id, position, newText, "pending", burstAt, burstAt);
    insertEvent.run(nextId("ev"), newId, project.id, null, "pending", "agent", ids.J, burstAt);
  }
  const d2 = itemIdOf(FIXTURE_TEXTS.d2);
  writer.prepare("UPDATE outstanding_items SET status = 'completed', updated_at = ? WHERE id = ?").run(day(20), d2);
  insertEvent.run(nextId("ev"), d2, project.id, "pending", "completed", "agent", ids.E, day(20));
  writer.close();
  return { dbPath, root, ids, outstandingTextSimilarity };
}

async function perfCheck(dir) {
  const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
  const root = join(dir, "perf-project");
  mkdirSync(root, { recursive: true });
  const dbPath = join(dir, "perf.sqlite");
  const store = new WorkIntelligenceStore(dbPath);
  const project = store.addProject("Fictional Perf", root);
  store.updateProject(project.id, { status: "tracked" });
  const sessionIds = [];
  const base = Date.parse("2025-01-01T00:00:00.000Z");
  for (let index = 0; index < 1_000; index += 1) {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `perf-${index}`,
      title: `Perf session ${index}`,
      summary: "Fictional perf summary",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [`src/mod-${index % 40}/file-${index % 17}.ts`, `src/mod-${(index * 7) % 40}/other.ts`],
      verification: { status: "passed" },
      completedAt: new Date(base + index * 3_600_000).toISOString(),
    });
    sessionIds.push({ id: result.session.id, at: base + index * 3_600_000 });
  }
  store.close();
  const writer = new DatabaseSync(dbPath);
  const insertItem = writer.prepare(
    `INSERT INTO outstanding_items (id, source_session_id, project_id, position, text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = writer.prepare(
    `INSERT INTO outstanding_item_events (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = writer.prepare(
    "INSERT INTO session_links (id, session_id, related_session_id, relation, source, created_at) VALUES (?, ?, ?, 'related', 'agent', ?)",
  );
  writer.exec("BEGIN");
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let total = 0;
  for (let s = 0; s < sessionIds.length; s += 1) {
    const session = sessionIds[s];
    const createdAt = new Date(session.at).toISOString();
    for (let position = 0; position < 20; position += 1) {
      const id = `perf-item-${total}`;
      const roll = random();
      const status = roll < 0.5 ? "pending" : roll < 0.75 ? "completed" : "not_needed";
      const text = `Fictional follow up number ${total} waiting for CI on branch ${s}`;
      insertItem.run(id, session.id, project.id, position, text, status, createdAt, createdAt);
      insertEvent.run(`perf-ev-${total}-c`, id, project.id, null, "pending", "agent", session.id, createdAt);
      if (status !== "pending") {
        const later = new Date(session.at + Math.floor(random() * 40) * 3_600_000 + 1_000).toISOString();
        const web = status === "completed" && random() < 0.5;
        const actor = web ? null : random() < 0.5 ? session.id : sessionIds[Math.min(999, s + 1)].id;
        insertEvent.run(`perf-ev-${total}-x`, id, project.id, "pending", status, web ? "web" : "agent", actor, later);
        if (status === "not_needed" && random() < 0.5) {
          const replacement = `perf-item-r-${total}`;
          insertItem.run(replacement, session.id, project.id, position, `${text} again`, "pending", later, later);
          insertEvent.run(`perf-ev-${total}-r`, replacement, project.id, null, "pending", "agent", session.id, later);
        }
      }
      total += 1;
    }
    if (s > 0 && s % 3 === 0) {
      insertLink.run(`perf-link-${s}`, session.id, sessionIds[s - 1].id, createdAt);
    }
  }
  writer.exec("COMMIT");
  writer.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const started = performance.now();
  const result = await analyze(db, { split: "2025-01-20" });
  const elapsed = performance.now() - started;
  db.close();
  console.error(`perf: ${result.meta.itemsInScope} items analyzed in ${Math.round(elapsed)} ms`);
  assert.ok(result.meta.itemsInScope >= 20_000, "perf fixture holds at least 20k items");
  assert.ok(elapsed < 10_000, "analysis of the scaled set finishes in seconds");
}

async function selfCheck() {
  const dir = mkdtempSync(join(tmpdir(), "outstanding-probe-"));
  try {
    const fixture = await buildFixture(dir);
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    const now = "2025-03-17T00:00:00.000Z";
    const full = await analyze(db, { now });
    const m = full.metrics;

    assert.equal(full.meta.schema.events, true);
    assert.equal(m.totals.items, 18);
    assert.equal(m.totals.sessionsWithItems, 7);
    assert.deepEqual(m.totals.status, { pending: 7, completed: 6, not_needed: 5 });
    assert.equal(m.totals.itemsPerSession.max, 4);
    assert.equal(m.totals.itemsPerSession.median, 2);

    assert.equal(m.notNeeded.count, 5);
    assert.deepEqual(m.notNeeded.byEventSource, { agent: 5, web: 0, migration: 0, none: 0 });
    assert.equal(m.notNeeded.selfClosed, 4);
    assert.equal(m.notNeeded.viaCleanupProposal, 0);

    const r = m.rewording;
    assert.equal(r.matcherAvailable, true);
    assert.equal(r.selfClosed, 4);
    assert.equal(r.withSameInstantReplacement, 3);
    assert.equal(r.pureRemoval, 1);
    assert.equal(r.skippedOverPairLimit, 0);
    assert.equal(r.closeCreateBursts, 2);
    assert.equal(r.syncInstants, 10);
    assert.equal(r.summaryUpdates, 2);
    assert.equal(r.burstsPerSummaryUpdate, 1);
    const histogramTotal = Object.values(r.similarityHistogram).reduce((a, b) => a + b, 0);
    assert.equal(histogramTotal, 3 - r.withReplacementUnpaired);
    const expectKept = [
      fixture.outstandingTextSimilarity(FIXTURE_TEXTS.j1, FIXTURE_TEXTS.j1b),
      fixture.outstandingTextSimilarity(FIXTURE_TEXTS.j2, FIXTURE_TEXTS.j2b),
      fixture.outstandingTextSimilarity(FIXTURE_TEXTS.h2, FIXTURE_TEXTS.h4),
    ].filter((similarity) => similarity >= r.threshold).length;
    assert.equal(r.keptByMatcher, expectKept);
    assert.equal(r.keptByMatcher, 2);
    assert.equal(r.wouldNotBeKept, 1);

    const t = m.transientWording.categories;
    assert.equal(t.uncommitted.total, 1);
    assert.equal(t.uncommitted.completed, 1);
    assert.equal(t.ci_running.total, 1);
    assert.equal(t.ci_running.not_needed, 1);
    assert.equal(t.ci_running.selfClosed, 0);
    assert.equal(t.waiting_subagent.total, 1);
    assert.equal(t.phase_not_started.total, 1);
    assert.equal(t.not_pushed.total, 0);
    assert.equal(t.pr_pending.total, 0);
    assert.equal(m.transientWording.anyTransient.total, 4);

    assert.equal(m.completion.completed, 6);
    assert.deepEqual(m.completion.bySource, { web: 4, agent: 2, migration: 0, none: 0 });
    assert.deepEqual(m.completion.agent, { sameSession: 0, laterSession: 2, unknownActor: 0 });
    assert.equal(m.completion.webConcentration.distinctDays, 1);
    assert.equal(m.completion.webConcentration.maxPerDay, 4);
    assert.equal(m.completion.webConcentration.top3DaysShare, 1);
    assert.equal(m.completion.daysToCompletion.web.n, 4);

    assert.equal(m.missedOpportunities.webCompleted, 4);
    assert.equal(m.missedOpportunities.laterSessionLinked, 2);
    assert.equal(m.missedOpportunities.laterSessionSharesChangedFile, 2);
    assert.equal(m.missedOpportunities.either, 2);

    assert.equal(m.agentPostFinalize.events, 3);
    assert.equal(m.agentPostFinalize.sameInstantAsFinalize, 2);
    assert.equal(m.agentPostFinalize.postFinalize, 1);

    assert.equal(m.currentPending.count, 7);
    assert.equal(m.currentPending.oldestAgeDays, 10);
    assert.deepEqual(m.currentPending.ageBuckets, { under1d: 1, from1dTo7d: 2, from7dTo30d: 4, over30d: 0 });

    assert.deepEqual(Object.values(full.cleanup.rowCounts), [0, 0, 0, 0, 0]);
    assert.equal(full.cleanup.requestsByStatus !== null, true);

    // --split reports each metric twice; the halves add up.
    const split = await analyze(db, { now, split: "2025-03-08" });
    assert.equal(split.split.before.totals.items, 8);
    assert.equal(split.split.onOrAfter.totals.items, 10);
    assert.equal(split.split.before.rewording.selfClosed, 0);
    assert.equal(split.split.onOrAfter.rewording.selfClosed, 4);
    assert.equal(split.split.before.completion.completed + split.split.onOrAfter.completion.completed, 6);
    assert.equal(split.split.before.rewording.summaryUpdates, 0);
    assert.equal(split.split.onOrAfter.rewording.summaryUpdates, 2);

    // --since / --until are inclusive days on item created_at.
    const ranged = await analyze(db, { now, since: "2025-03-09", until: "2025-03-11" });
    assert.equal(ranged.metrics.totals.items, 6);

    // Output carries no fixture text, id, path or project name.
    const serialized = JSON.stringify([full, split, ranged]);
    for (const text of Object.values(FIXTURE_TEXTS)) assert.equal(serialized.includes(text), false, "output leaks an item text");
    for (const id of Object.values(fixture.ids)) assert.equal(serialized.includes(id), false, "output leaks a session id");
    for (const secret of ["Fictional", "fictional-project", fixture.root, "src/shared.ts"]) {
      assert.equal(serialized.includes(secret), false, "output leaks fixture data");
    }

    // An older database without the cleanup tables reports null.
    const older = new DatabaseSync(join(dir, "older.sqlite"));
    older.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, completed_at TEXT, created_at TEXT, changed_files_json TEXT);
      CREATE TABLE outstanding_items (id TEXT PRIMARY KEY, source_session_id TEXT, project_id TEXT, position INTEGER, text TEXT,
        status TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO sessions VALUES ('s1', 'p1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '[]');
      INSERT INTO outstanding_items VALUES ('i1', 's1', 'p1', 0, 'Fictional old item', 'pending', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    `);
    older.close();
    const olderDb = new DatabaseSync(join(dir, "older.sqlite"), { readOnly: true });
    const olderResult = await analyze(olderDb);
    olderDb.close();
    assert.equal(olderResult.metrics.totals.items, 1);
    assert.equal(olderResult.cleanup.requestsByStatus, null);
    assert.equal(olderResult.cleanup.rowCounts.outstanding_cleanup_requests, null);
    assert.equal(olderResult.metrics.notNeeded.viaCleanupProposal, null);
    db.close();

    await perfCheck(dir);
    console.log("self-check passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--self-check")) await selfCheck();
    else await runCli(args);
  } catch (error) {
    if (args.includes("--self-check")) {
      // Self-check runs on fictional data only, so the assertion text is safe to show.
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    } else {
      console.error(JSON.stringify({ error: error instanceof ProbeError ? error.code : "E_INTERNAL" }));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] === SELF) await main();
