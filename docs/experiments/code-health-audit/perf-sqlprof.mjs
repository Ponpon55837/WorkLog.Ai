import console from "node:console";
import process from "node:process";
// 針對單一函式：記錄每條 SQL 的執行次數/總耗時（含 N+1 偵測），並對耗時前幾名跑 EXPLAIN QUERY PLAN。
// 用法：WI_ROOT=... node sqlprof.mjs <db.sqlite> <case> [reps=5]
import { copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync, StatementSync } from "node:sqlite";
const ROOT = resolve(process.env.WI_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url)));
const { WorkIntelligenceStore } = await import(pathToFileURL(join(ROOT, "packages/storage/dist/index.js")).href);
const [src, caseName, repsArg] = process.argv.slice(2); const reps = Number(repsArg ?? 5);
const work = join(tmpdir(), `sqlprof-${process.pid}.sqlite`); for (const s of ["", "-wal", "-shm"]) rmSync(work + s, { force: true });
copyFileSync(src, work);
const A = src + ".roots/alpha";
const store = new WorkIntelligenceStore(work); store.syncSearchIndex();

const yfrom = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10); const yto = new Date().toISOString().slice(0, 10);
const mid = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const cases = {
  "context-focus": () => store.getContext(A, { task: "cache index report", paths: ["packages/storage/src/f3.ts", "apps/web/src/views/f8.ts"] }),
  "context": () => store.getContext(A),
  "recall-q": () => store.recall({ q: "cache index report", projectRoot: A, limit: 8 }),
  "search": () => store.search("cache index report"),
  "list-query": () => store.listSessionsPage({ query: "cache", page: 1, pageSize: 20 }),
  "hotspots": () => store.getHotspots({ limit: 20 }),
  "report-year": () => store.getReport({ period: "year", date: mid }),
  "report-month": () => store.getReport({ period: "month", date: mid }),
  "graph": () => store.getGraph({}),
  "dashboard": () => store.getDashboardSummary(),
  "attention": () => store.getAttention({}),
  "backfill-preview": () => store.previewMetadataBackfill({}),
  "finalize": (() => { let i = 0; return () => store.finalizeSession({ projectRoot: A, idempotencyKey: `sp-${caseName}-${++i}-${Math.random()}`, title: "cache index refactor", summary: "refactor cache index report", changedFiles: ["packages/storage/src/f3.ts", "apps/web/src/views/f8.ts", "packages/core/src/f12.ts"], verification: { status: "passed" }, workSummary: { outcomes: ["x"], scope: [], decisions: [], verification: [], nextSteps: ["follow up cache index report", "second step"] } }); })(),
  "export": () => store.exportProjectData({ type: "all" }),
  "timeline": () => store.getTimeline({ from: yfrom, to: yto }),
};
const fn = cases[caseName]; if (!fn) throw new Error("cases: " + Object.keys(cases).join(","));
fn(); fn();
const stats = new Map(); const sqlOf = new WeakMap();
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) { const st = origPrepare.call(this, sql); sqlOf.set(st, sql); return st; };
for (const m of ["get", "all", "run", "iterate"]) {
  const orig = StatementSync.prototype[m];
  StatementSync.prototype[m] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { const sql = sqlOf.get(this) ?? this.sourceSQL; const e = stats.get(sql) ?? { calls: 0, ms: 0, params: a }; e.calls++; e.ms += performance.now() - t; stats.set(sql, e); } };
}
let insp; if (process.env.CPUPROF) { const { Session } = await import("node:inspector"); insp = new Session(); insp.connect(); await new Promise((r) => insp.post("Profiler.enable", r)); await new Promise((r) => insp.post("Profiler.start", r)); }
const t0 = performance.now(); for (let i = 0; i < reps; i++) fn();
if (insp) { await new Promise((r) => insp.post("Profiler.stop", async (e, { profile }) => { (await import("node:fs")).writeFileSync(process.env.CPUPROF, JSON.stringify(profile)); r(); })); } const total = (performance.now() - t0) / reps;
const rows = [...stats.entries()].map(([sql, e]) => ({ sql, calls: e.calls / reps, ms: e.ms / reps, params: e.params })).sort((a, b) => b.ms - a.ms);
const sqlTotal = rows.reduce((s, r) => s + r.ms, 0);
console.log(`case=${caseName} total/call=${total.toFixed(1)}ms sql-total=${sqlTotal.toFixed(1)}ms (${(100 * sqlTotal / total).toFixed(0)}%) distinct-sql=${rows.length} calls=${rows.reduce((s, r) => s + r.calls, 0)}`);
const db2 = new DatabaseSync(work, { readOnly: true });
for (const r of rows.slice(0, 7)) {
  console.log(`\n--- ${r.ms.toFixed(2)} ms/call-total, ${r.calls} calls/run:\n${r.sql.replace(/\s+/g, " ").slice(0, 260)}`);
  try { const params = r.params.filter((p) => ["string", "number", "bigint"].includes(typeof p) || p === null); const plan = db2.prepare("EXPLAIN QUERY PLAN " + r.sql).all(...params); for (const p of plan) console.log("   PLAN " + p.detail); } catch (e) { console.log("   (explain skipped: " + String(e.message).slice(0, 60) + ")"); }
}
store.close(); for (const s of ["", "-wal", "-shm"]) rmSync(work + s, { force: true });
