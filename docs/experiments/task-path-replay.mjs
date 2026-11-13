// Run from the tracked project root after building packages/storage:
// node docs/experiments/task-path-replay.mjs [database]
// The source is read in one read-only transaction. All replay writes go to an in-memory store.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";
import { normalizePath, parseQueryWords } from "../../packages/storage/dist/search-text.js";
import { appliesToStrength } from "../../packages/storage/dist/applies-to-match.js";

const root = process.cwd();
const db = new DatabaseSync(resolve(process.argv[2] ?? "data/work-intelligence.sqlite"), { readOnly: true });
db.exec("BEGIN");
const project = db.prepare("SELECT * FROM projects WHERE lower(root_path)=lower(?) AND status='tracked'").get(root);
assert(project, "Run from a tracked project root.");
const sessions = db.prepare("SELECT * FROM sessions WHERE project_id=? AND voided_at IS NULL").all(project.id);
const audits = db.prepare("SELECT occurred_at, after_json FROM knowledge_audit WHERE project_id=? ORDER BY julianday(occurred_at), rowid").all(project.id);
db.close();

const pathContext = [{ name: project.name, rootPath: project.root_path }];
const norm = (path) => normalizePath(path, pathContext);
const termsOf = (text) => new Set(parseQueryWords(text).flatMap((word) => word.terms).filter((t) => !/^\d+$/.test(t)));
// Remove explicit file/path tokens without consulting the answer files; preserve ordinary symptom and component words.
const hidePaths = (text) => text.replace(/(?:[A-Za-z]:)?(?:[\w@.~-]+[/\\])+[\w@./\\~-]+|[\w@-]+(?:\.[\w-]+)*\.(?:[cm]?[jt]sx?|vue|json|md|sql|ya?ml|toml|css|html|py|sh|ps1|sqlite)\b/giu, " ");
const unique = (xs) => [...new Set(xs)];
for (const row of sessions) {
  row.start = Date.parse(row.started_at);
  row.available = Math.max(...[row.completed_at, row.created_at, row.updated_at ?? row.created_at].map(Date.parse));
  row.files = unique(JSON.parse(row.changed_files_json).map(norm).filter(Boolean));
  row.terms = termsOf(row.title);
}
const history = sessions.filter((s) => Number.isFinite(s.available)).sort((a, b) => a.available - b.available);
const questions = sessions.filter((s) => Number.isFinite(s.start) && s.files.length).sort((a, b) => a.start - b.start);
const revisions = audits.map((row) => ({ time: Date.parse(row.occurred_at), k: JSON.parse(row.after_json) }));

function increment(map, key, value = 1) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topPaths(scores) {
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([path]) => path);
}

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

const store = new WorkIntelligenceStore(":memory:");
// Use the store's SQLite connection only for reconstructing selected historical rows in this research fixture.
// Product getContext and the product path matcher below run unmodified.
const scratch = store.db;
function insertSQL(table, fields) {
  return scratch.prepare("INSERT INTO " + table + " (" + fields.join(",") + ") VALUES (" + fields.map(() => "?").join(",") + ")");
}
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
const stats = Object.fromEntries(["task","frequent","predicted","actual"].map((key) => [key, {
  hits: 0, guesses: 0, correct: 0, contexts: 0, full: 0, other: 0, gained: 0, lost: 0, onNegative: 0, chars: 0,
}]));
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
  for (const [key, candidates] of Object.entries(paths)) {
    const a = stats[key];
    const correct = candidates.filter((file) => q.files.includes(file)).length;
    const slices = tags.map((tag) => {
      const group = (groups[tag] ??= {});
      return (group[key] ??= { tasks: 0, fileHits: 0, pairs: 0, full: 0, gained: 0, lost: 0, addedOutsideTarget: 0, removedOutsideTarget: 0 });
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
    const context = store.getContext(project.root_path, candidates.length ? { task, paths: candidates } : { task });
    const ids = fullIds(context, known);
    if (key === "task") baseline = ids;
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
  }
}
store.close();
for (const a of Object.values(stats)) assert.equal(a.full, stats.task.full + a.gained - a.lost);
console.log(JSON.stringify({ tally, stats, groups }, null, 2));
