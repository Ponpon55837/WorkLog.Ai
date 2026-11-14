import console from "node:console";
import process from "node:process";
// 唯讀微 bench：對 seed-micro.mjs 產生的 DB 量測各公開讀取/寫入函式。
// 用法：WI_ROOT=<repo build> node micro.mjs <db.sqlite> [label]   （先複製 DB，不改原檔）
import { copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
const ROOT = resolve(process.env.WI_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url)));
const { WorkIntelligenceStore } = await import(pathToFileURL(join(ROOT, "packages/storage/dist/index.js")).href);
const src = process.argv[2]; const label = process.argv[3] ?? src;
const work = join(tmpdir(), `micro-${process.pid}.sqlite`);
for (const s of ["", "-wal", "-shm"]) rmSync(work + s, { force: true });
copyFileSync(src, work);
const roots = [src + ".roots/alpha", src + ".roots/beta"];
const ms = (f) => { const a = performance.now(); const r = f(); return [performance.now() - a, r]; };
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const results = {};
function bench(name, fn, { runs = 9, before } = {}) {
  before?.(); fn(); // warm
  const xs = [];
  for (let i = 0; i < runs; i++) { before?.(); xs.push(ms(fn)[0]); }
  results[name] = Number(med(xs).toFixed(2));
  console.log(`${label}\t${name}\t${results[name]}`);
}
// 冷啟動：開啟既有 DB（migration 檢查、初始化）
{ const xs = []; for (let i = 0; i < 5; i++) { const [t, s] = ms(() => new WorkIntelligenceStore(work)); xs.push(t); s.close(); } results["store open (existing db)"] = Number(med(xs).toFixed(2)); console.log(`${label}\tstore open (existing db)\t${results["store open (existing db)"]}`); }
const store = new WorkIntelligenceStore(work);
// 搜尋索引首次建立（全部 dirty）
{ const [t] = ms(() => store.syncSearchIndex()); results["syncSearchIndex (all dirty, first build)"] = Number(t.toFixed(1)); console.log(`${label}\tsyncSearchIndex first build\t${t.toFixed(1)}`); }
const side = new DatabaseSync(work); side.exec("PRAGMA busy_timeout=5000");
const touch = () => side.prepare("UPDATE projects SET updated_at = updated_at WHERE name='alpha'").run(); // 使 revision cache 失效
const A = roots[0];
const projects = store.listProjects(); const alpha = projects.find((p) => p.name === "alpha"); const beta = projects.find((p) => p.name === "beta");
const mid = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const m1 = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10); const m2 = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
const yfrom = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10); const yto = new Date().toISOString().slice(0, 10);
const focus = { task: "cache index report", paths: ["packages/storage/src/f3.ts", "apps/web/src/views/f8.ts"] };
bench("getContext (no focus)", () => store.getContext(A));
bench("getContext (no focus, after write)", () => store.getContext(A), { before: touch });
bench("getContext (task + paths)", () => store.getContext(A, focus));
bench("getContext (task + paths, after write)", () => store.getContext(A, focus), { before: touch });
bench("recall q", () => store.recall({ q: "cache index report", projectRoot: A, limit: 8 }));
bench("recall q (global)", () => store.recall({ q: "cache index report", limit: 8 }));
bench("recall paths", () => store.recall({ paths: ["packages/storage/src/f3.ts"], projectRoot: A, limit: 8 }));
bench("recall paths (after write)", () => store.recall({ paths: ["packages/storage/src/f3.ts"], projectRoot: A, limit: 8 }), { before: touch });
bench("recall 中文詞", () => store.recall({ q: "索引 快取", projectRoot: A, limit: 8 }));
bench("search", () => store.search("cache"));
bench("search (3 terms)", () => store.search("cache index report"));
bench("listSessionsPage default", () => store.listSessionsPage({ page: 1, pageSize: 20 }));
bench("listSessionsPage page 50", () => store.listSessionsPage({ page: 50, pageSize: 20 }));
bench("listSessionsPage query", () => store.listSessionsPage({ query: "cache", page: 1, pageSize: 20 }));
bench("listSessionsPage query 2 words", () => store.listSessionsPage({ query: "cache index", page: 1, pageSize: 20 }));
bench("listSessionsPage query no match", () => store.listSessionsPage({ query: "zzqxnomatch", page: 1, pageSize: 20 }));
bench("listSessionsPage project+range", () => store.listSessionsPage({ projectId: beta.id, from: m1, to: m2, page: 1, pageSize: 20 }));
bench("listSessionsPage agentClient", () => store.listSessionsPage({ agentClient: "x", page: 1, pageSize: 20 }));
bench("listSessions (non-paged, default)", () => store.listSessions({}));
bench("getDashboardSummary", () => store.getDashboardSummary());
bench("getReport week", () => store.getReport({ period: "week", date: mid }));
bench("getReport month", () => store.getReport({ period: "month", date: mid }));
bench("getReport year", () => store.getReport({ period: "year", date: mid }));
bench("getGraph default", () => store.getGraph({}));
bench("getGraph project", () => store.getGraph({ projectId: alpha.id }));
bench("getGraph includeDerived", () => store.getGraph({ includeDerived: true }));
bench("getTimeline (range)", () => store.getTimeline({ from: yfrom, to: yto }));
bench("getActivity (range)", () => store.getActivity({ from: yfrom, to: yto }));
bench("getHotspots files", () => store.getHotspots({ limit: 20 }));
bench("getHotspots directories", () => store.getHotspots({ groupBy: "directory", limit: 20 }));
bench("getFileHistory (3 paths)", () => store.getFileHistory({ projectRoot: A, paths: ["packages/storage/src/f0.ts", "apps/web/src/views/f1.ts", "packages/core/src/f3.ts"] }));
bench("getAttention", () => store.getAttention({}));
bench("listOutstandingItems pending", () => store.listOutstandingItems({ projectId: alpha.id, status: "pending", page: 1, pageSize: 20 }));
bench("listOutstandingItems all projects pending", () => store.listOutstandingItems({ status: "pending", page: 1, pageSize: 20 }));
bench("listSessionDecisions pending", () => store.listSessionDecisions({ status: "pending", limit: 50 }));
bench("listKnowledgePages", () => store.listKnowledgePages({}));
bench("searchKnowledge", () => store.searchKnowledge({ projectRoot: A, limit: 20 }));
bench("searchKnowledge q", () => store.searchKnowledge({ projectRoot: A, q: "cache index", limit: 20 }));
bench("searchKnowledgeForAgent paths", () => store.searchKnowledgeForAgent({ projectRoot: A, q: "cache", paths: ["packages/storage/src/f3.ts"] }));
bench("requestKnowledgeCandidates", () => store.requestKnowledgeCandidates(A));
bench("previewMetadataBackfill", () => store.previewMetadataBackfill({}));
bench("countMetadataBackfillFollowUps (after write)", () => store.countMetadataBackfillFollowUps(), { before: touch });
bench("getSessionDetail", () => store.getSessionDetail(store.listSessionsPage({ page: 1, pageSize: 1 }).items[0].id));
bench("getRelatedWork", () => store.getRelatedWork(store.listSessionsPage({ page: 1, pageSize: 1 }).items[0].id));
bench("exportProjectData (all)", () => store.exportProjectData({ type: "all" }), { runs: 3 });
let idx = 0;
const fin = (extra = {}) => () => store.finalizeSession({ projectRoot: A, idempotencyKey: `micro-fin-${label}-${++idx}`, title: "cache index refactor " + idx, summary: "refactor cache index report", changedFiles: ["packages/storage/src/f3.ts", "apps/web/src/views/f8.ts", "packages/core/src/f12.ts"], verification: { status: "passed" }, workSummary: { outcomes: ["x"], scope: [], decisions: [], verification: [], nextSteps: ["follow up cache index report", "second step"] }, ...extra });
bench("finalizeSession (3 files, 2 nextSteps)", fin(), { runs: 9 });
bench("finalizeSession + search sync (recall after)", () => { fin()(); store.recall({ q: "cache", projectRoot: A, limit: 5 }); }, { runs: 7 });
console.log("JSON " + JSON.stringify({ label, results }));
side.close(); store.close();
for (const s of ["", "-wal", "-shm"]) rmSync(work + s, { force: true });
