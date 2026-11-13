// Value metrics probe (read-only research tool, not a product feature).
//
// Question: does the product get better as a project accumulates history? Prints one table of the same metrics per
// time bucket (calendar month, or before/after --split), computed from the user's own database with SQL and in-memory
// joins only: no getContext replay, so later records never take part in the result for an earlier moment.
//
// Usage:
//   pnpm build
//   node docs/experiments/value-metrics-probe.mjs --db <path> [--split 2026-11-01 | --by-depth] [--json <new file>]
//   --by-depth buckets by project history depth instead of time: how many live Sessions the record's project already
//   had at that moment (0-49, 50-199, 200-999, 1000+). This is the "better with more history" curve.
//   node docs/experiments/value-metrics-probe.mjs --self-check      (also the default without --db)
//
// Metric groups (definitions in docs/experiments/research-2026-11-value-measurement.md):
//   S  records and completeness: Sessions, started_at/updated_at present, files confirmed, commit, branch, passed.
//   K  Knowledge saved per 100 Sessions, share with appliesTo, share still active.
//   P  path opportunities (S changed a file inside an active K's appliesTo, K older than S, not K's own source).
//   A  server-observed provision: an opportunity whose K id was returned by any audited read of the same project
//      inside S's window [started_at - 10 min, completed_at]; only Sessions whose window lies inside the audit's
//      coverage count. Off-path share: returned Knowledge ids in the window whose appliesTo is set but covers none
//      of S's files. Context cost: reads, returned ids and work_get_context duration per covered Session.
//      "Ambiguous" Sessions (another Session of the same project overlaps the window) are reported separately,
//      because the audit has no connection id and their reads cannot be told apart.
//   F  agent-claimed applied feedback per opportunity, and the share of applied claims that are path-consistent.
//   O  outstanding items: closures by the Agent (with / without an actor Session), closures applied in the Web from an
//      accepted cleanup proposal with evidence, other Web closures, the grounded share, reopen events.
//   R  rework proxies: voided Sessions, Sessions re-touching a file another Session of the project changed in the
//      previous 72 hours, contradicted feedback.
//
// Safety: the database is opened read-only inside one read transaction; nothing is written. Output is aggregate
// counts and ratios only, never ids, titles, paths, project names or record text.
import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const { appliesToStrength } = await import("../../packages/storage/dist/applies-to-match.js");
const { normalizePath } = await import("../../packages/storage/dist/search-text.js");

const WINDOW_LEAD_MS = 10 * 60 * 1000;
const RETOUCH_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------
function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseList(text) {
  try {
    const value = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function lowerBound(sorted, value, key) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (key(sorted[mid]) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------------------------------------------
// Load (one read transaction, columns checked so older databases still run)
// ---------------------------------------------------------------------------------------------------------------
function load(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const sessionColumns = columnsOf(db, "sessions");
    const optional = (name, fallback = "NULL") => (sessionColumns.has(name) ? name : `${fallback} AS ${name}`);
    const rows = {
      projects: db.prepare("SELECT id, name, root_path FROM projects").all(),
      sessions: db
        .prepare(
          `SELECT id, project_id, completed_at, created_at, commit_sha, git_branch, changed_files_json, verification_json,
             ${optional("started_at")}, ${optional("updated_at")}, ${optional("voided_at")},
             ${optional("changed_files_confirmed", "0")}
           FROM sessions`,
        )
        .all(),
      knowledge: db
        .prepare(
          `SELECT id, project_id, session_id, status, created_at,
             ${columnsOf(db, "knowledge").has("applies_to_json") ? "applies_to_json" : "'[]' AS applies_to_json"}
           FROM knowledge`,
        )
        .all(),
      audit: db
        .prepare(
          `SELECT knowledge_id, action, occurred_at,
             CASE WHEN json_valid(after_json) THEN json_extract(after_json, '$.updatedAt') END AS updated_at
           FROM knowledge_audit`,
        )
        .all(),
      feedback: hasTable(db, "knowledge_feedback")
        ? db.prepare("SELECT knowledge_id, session_id, kind FROM knowledge_feedback WHERE session_id IS NOT NULL").all()
        : [],
      reads: [],
      readRecords: [],
      items: hasTable(db, "outstanding_items")
        ? db.prepare("SELECT id, project_id, created_at FROM outstanding_items").all()
        : [],
      itemEvents: [],
      backedProposals: [],
    };
    if (hasTable(db, "agent_read_audit")) {
      const duration = columnsOf(db, "agent_read_audit").has("duration_ms") ? "duration_ms" : "NULL AS duration_ms";
      rows.reads = db
        .prepare(`SELECT id, created_at, tool, project_id, outcome, returned_count, ${duration} FROM agent_read_audit`)
        .all();
      rows.readRecords = db
        .prepare("SELECT audit_id, record_id FROM agent_read_audit_records WHERE record_type = 'knowledge'")
        .all();
    }
    if (hasTable(db, "outstanding_item_events")) {
      const eventColumns = columnsOf(db, "outstanding_item_events");
      const proposal = eventColumns.has("cleanup_proposal_id") ? "cleanup_proposal_id" : "NULL AS cleanup_proposal_id";
      rows.itemEvents = db
        .prepare(
          `SELECT project_id, from_status, to_status, source, actor_session_id, created_at, ${proposal}
           FROM outstanding_item_events`,
        )
        .all();
    }
    if (hasTable(db, "outstanding_cleanup_proposal_evidence")) {
      rows.backedProposals = db
        .prepare(
          `SELECT p.id FROM outstanding_cleanup_proposals p
           WHERE p.review_status = 'accepted'
             AND EXISTS (SELECT 1 FROM outstanding_cleanup_proposal_evidence e WHERE e.proposal_id = p.id)`,
        )
        .all();
    }
    db.exec("COMMIT");
    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------
function bucketOf(time, split) {
  if (!Number.isFinite(time)) return "unknown";
  if (split !== undefined) return time < split ? "before" : "after";
  return new Date(time).toISOString().slice(0, 7);
}

function emptyBucket() {
  return {
    sessions: 0,
    startedAt: 0,
    updatedAt: 0,
    filesConfirmed: 0,
    commit: 0,
    branch: 0,
    passed: 0,
    voided: 0,
    knowledgeSaved: 0,
    knowledgeWithAppliesTo: 0,
    knowledgeActiveNow: 0,
    sessionsWithOpportunity: 0,
    opportunities: 0,
    coveredSessions: 0,
    ambiguousSessions: 0,
    coveredOpportunities: 0,
    offeredOpportunities: 0,
    offeredOpportunitiesUnambiguous: 0,
    offeredByContextOnly: 0,
    offeredPossiblyRecentList: 0,
    coveredOpportunitiesUnambiguous: 0,
    windowKnowledgeReturned: 0,
    windowKnowledgeOffPath: 0,
    windowKnowledgeUnscoped: 0,
    readsPerCoveredSession: [],
    returnedPerCoveredSession: [],
    contextDurations: [],
    appliedOnOpportunity: 0,
    appliedClaims: 0,
    appliedPathConsistent: 0,
    contradicted: 0,
    retouched: 0,
    itemsCreated: 0,
    agentClosures: 0,
    agentClosuresWithSession: 0,
    proposalClosures: 0,
    webClosures: 0,
    reopens: 0,
  };
}

const DEPTH_BINS = [
  [0, "depth-0000-0049"],
  [50, "depth-0050-0199"],
  [200, "depth-0200-0999"],
  [1000, "depth-1000+"],
];

function depthLabel(depth) {
  let label = DEPTH_BINS[0][1];
  for (const [from, name] of DEPTH_BINS) if (depth >= from) label = name;
  return label;
}

function analyze(rows, { split, byDepth = false } = {}) {
  const projectById = new Map(rows.projects.map((project) => [project.id, project]));
  const buckets = new Map();
  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, emptyBucket());
    return buckets.get(key);
  };

  // Sessions with normalized files and windows.
  const sessions = rows.sessions.map((row) => {
    const project = projectById.get(row.project_id);
    const contexts = project ? [{ name: project.name, rootPath: project.root_path }] : [];
    const completed = Date.parse(row.completed_at);
    const started = Date.parse(row.started_at ?? "");
    let status;
    try {
      status = JSON.parse(row.verification_json ?? "null")?.status;
    } catch {
      status = undefined;
    }
    return {
      ...row,
      contexts,
      completed,
      started,
      // A Session without started_at has no reliable window: it is counted but never covered.
      windowStart: Number.isFinite(started) ? started - WINDOW_LEAD_MS : Number.NaN,
      files: [...new Set(parseList(row.changed_files_json).map((file) => normalizePath(file, contexts)))].filter(Boolean),
      status,
      bucket: bucketOf(completed, split),
    };
  });
  const live = sessions.filter((session) => !session.voided_at);

  // Knowledge with compiled appliesTo and active intervals (archived/restored audit; an archive without audit has no
  // known start, so that Knowledge counts as inactive for the whole history).
  const transitions = new Map();
  for (const row of rows.audit) {
    if (!transitions.has(row.knowledge_id)) transitions.set(row.knowledge_id, []);
    transitions.get(row.knowledge_id).push({
      action: row.action,
      time: Date.parse(row.occurred_at),
      updatedAt: Date.parse(row.updated_at ?? ""),
    });
  }
  const knowledge = rows.knowledge.map((row) => {
    const project = projectById.get(row.project_id);
    const contexts = project ? [{ name: project.name, rootPath: project.root_path }] : [];
    const patterns = parseList(row.applies_to_json)
      .map((raw) => normalizePath(raw, contexts))
      .filter(Boolean);
    const events = (transitions.get(row.id) ?? []).sort((a, b) => a.time - b.time);
    const created = Date.parse(row.created_at);
    const intervals = [];
    let open = created;
    for (const event of events) {
      if (event.action === "archived" && open !== undefined) {
        intervals.push([open, event.time]);
        open = undefined;
      } else if (event.action === "restored" && open === undefined) open = event.time;
    }
    if (open !== undefined && (row.status === "active" || events.length > 0)) intervals.push([open, Infinity]);
    // updated_at as it stood over time (recentKnowledge orders by it): the after_json snapshot of each audit row.
    const updates = events.filter((event) => Number.isFinite(event.updatedAt));
    return { ...row, created, patterns, intervals, updates, matchCache: new Map() };
  });
  const knowledgeById = new Map(knowledge.map((item) => [item.id, item]));
  const knowledgeByProject = new Map();
  for (const item of knowledge) {
    if (!knowledgeByProject.has(item.project_id)) knowledgeByProject.set(item.project_id, []);
    knowledgeByProject.get(item.project_id).push(item);
  }
  const covers = (item, files) =>
    files.some((file) => {
      if (!item.matchCache.has(file)) {
        item.matchCache.set(
          file,
          item.patterns.some((pattern) => appliesToStrength(pattern, file) > 0),
        );
      }
      return item.matchCache.get(file);
    });
  const activeAt = (item, time) => item.intervals.some(([from, to]) => from <= time && time < to);
  const updatedAtAt = (item, time) => {
    let value = item.created;
    for (const event of item.updates) if (event.time <= time) value = event.updatedAt;
    return value;
  };
  // Approximates work_get_context's recentKnowledge: the 12 active Knowledge of the project with the latest
  // updated_at at that moment. A hit inside this list may have reached the Agent without any path or task match.
  const inRecentList = (item, time) => {
    const own = updatedAtAt(item, time);
    let newer = 0;
    for (const other of knowledgeByProject.get(item.project_id) ?? []) {
      if (other === item || other.created > time || !activeAt(other, time)) continue;
      const value = updatedAtAt(other, time);
      if (value > own || (value === own && other.id > item.id)) newer += 1;
      if (newer >= 12) return false;
    }
    return true;
  };

  // Reads per project, sorted by time, with their returned Knowledge ids.
  const knowledgeIdsByRead = new Map();
  for (const record of rows.readRecords) {
    if (!knowledgeIdsByRead.has(record.audit_id)) knowledgeIdsByRead.set(record.audit_id, []);
    knowledgeIdsByRead.get(record.audit_id).push(record.record_id);
  }
  const readsByProject = new Map();
  let auditFrom = Infinity;
  for (const read of rows.reads) {
    const time = Date.parse(read.created_at);
    if (!Number.isFinite(time)) continue;
    auditFrom = Math.min(auditFrom, time);
    if (!read.project_id) continue;
    if (!readsByProject.has(read.project_id)) readsByProject.set(read.project_id, []);
    readsByProject.get(read.project_id).push({ ...read, time, knowledgeIds: knowledgeIdsByRead.get(read.id) ?? [] });
  }
  for (const list of readsByProject.values()) list.sort((a, b) => a.time - b.time);

  // Overlap per project (ambiguous windows) and 72-hour re-touch.
  const liveByProject = new Map();
  for (const session of live) {
    if (!liveByProject.has(session.project_id)) liveByProject.set(session.project_id, []);
    liveByProject.get(session.project_id).push(session);
  }
  for (const list of liveByProject.values()) {
    list.sort((a, b) => a.completed - b.completed);
    for (let index = 0; index < list.length; index += 1) {
      const session = list[index];
      session.ambiguous = list.some(
        (other) =>
          other !== session &&
          Number.isFinite(other.windowStart) &&
          other.windowStart < session.completed &&
          session.windowStart < other.completed,
      );
      const files = new Set(session.files);
      session.retouched = list
        .slice(0, index)
        .some(
          (other) =>
            session.completed - other.completed <= RETOUCH_MS && other.files.some((file) => files.has(file)),
        );
    }
  }

  // Bucket key: calendar month / before-after, or (byDepth) how many live Sessions the project already had then.
  const keyOf = (projectId, time) => {
    if (!byDepth) return bucketOf(time, split);
    if (!Number.isFinite(time)) return "unknown";
    const list = liveByProject.get(projectId) ?? [];
    return depthLabel(lowerBound(list, time, (session) => session.completed));
  };
  for (const session of sessions) session.bucket = keyOf(session.project_id, session.completed);

  const appliedByPair = new Set();
  const feedbackBySession = new Map();
  for (const row of rows.feedback) {
    if (!feedbackBySession.has(row.session_id)) feedbackBySession.set(row.session_id, []);
    feedbackBySession.get(row.session_id).push(row);
    if (row.kind === "applied") appliedByPair.add(`${row.knowledge_id}|${row.session_id}`);
  }

  for (const session of sessions) {
    const b = bucket(session.bucket);
    if (session.voided_at) {
      b.voided += 1;
      continue;
    }
    b.sessions += 1;
    if (Number.isFinite(session.started)) b.startedAt += 1;
    if (session.updated_at) b.updatedAt += 1;
    if (Number(session.changed_files_confirmed) === 1) b.filesConfirmed += 1;
    if (session.commit_sha) b.commit += 1;
    if (session.git_branch) b.branch += 1;
    if (session.status === "passed") b.passed += 1;
    if (session.retouched) b.retouched += 1;

    const at = Number.isFinite(session.started) ? session.started : session.completed;
    const opportunities = (knowledgeByProject.get(session.project_id) ?? []).filter(
      (item) =>
        item.session_id !== session.id &&
        item.created < at &&
        item.patterns.length > 0 &&
        activeAt(item, at) &&
        covers(item, session.files),
    );
    if (opportunities.length > 0) b.sessionsWithOpportunity += 1;
    b.opportunities += opportunities.length;
    for (const item of opportunities) if (appliedByPair.has(`${item.id}|${session.id}`)) b.appliedOnOpportunity += 1;

    for (const row of feedbackBySession.get(session.id) ?? []) {
      if (row.kind === "contradicted") b.contradicted += 1;
      if (row.kind !== "applied") continue;
      b.appliedClaims += 1;
      const item = knowledgeById.get(row.knowledge_id);
      if (item && covers(item, session.files)) b.appliedPathConsistent += 1;
    }

    // Audit coverage: the whole window must lie after the first audited read.
    if (!Number.isFinite(session.windowStart) || session.windowStart < auditFrom) continue;
    b.coveredSessions += 1;
    if (session.ambiguous) b.ambiguousSessions += 1;
    const reads = readsByProject.get(session.project_id) ?? [];
    const windowReads = reads.slice(
      lowerBound(reads, session.windowStart, (read) => read.time),
      lowerBound(reads, session.completed + 1, (read) => read.time),
    );
    const offered = new Set();
    const offeredOutsideContext = new Set();
    const firstContextRead = new Map();
    let returned = 0;
    for (const read of windowReads) {
      returned += Number(read.returned_count) || 0;
      if (read.tool === "work_get_context" && Number.isFinite(read.duration_ms)) b.contextDurations.push(read.duration_ms);
      for (const id of read.knowledgeIds) {
        offered.add(id);
        if (read.tool !== "work_get_context") offeredOutsideContext.add(id);
        else if (!firstContextRead.has(id)) firstContextRead.set(id, read.time);
        b.windowKnowledgeReturned += 1;
        const item = knowledgeById.get(id);
        if (!item || item.patterns.length === 0) b.windowKnowledgeUnscoped += 1;
        else if (!covers(item, session.files)) b.windowKnowledgeOffPath += 1;
      }
    }
    b.readsPerCoveredSession.push(windowReads.length);
    b.returnedPerCoveredSession.push(returned);
    b.coveredOpportunities += opportunities.length;
    const hitItems = opportunities.filter((item) => offered.has(item.id));
    const hits = hitItems.length;
    const contextOnly = hitItems.filter((item) => !offeredOutsideContext.has(item.id));
    b.offeredByContextOnly += contextOnly.length;
    b.offeredPossiblyRecentList += contextOnly.filter((item) =>
      inRecentList(item, firstContextRead.get(item.id)),
    ).length;
    b.offeredOpportunities += hits;
    if (!session.ambiguous) {
      b.coveredOpportunitiesUnambiguous += opportunities.length;
      b.offeredOpportunitiesUnambiguous += hits;
    }
  }

  for (const item of knowledge) {
    const b = bucket(keyOf(item.project_id, item.created));
    b.knowledgeSaved += 1;
    if (item.patterns.length > 0) b.knowledgeWithAppliesTo += 1;
    if (item.status === "active") b.knowledgeActiveNow += 1;
  }

  const backed = new Set(rows.backedProposals.map((row) => row.id));
  for (const item of rows.items) bucket(keyOf(item.project_id, Date.parse(item.created_at))).itemsCreated += 1;
  for (const event of rows.itemEvents) {
    const b = bucket(keyOf(event.project_id, Date.parse(event.created_at)));
    if (event.to_status === "pending" && event.from_status && event.from_status !== "pending") b.reopens += 1;
    if (event.to_status === "pending" || event.from_status !== "pending") continue;
    if (event.source === "agent") {
      b.agentClosures += 1;
      if (event.actor_session_id) b.agentClosuresWithSession += 1;
    } else if (event.source === "web") {
      // An accepted cleanup proposal is applied by the user in the Web, so it is a Web event carrying the proposal id.
      if (event.cleanup_proposal_id && backed.has(event.cleanup_proposal_id)) b.proposalClosures += 1;
      else b.webClosures += 1;
    }
  }

  const table = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, b]) => ({
      bucket: key,
      sessions: b.sessions,
      voidedPct: ratio(b.voided, b.sessions + b.voided),
      startedAtPct: ratio(b.startedAt, b.sessions),
      updatedAtPct: ratio(b.updatedAt, b.sessions),
      filesConfirmedPct: ratio(b.filesConfirmed, b.sessions),
      commitPct: ratio(b.commit, b.sessions),
      branchPct: ratio(b.branch, b.sessions),
      passedPct: ratio(b.passed, b.sessions),
      knowledgePer100Sessions: ratio(b.knowledgeSaved, b.sessions),
      knowledgeSaved: b.knowledgeSaved,
      knowledgeAppliesToPct: ratio(b.knowledgeWithAppliesTo, b.knowledgeSaved),
      knowledgeActiveNowPct: ratio(b.knowledgeActiveNow, b.knowledgeSaved),
      sessionsWithOpportunityPct: ratio(b.sessionsWithOpportunity, b.sessions),
      opportunities: b.opportunities,
      coveredSessions: b.coveredSessions,
      ambiguousPct: ratio(b.ambiguousSessions, b.coveredSessions),
      coveredOpportunities: b.coveredOpportunities,
      offeredPct: ratio(b.offeredOpportunities, b.coveredOpportunities),
      offeredByContextOnlyPct: ratio(b.offeredByContextOnly, b.offeredOpportunities),
      offeredPossiblyRecentListPct: ratio(b.offeredPossiblyRecentList, b.offeredOpportunities),
      offeredPctUnambiguous: ratio(b.offeredOpportunitiesUnambiguous, b.coveredOpportunitiesUnambiguous),
      windowKnowledgeReturned: b.windowKnowledgeReturned,
      offPathPct: ratio(b.windowKnowledgeOffPath, b.windowKnowledgeReturned),
      unscopedPct: ratio(b.windowKnowledgeUnscoped, b.windowKnowledgeReturned),
      readsPerSessionMedian: median(b.readsPerCoveredSession),
      returnedPerSessionMedian: median(b.returnedPerCoveredSession),
      contextMsMedian: median(b.contextDurations),
      appliedPerOpportunityPct: ratio(b.appliedOnOpportunity, b.opportunities),
      appliedClaims: b.appliedClaims,
      appliedPathConsistentPct: ratio(b.appliedPathConsistent, b.appliedClaims),
      contradicted: b.contradicted,
      retouched72hPct: ratio(b.retouched, b.sessions),
      itemsCreated: b.itemsCreated,
      agentClosures: b.agentClosures,
      agentClosuresWithSessionPct: ratio(b.agentClosuresWithSession, b.agentClosures),
      proposalClosures: b.proposalClosures,
      webClosures: b.webClosures,
      groundedClosurePct: ratio(
        b.agentClosuresWithSession + b.proposalClosures,
        b.agentClosures + b.proposalClosures + b.webClosures,
      ),
      reopens: b.reopens,
    }));
  return {
    totals: {
      projects: rows.projects.length,
      sessions: live.length,
      knowledge: knowledge.length,
      reads: rows.reads.length,
      auditCoverageFrom: Number.isFinite(auditFrom) ? new Date(auditFrom).toISOString().slice(0, 10) : null,
    },
    table,
  };
}

function printReport(report) {
  console.log(JSON.stringify(report.totals));
  const keys = Object.keys(report.table[0] ?? {});
  for (const key of keys) {
    console.log([key.padEnd(30), ...report.table.map((row) => String(row[key] ?? "-").padStart(16))].join(" "));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check: a fictional database built with the product schema, rows inserted with fixed times
// ---------------------------------------------------------------------------------------------------------------
async function seedSynthetic(path) {
  const { WorkIntelligenceStore } = await import("../../packages/storage/dist/index.js");
  new WorkIntelligenceStore(path).close();
  const db = new DatabaseSync(path);
  const at = (day, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
  const root = join(tmpdir(), "fictional-value-root");
  db.prepare(
    "INSERT INTO projects (id, name, root_path, status, created_at, updated_at) VALUES ('p', 'Fictional', ?, 'tracked', ?, ?)",
  ).run(root, at(1), at(1));
  const session = (id, startDay, startHour, endHour, files, extra = {}) =>
    db
      .prepare(
        `INSERT INTO sessions (id, project_id, idempotency_key, title, summary, status, completed_at, created_at,
           started_at, updated_at, changed_files_json, verification_json, commit_sha, voided_at)
         VALUES (?, 'p', ?, 'fictional', 'fictional', 'finalized', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `key-${id}`,
        at(startDay, endHour),
        at(startDay, endHour),
        at(startDay, startHour),
        at(startDay, endHour),
        JSON.stringify(files),
        JSON.stringify({ status: "passed" }),
        extra.commit ?? null,
        extra.voided ?? null,
      );
  const knowledge = (id, day, appliesTo, source = null, status = "active") =>
    db
      .prepare(
        `INSERT INTO knowledge (id, project_id, session_id, idempotency_key, kind, title, body, status, created_at,
           updated_at, applies_to_json)
         VALUES (?, 'p', ?, ?, 'pattern', 'fictional', 'fictional', ?, ?, ?, ?)`,
      )
      .run(id, source, `key-${id}`, status, at(day), at(day), JSON.stringify(appliesTo));
  const read = (id, day, hour, knowledgeIds, tool = "work_get_context") => {
    db.prepare(
      `INSERT INTO agent_read_audit (id, created_at, tool, project_id, outcome, returned_count, duration_ms)
       VALUES (?, ?, ?, 'p', 'ok', ?, 40)`,
    ).run(id, at(day, hour), tool, knowledgeIds.length);
    for (const k of knowledgeIds) {
      db.prepare(
        "INSERT INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES (?, 'knowledge', ?)",
      ).run(id, k);
    }
  };

  session("s1", 2, 1, 2, ["src/a.ts"]);
  knowledge("kA", 3, ["src/a.ts"], "s1");
  knowledge("kB", 3, ["src/b/**"]);
  knowledge("kU", 3, []);
  // Twelve newer Knowledge on unrelated files push kA, kB and kU out of the recent list before s2's read.
  for (let index = 0; index < 12; index += 1) knowledge(`kf${index}`, 4, ["docs/**"]);
  read("r0", 4, 0, []); // audit coverage starts here
  // s2: opportunity kA (offered), kB not an opportunity; kB returned => off-path, kU => unscoped.
  session("s2", 5, 1, 3, ["src/a.ts"], { commit: "c" });
  read("r1", 5, 2, ["kA", "kB", "kU"]);
  // s3: opportunities kA and kB, nothing offered; re-touches src/a.ts within 72 h of s2.
  session("s3", 6, 1, 3, ["src/a.ts", "src/b/x.ts"]);
  db.prepare(
    `INSERT INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at)
     VALUES ('f1', 'kA', 'p', 's3', 'applied', ?), ('f2', 'kB', 'p', 's2', 'applied', ?)`,
  ).run(at(6, 3), at(5, 3));
  // Outstanding: o1 closed by the Agent without a Session, reopened, then closed with an actor Session; o2 closed
  // through an accepted cleanup proposal with evidence, then reopened in the Web and closed there by hand.
  for (const [id, day] of [
    ["o1", 5],
    ["o2", 5],
  ]) {
    db.prepare(
      `INSERT INTO outstanding_items (id, source_session_id, project_id, position, text, status, created_at, updated_at)
       VALUES (?, 's2', 'p', 0, 'fictional', 'pending', ?, ?)`,
    ).run(id, at(day, 3), at(day, 3));
  }
  const event = (id, item, from, to, source, actor, proposal, day) =>
    db
      .prepare(
        `INSERT INTO outstanding_item_events (id, item_id, project_id, from_status, to_status, source, actor_session_id,
           created_at, cleanup_request_id, cleanup_proposal_id)
         VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, item, from, to, source, actor, at(day, 4), proposal ? "rq" : null, proposal);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(
    `INSERT INTO outstanding_cleanup_request_items
       (id, request_id, project_id, item_id, source_session_id, position, text, item_updated_at, source_updated_at,
        source_fingerprint, source_completed_at)
     VALUES ('ri', 'rq', 'p', 'o2', 's2', 0, 'fictional', '${at(5, 3)}', '${at(5, 3)}', 'fp', '${at(5, 3)}')`,
  );
  db.exec(
    `INSERT INTO outstanding_cleanup_proposals
       (id, request_id, project_id, request_item_id, submission_id, target_status, reason, review_status, created_at)
     VALUES ('cp1', 'rq', 'p', 'ri', 'sb', 'completed', 'fictional', 'accepted', '${at(6, 4)}')`,
  );
  db.exec(
    `INSERT INTO outstanding_cleanup_proposal_evidence
       (id, proposal_id, project_id, session_id, session_updated_at, session_fingerprint, session_completed_at)
     VALUES ('ev1', 'cp1', 'p', 's3', '${at(6, 3)}', 'fp', '${at(6, 3)}')`,
  );
  event("e0", "o1", "pending", "completed", "agent", null, null, 5);
  event("e5", "o1", "completed", "pending", "agent", null, null, 5);
  event("e1", "o1", "pending", "completed", "agent", "s3", null, 6);
  event("e2", "o2", "pending", "completed", "web", null, "cp1", 6);
  event("e3", "o2", "completed", "pending", "web", null, null, 7);
  event("e4", "o2", "pending", "completed", "web", null, null, 8);
  // s4: voided.
  session("s4", 7, 1, 2, ["src/a.ts"], { voided: at(7, 3) });
  db.close();
}

function assertSelfCheck(report) {
  const october = report.table.find((row) => row.bucket === "2026-10");
  assert(october, "october bucket");
  assert.equal(october.sessions, 3);
  assert.equal(october.voidedPct, 25);
  assert.equal(october.commitPct, 33.3);
  assert.equal(october.knowledgeSaved, 15);
  assert.equal(october.knowledgeAppliesToPct, 93.3);
  assert.equal(october.opportunities, 3, "s2:kA, s3:kA, s3:kB; s1 is kA's source and older");
  assert.equal(october.coveredSessions, 2);
  assert.equal(october.offeredPct, 33.3, "only s2:kA was returned in its window");
  assert.equal(october.windowKnowledgeReturned, 3);
  assert.equal(october.offPathPct, 33.3);
  assert.equal(october.unscopedPct, 33.3);
  assert.equal(october.appliedClaims, 2);
  assert.equal(october.appliedPathConsistentPct, 50, "s2 claimed kB but never changed src/b");
  assert.equal(october.retouched72hPct, 33.3, "s3 re-touches src/a.ts 1 day after s2; s2 is 3 days after s1");
  assert.equal(october.offeredByContextOnlyPct, 100);
  assert.equal(october.offeredPossiblyRecentListPct, 0, "kA was pushed out of the recent list by twelve newer items");
  assert.equal(october.itemsCreated, 2);
  assert.equal(october.agentClosures, 2);
  assert.equal(october.agentClosuresWithSessionPct, 50);
  assert.equal(october.proposalClosures, 1);
  assert.equal(october.webClosures, 1);
  assert.equal(october.groundedClosurePct, 50, "e1 (actor Session) and e2 (accepted proposal) of 4 closures");
  assert.equal(october.reopens, 2);
  assert.equal(october.contextMsMedian, 40);
  const depth = analyze(load(report.path), { byDepth: true });
  assert.deepEqual(
    depth.table.map((row) => [row.bucket, row.sessions]),
    [["depth-0000-0049", 3]],
  );
  assert.equal(depth.table[0].opportunities, 3);
  const split = analyze(load(report.path), { split: Date.parse("2026-10-05T00:00:00Z") });
  assert.deepEqual(
    split.table.map((row) => [row.bucket, row.sessions]),
    [
      ["after", 2],
      ["before", 1],
    ],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dbPath = flagValue(args, "--db");
  const jsonPath = flagValue(args, "--json");
  const splitText = flagValue(args, "--split");
  const split = splitText ? Date.parse(splitText) : undefined;
  const byDepth = args.includes("--by-depth");
  if (byDepth && splitText) throw new Error("--by-depth and --split cannot be combined.");
  if (splitText && !Number.isFinite(split)) throw new Error("--split must be a date such as 2026-11-01.");
  if (jsonPath && existsSync(jsonPath)) throw new Error("--json refuses to overwrite an existing file.");
  if (dbPath && !existsSync(dbPath)) throw new Error("--db file not found.");
  const temp = mkdtempSync(join(tmpdir(), "wi-value-metrics-"));
  try {
    const target = dbPath ?? join(temp, "synthetic.sqlite");
    if (!dbPath) await seedSynthetic(target);
    const started = performance.now();
    const report = { path: target, ...analyze(load(target), { split, byDepth }) };
    report.totals.elapsedMs = Math.round(performance.now() - started);
    printReport(report);
    if (jsonPath) {
      const output = { totals: report.totals, table: report.table };
      writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    }
    if (!dbPath) {
      assertSelfCheck(report);
      console.log("self-check passed");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
