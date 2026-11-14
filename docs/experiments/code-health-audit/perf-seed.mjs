import console from "node:console";
import process from "node:process";
// 合成資料產生器（不碰 repo 檔案、不碰真實 DB）。
// 用法：WI_ROOT=<已 build 的 repo 副本> node seed-micro.mjs <N sessions> <out.sqlite> [days=60]
// 資料形狀依真實規模比例：每 Session 約 2.7 個 nextSteps（1750/650）、Knowledge 約 0.22 N（146/650）、
// 兩個專案各半、檔案池 ~N/6 個不同路徑、每 Session 3-6 個 changedFiles、詞彙池 ~300 詞（混合 CJK）。
// 並輸出 finalize 每 1000 筆的延遲，用來看寫入路徑成長。
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const ROOT = resolve(process.env.WI_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url)));
const { WorkIntelligenceStore } = await import(pathToFileURL(join(ROOT, "packages/storage/dist/index.js")).href);
const N = Number(process.argv[2]); const out = process.argv[3]; const days = Number(process.argv[4] ?? 60);
if (existsSync(out)) rmSync(out);
const base = out + ".roots"; rmSync(base, { recursive: true, force: true });
const roots = [join(base, "alpha"), join(base, "beta")]; roots.forEach((r) => mkdirSync(r, { recursive: true }));
const store = new WorkIntelligenceStore(out);
roots.forEach((r, i) => { const p = store.addProject(i ? "beta" : "alpha", r); store.updateProject(p.id, { status: "tracked" }); });
let seedN = 12345; const rnd = () => (seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const words = "cache index session report graph render parser schema migrate recall finalize outstanding knowledge backup export import filter sort paginate query route handler hook store worker lease token revision trigger vacuum search tokenizer synonym digest timeline hotspot attention decision evidence verify redact path glob match scan budget limit batch stream sqlite transaction rollback commit lint typecheck build deploy docs i18n theme layout dialog panel icon motion".split(" ");
const cjk = ["路由","效能","索引","快取","遷移","備份","報告","知識","整理","待辦","搜尋","匯出","匯入","驗證"];
const w = () => rnd() < 0.12 ? cjk[Math.floor(rnd() * cjk.length)] : words[Math.floor(rnd() * words.length)];
const sentence = (n) => Array.from({ length: n }, w).join(" ");
const files = Math.max(60, Math.floor(N / 6));
const dirs = ["apps/web/src/views", "apps/server/src/routes", "packages/storage/src", "packages/core/src", "packages/schema/src", "apps/mcp/src", "docs", "tests"];
const file = (i) => `${dirs[i % dirs.length]}/f${i}.ts`;
const start = Date.now() - days * 86400000; const t0 = performance.now(); const latencies = [];
for (let i = 0; i < N; i++) {
  const completedAt = new Date(start + Math.floor((days * 86400000 * i) / N)).toISOString();
  const nf = 3 + Math.floor(rnd() * 4); const cf = Array.from({ length: nf }, () => file(Math.floor(rnd() ** 2 * files)));
  const ns = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 5);
  const a = performance.now();
  store.finalizeSession({
    projectRoot: roots[i % 2], idempotencyKey: `m-${i}`,
    title: `${sentence(4)} ${i}`, summary: `${sentence(25)}。`, completedAt,
    workSummary: { outcomes: [sentence(10), sentence(8)], scope: [sentence(5)], decisions: i % 8 === 0 ? [{ text: sentence(9), origin: "agent_autonomous" }] : [], verification: ["pnpm test passed"], nextSteps: Array.from({ length: ns }, () => sentence(8)) },
    changedFiles: [...new Set(cf)], verification: { status: i % 6 === 0 ? "not_run" : "passed", summary: "synthetic" },
    events: [{ type: "execution", summary: sentence(12), occurredAt: completedAt }, { type: "closing", summary: sentence(10), occurredAt: completedAt }],
  });
  latencies.push(performance.now() - a);
  if ((i + 1) % 1000 === 0 || i + 1 === N) { const seg = latencies.slice(-1000); const sorted = [...seg].sort((x, y) => x - y); console.log(`finalize ${i + 1}: median ${sorted[sorted.length >> 1].toFixed(2)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(2)} ms`); }
}
const K = Math.round(N * 0.22);
for (let k = 0; k < K; k++) {
  store.recordKnowledge({ projectRoot: roots[k % 2], idempotencyKey: `k-${k}`, kind: ["gotcha", "decision", "pattern", "reference"][k % 4] === "reference" ? "gotcha" : ["gotcha", "decision", "pattern"][k % 3], title: `${sentence(5)} ${k}`, body: sentence(40), tags: [w(), w()], appliesTo: k % 2 ? [`${dirs[k % dirs.length]}/**`] : [file(Math.floor(rnd() * files))] });
}
console.log(`seeded ${N} sessions + ${K} knowledge in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
store.close();
console.log(JSON.stringify({ roots }));
