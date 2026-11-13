// Read-only aggregate field-gap metrics for a WorkLog.Ai / Work Intelligence SQLite database.
//
// Run (Node >= 22.12, uses the built-in node:sqlite, the same driver the repo uses):
//   node docs/experiments/observed-rules-field-gap-metrics.mjs /path/to/work-intelligence.db [--month-basis=created|completed] 2>/dev/null
//
// Privacy: prints ONLY aggregate JSON (counts, rates, small enums, month buckets, normalised client buckets).
// It never prints ids, titles, summaries, paths, idempotency keys, project names or any record text.
// The DB is opened read-only (SQLITE_OPEN_READONLY via { readOnly: true }) plus PRAGMA query_only=1.
// Missing tables/columns are reported as "column_absent" / "table_absent" instead of failing.
import console from "node:console";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const dbPath = process.argv[2];
const basis = (process.argv.find((a) => a.startsWith("--month-basis=")) ?? "--month-basis=created").split("=")[1];
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: node observed-rules-field-gap-metrics.mjs <db-path> [--month-basis=created|completed]");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA query_only = 1");

const ABSENT = "column_absent";
const tableColumns = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
const T = Object.fromEntries(
  ["sessions", "session_decisions", "session_links", "knowledge_feedback", "outstanding_items",
    "outstanding_item_events", "work_events", "agent_read_audit"].map((t) => [t, tableColumns(t)]),
);
const has = (t, c) => T[t].has(c);
const absentColumns = {};
for (const [t, cols] of Object.entries(T)) if (cols.size === 0) absentColumns[t] = "table_absent";
if (T.sessions.size === 0) {
  console.log(JSON.stringify({ error: "sessions_table_absent" }));
  process.exit(0);
}
const want = {
  sessions: ["created_at", "completed_at", "started_at", "updated_at", "agent_client", "agent_model", "commit_sha",
    "git_branch", "changed_files_json", "changed_files_confirmed", "changed_files_provenance_json",
    "changed_file_changes_json", "verification_json", "work_summary_json", "idempotency_key", "voided_at",
    "project_id"],
};
for (const c of want.sessions) if (!has("sessions", c)) (absentColumns.sessions ??= {})[c] = ABSENT;
// git "dirty", baselineChangedFiles and the request's changedFiles-vs-git comparison are never stored.
const notStored = ["git_dirty", "baselineChangedFiles", "git_worktree_status_at_finalize"];

const col = (c, alias = c) => (has("sessions", c) ? `s.${c} AS ${alias}` : `NULL AS ${alias}`);
const sessions = db
  .prepare(
    `SELECT s.id AS id, ${col("project_id")}, ${col("created_at")}, ${col("completed_at")}, ${col("started_at")},
            ${col("updated_at")}, ${col("agent_client")}, ${col("agent_model")}, ${col("commit_sha")},
            ${col("git_branch")}, ${col("changed_files_json")}, ${col("changed_files_confirmed")},
            ${col("changed_files_provenance_json")}, ${col("changed_file_changes_json")}, ${col("verification_json")},
            ${col("work_summary_json")}, ${col("idempotency_key")}, ${col("voided_at")}
     FROM sessions s`,
  )
  .all();

// ---- per-session side tables, keyed by session id (kept in memory only; never printed) ----
const mapCount = (sql, ok) => {
  const m = new Map();
  if (!ok) return null;
  for (const r of db.prepare(sql).all()) m.set(r.k, (m.get(r.k) ?? 0) + r.n);
  return m;
};
const decisionsByOrigin = new Map(); // id -> {user_requested, agent_autonomous, unspecified}
const decisionsOk = has("session_decisions", "origin");
if (decisionsOk) {
  for (const r of db.prepare("SELECT session_id k, origin o, COUNT(*) n FROM session_decisions GROUP BY 1,2").all()) {
    const e = decisionsByOrigin.get(r.k) ?? {};
    e[r.o] = r.n;
    decisionsByOrigin.set(r.k, e);
  }
}
const parentOf = mapCount(
  "SELECT session_id k, COUNT(*) n FROM session_links WHERE relation='continues' GROUP BY 1",
  has("session_links", "relation"),
);
const relatedOf = mapCount(
  "SELECT session_id k, COUNT(*) n FROM session_links WHERE relation='related' GROUP BY 1",
  has("session_links", "relation"),
);
const linkSourceAgent = mapCount(
  "SELECT session_id k, COUNT(*) n FROM session_links WHERE source='agent' GROUP BY 1",
  has("session_links", "source"),
);
const appliedOf = mapCount(
  "SELECT session_id k, COUNT(*) n FROM knowledge_feedback WHERE kind='applied' AND session_id IS NOT NULL GROUP BY 1",
  has("knowledge_feedback", "kind"),
);
const contradictedOf = mapCount(
  "SELECT session_id k, COUNT(*) n FROM knowledge_feedback WHERE kind='contradicted' AND session_id IS NOT NULL GROUP BY 1",
  has("knowledge_feedback", "kind"),
);
const outstandingCreated = mapCount(
  "SELECT source_session_id k, COUNT(*) n FROM outstanding_items GROUP BY 1",
  has("outstanding_items", "source_session_id"),
);
const outstandingClosedByActor = mapCount(
  `SELECT actor_session_id k, COUNT(*) n FROM outstanding_item_events
   WHERE source='agent' AND to_status IN ('completed','not_needed') AND actor_session_id IS NOT NULL GROUP BY 1`,
  has("outstanding_item_events", "actor_session_id"),
);
// Server-observed start: finalize stores a work_events note with details_json.source = 'server_observed'.
const serverObserved = new Set();
const serverObservedGitStatus = new Set(); // work_events note details {field:'changedFileChanges', source:'server_observed_git'} (integration branch)
if (has("work_events", "details_json")) {
  for (const r of db
    .prepare(
      `SELECT session_id k FROM work_events WHERE json_valid(details_json) AND json_extract(details_json,'$.field')='startedAt'
       AND json_extract(details_json,'$.source')='server_observed'`,
    )
    .all())
    serverObserved.add(r.k);
  for (const r of db
    .prepare(
      `SELECT session_id k FROM work_events WHERE json_valid(details_json) AND json_extract(details_json,'$.field')='changedFileChanges'
       AND json_extract(details_json,'$.source')='server_observed_git'`,
    )
    .all())
    serverObservedGitStatus.add(r.k);
}
// First server-observed MCP read for the project after the previous Session's completion (agent_read_audit).
const auditByProject = new Map();
if (has("agent_read_audit", "created_at") && has("agent_read_audit", "project_id")) {
  for (const r of db.prepare("SELECT project_id p, created_at t FROM agent_read_audit WHERE project_id IS NOT NULL ORDER BY created_at").all()) {
    (auditByProject.get(r.p) ?? auditByProject.set(r.p, []).get(r.p)).push(r.t);
  }
}
const sessionsByProject = new Map();
for (const s of sessions) (sessionsByProject.get(s.project_id) ?? sessionsByProject.set(s.project_id, []).get(s.project_id)).push(s);
const prevCompleted = new Map();
for (const list of sessionsByProject.values()) {
  list.sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  list.forEach((s, i) => prevCompleted.set(s.id, i ? list[i - 1].completed_at : ""));
}

// ---- helpers ----
const KNOWN = ["claude-code", "codex", "claude-desktop", "cursor", "vscode", "other"];
function normaliseClient(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "(missing)";
  const v = String(raw).toLowerCase();
  if (v.includes("claude-code") || v.includes("claude code")) return "claude-code";
  if (v.includes("codex")) return "codex";
  if (v.includes("claude-ai") || v.includes("claude desktop") || v.includes("claude-desktop")) return "claude-desktop";
  if (v.includes("cursor")) return "cursor";
  if (v.includes("vscode") || v.includes("visual studio code") || v.includes("vs code") || v.includes("copilot")) return "vscode";
  return "other";
}
const parse = (text, fallback) => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
const monthOf = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "(none)");
const bump = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);
const bucketCount = (n) => (n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : "4+");
const bucketKey = (n) => (n < 16 ? "<16" : n <= 40 ? "16-40" : ">40");
const ms = (iso) => Date.parse(iso);

function newCell() {
  return { sessions: 0, missing: {}, errors: {}, distributions: { verification_status: {}, provenance_sources: {}, next_steps: {}, decision_origin: {}, start_source: {}, change_status_source: {}, changed_files_shape: {}, commit_sha_length: {}, completedAt_backfill_gap: {}, idempotency_key_length: {}, applied_knowledge: {}, contradicted_knowledge: {} }, links: {}, counters: { decisions_total: 0, next_steps_total: 0 } };
}
const cells = new Map();
let voidedExcluded = 0;
for (const s of sessions) {
  if (s.voided_at) { voidedExcluded++; continue; }
  const month = monthOf(basis === "completed" ? s.completed_at : s.created_at);
  const client = normaliseClient(s.agent_client);
  const key = `${month}|${client}`;
  const c = cells.get(key) ?? cells.set(key, newCell()).get(key);
  c.sessions++;
  const M = (name) => bump(c.missing, name);
  const E = (name) => bump(c.errors, name);
  const files = parse(s.changed_files_json, []);
  const prov = parse(s.changed_files_provenance_json, []);
  const changes = parse(s.changed_file_changes_json, []);
  const verification = parse(s.verification_json, null);
  const ws = parse(s.work_summary_json, {});

  if (!s.agent_model) M("agentModel");
  else if (!/^(claude|gpt|o\d|gemini|codex)/i.test(String(s.agent_model))) E("agentModel_unrecognised_format");
  if (!s.started_at) M("startedAt");
  if (!s.commit_sha) M("commitSha");
  if (!s.git_branch) M("gitBranch");
  if (!verification) M("verification");
  else if (!String(verification.summary ?? "").trim()) M("verificationSummary");
  if (files.length === 0) M("changedFiles");
  bump(
    c.distributions.changed_files_shape,
    files.length > 0 ? "non_empty" : s.changed_files_confirmed ? "empty_but_confirmed" : "empty_unconfirmed",
  );
  bump(c.distributions.commit_sha_length, s.commit_sha ? `len_${String(s.commit_sha).length}` : "none");
  if (has("sessions", "changed_files_confirmed") && !s.changed_files_confirmed) M("changedFilesConfirmed");
  if (files.length > 0 && prov.length === 0) M("changedFilesProvenance");
  if (files.length > 0 && changes.length === 0) M("changedFileChanges");
  if (!(parentOf?.get(s.id))) M("parentSession");
  if (files.length > 0) {
    const covered = new Set(changes.flatMap((x) => [x.path, x.previousPath].filter(Boolean)));
    const uncovered = files.filter((f) => !covered.has(f)).length;
    if (uncovered > 0) M("changedFileChangesPartial");
    bump(c.distributions.change_status_source, serverObservedGitStatus.has(s.id) ? "server_observed_git" : changes.length ? "agent_reported" : "none");
  }

  bump(c.distributions.verification_status, verification?.status ?? "(none)");
  const srcs = new Set();
  for (const p of prov) for (const src of p.sources ?? []) srcs.add(src);
  for (const src of srcs) bump(c.distributions.provenance_sources, `session_has_${src}`);
  if (files.length > 0 && srcs.size === 0) bump(c.distributions.provenance_sources, "files_without_provenance");
  const prov1 = prov.filter((p) => (p.sources ?? []).length === 1 && p.sources[0] === "agent").length;
  if (prov.length > 0 && prov1 === prov.length) bump(c.distributions.provenance_sources, "agent_only_session");
  const next = Array.isArray(ws.nextSteps) ? ws.nextSteps.length : outstandingCreated?.get(s.id) ?? 0;
  bump(c.distributions.next_steps, bucketCount(next));
  c.counters.next_steps_total += next;
  const d = decisionsByOrigin.get(s.id) ?? {};
  const dTotal = Object.values(d).reduce((a, b) => a + b, 0);
  const wsDecisions = Array.isArray(ws.decisions) ? ws.decisions.length : 0;
  c.counters.decisions_total += decisionsOk ? dTotal : wsDecisions;
  if (decisionsOk) {
    for (const [o, n] of Object.entries(d)) bump(c.distributions.decision_origin, o, n);
    if (d.unspecified) E("decisions_origin_missing_sessions");
  } else bump(c.distributions.decision_origin, ABSENT);
  bump(c.distributions.start_source, !s.started_at ? "none" : serverObserved.has(s.id) ? "server_observed" : "reported_or_events");
  bump(c.distributions.idempotency_key_length, bucketKey(String(s.idempotency_key ?? "").length));
  bump(c.distributions.applied_knowledge, bucketCount(appliedOf?.get(s.id) ?? 0));
  bump(c.distributions.contradicted_knowledge, bucketCount(contradictedOf?.get(s.id) ?? 0));
  if (relatedOf?.get(s.id)) bump(c.links, "sessions_with_related_links");
  if (parentOf?.get(s.id)) bump(c.links, "sessions_with_parent_link");
  if (linkSourceAgent?.get(s.id)) bump(c.links, "sessions_with_agent_created_link");
  if (outstandingClosedByActor?.get(s.id)) bump(c.links, "sessions_that_closed_outstanding_items");
  if (outstandingCreated?.get(s.id)) bump(c.links, "sessions_with_outstanding_items");

  // ---- error-rate checks (no text semantics) ----
  const st = s.started_at ? ms(s.started_at) : NaN;
  const en = s.completed_at ? ms(s.completed_at) : NaN;
  if (!Number.isNaN(st) && !Number.isNaN(en)) {
    if (en < st) E("endedAt_before_startedAt");
    else if (en - st > 24 * 3600e3) E("segment_longer_than_24h");
    else if (en - st === 0) E("segment_zero_length");
  }
  if (s.created_at && s.completed_at && ms(s.completed_at) < ms(s.created_at) - 1000) {
    E("completedAt_backfilled_before_createdAt");
    const gapHours = (ms(s.created_at) - ms(s.completed_at)) / 3600e3;
    bump(
      c.distributions.completedAt_backfill_gap,
      gapHours < 1 ? "<1h" : gapHours < 24 ? "1-24h" : gapHours < 24 * 7 ? "1-7d" : ">7d",
    );
  }
  if (s.updated_at && s.created_at && s.updated_at < s.created_at) E("updatedAt_before_createdAt");
  if (verification && verification.status === "passed" && !String(verification.summary ?? "").trim()) E("verification_passed_without_summary");
  if (verification && ["in_progress", "not_run"].includes(verification.status)) E("verification_not_final");
  if (files.length === 0 && next === 0 && dTotal === 0 && wsDecisions === 0) E("empty_files_and_no_decisions_or_nextsteps");
  if (s.commit_sha && !s.git_branch) E("commit_without_branch");
  if (files.length > 0 && changes.some((x) => x.status === "renamed" && !x.previousPath)) E("renamed_without_previousPath");
  if (!Number.isNaN(st) && auditByProject.size) {
    const from = prevCompleted.get(s.id) ?? "";
    const firstCall = (auditByProject.get(s.project_id) ?? []).find((t) => t > from && t <= s.completed_at);
    if (firstCall) {
      bump(c.errors, "sessions_with_observed_call_in_segment");
      if (st > ms(firstCall) + 60_000) E("startedAt_after_first_observed_call_by_1min");
    }
  }
  if (!Number.isNaN(st) && !s.agent_client && !s.agent_model) E("no_agent_identity_at_all");
}

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : 0);
const out = [];
for (const [key, c] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
  const [month, client] = key.split("|");
  const missing_rate = {};
  for (const [k, n] of Object.entries(c.missing)) missing_rate[k] = rate(n, c.sessions);
  const error_rate = {};
  for (const [k, n] of Object.entries(c.errors)) error_rate[k] = rate(n, c.sessions);
  out.push({ month, client, ...c, missing_rate, error_rate });
}
// totals per client across all months
const totals = {};
for (const row of out) {
  const t = (totals[row.client] ??= { sessions: 0, missing: {} });
  t.sessions += row.sessions;
  for (const [k, n] of Object.entries(row.missing)) bump(t.missing, k, n);
}
for (const t of Object.values(totals)) t.missing_rate = Object.fromEntries(Object.entries(t.missing).map(([k, n]) => [k, rate(n, t.sessions)]));

console.log(
  JSON.stringify(
    {
      meta: {
        month_basis: basis,
        known_client_buckets: KNOWN,
        sessions_total: sessions.length - voidedExcluded,
        voided_excluded: voidedExcluded,
        absent: absentColumns,
        not_stored_in_db: notStored,
        field_sources: {
          agentModel: "sessions.agent_model", agentClient: "sessions.agent_client (MCP clientInfo.name)",
          decision_origin: "session_decisions.origin", verification: "sessions.verification_json {status,summary}",
          git: "sessions.git_branch/commit_sha (dirty/worktree not stored)",
          changedFiles: "sessions.changed_files_json + changed_files_confirmed + changed_files_provenance_json + changed_file_changes_json",
          baselineChangedFiles: "not stored", links: "session_links(relation,source)",
          knowledge: "knowledge_feedback(kind applied|contradicted)", nextSteps: "sessions.work_summary_json.nextSteps + outstanding_items",
          idempotency: "sessions.idempotency_key (only length bucket printed)",
          start_end: "sessions.started_at / completed_at / created_at / updated_at; server-observed start = work_events note details.source=server_observed",
          outstanding_resolution: "outstanding_item_events(actor_session_id, to_status)",
        },
      },
      totals_by_client: totals,
      cells: out,
    },
    null,
    1,
  ),
);
db.close();
