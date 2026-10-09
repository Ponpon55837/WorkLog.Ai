import assert from "node:assert/strict";
import console from "node:console";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";

// Use only the base synthetic snapshot produced by WI_BENCH_CACHE, never a live project database.
const input = process.argv[2];
const output = process.argv[3];
assert(
  input && output,
  "Usage: node docs/experiments/attention-query-probe.mjs <synthetic cache.sqlite> <new output.json>",
);
const root = mkdtempSync(join(tmpdir(), "wi-attention-probe-"));
const databasePath = join(root, "fictional.sqlite");
copyFileSync(input, databasePath);
const database = new DatabaseSync(databasePath);
let store;
const inspector = new InspectorSession();
const originalPrepare = DatabaseSync.prototype.prepare;
const plans = new Map();

try {
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM sessions WHERE idempotency_key NOT LIKE 'bench-%'").get().n,
    0,
    "Only the benchmark base snapshot is accepted",
  );
  const count = database.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  assert.equal(count, 5000, "This probe measures the 5,000-Session synthetic fixture");
  const projects = database.prepare("SELECT id, name FROM projects ORDER BY name").all();
  assert.deepEqual(
    projects.map((p) => p.name),
    ["alpha", "beta"],
  );
  for (const project of projects) {
    const projectRoot = join(root, project.name);
    mkdirSync(projectRoot);
    database.prepare("UPDATE projects SET root_path = ? WHERE id = ?").run(projectRoot, project.id);
    project.rootPath = projectRoot;
  }
  store = new WorkIntelligenceStore(databasePath);
  const alpha = projects[0];
  for (let i = 0; i < 20; i++) {
    store.recordKnowledge({
      projectRoot: alpha.rootPath,
      idempotencyKey: `probe-rule-${i}`,
      kind: "pattern",
      title: `Fictional rule ${i}`,
      body: "Fictional trust input.",
      appliesTo: ["src/**"],
    });
  }
  database
    .prepare("UPDATE knowledge SET created_at = ?, last_confirmed_at = ?")
    .run("2025-09-01T00:00:00.000Z", "2025-09-01T00:00:00.000Z");
  const source = store.listSessionsPage({ projectId: alpha.id, pageSize: 1 }).items[0];
  for (const slug of ["architecture", "pitfalls", "in-progress"]) {
    store.requestKnowledgePageUpdate({ projectRoot: alpha.rootPath, slug });
    store.saveKnowledgePage({
      projectRoot: alpha.rootPath,
      slug,
      idempotencyKey: `probe-page-${slug}`,
      sections: [
        { heading: "Fictional section", content: "Fictional source evidence.", sourceSessionIds: [source.id] },
      ],
    });
  }
  database.prepare("UPDATE knowledge_pages SET sourced_through = ?").run("2025-09-01T00:00:00.000Z");
  // Trace one read, including its actual bind values, then restore before any timed sample.
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    const connection = this;
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if ((key === "all" || key === "get") && /^(SELECT|WITH)\s/i.test(sql.trim())) {
          return (...bindings) => {
            if (!plans.has(sql)) {
              const rows = originalPrepare.call(connection, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
              plans.set(
                sql,
                rows.map((row) => row.detail),
              );
            }
            return value.apply(target, bindings);
          };
        }
        return value.bind(target);
      },
    });
  };
  const result = store.getAttention();
  assert.equal(result.outcome, "attention");
  assert(result.groups.every((g) => g.state !== "failed"));
  assert.equal(result.groups.find((g) => g.kind === "knowledge").total, 20);
  DatabaseSync.prototype.prepare = originalPrepare;
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const started = performance.now();
    store.getAttention();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
  for (let i = 0; i < 100; i++) store.getAttention();
  const { profile } = await inspector.post("Profiler.stop");
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName || "anonymous"]));
  const cpu = new Map();
  profile.samples.forEach((id, i) =>
    cpu.set(names.get(id), (cpu.get(names.get(id)) ?? 0) + profile.timeDeltas[i] / 1000),
  );
  const report = {
    fixture: { sessions: count, projects: projects.length, knowledge: 20, pages: 3 },
    sampleCount: samples.length,
    medianMs: Number(samples[7].toFixed(2)),
    p90Ms: Number(samples[13].toFixed(2)),
    maxMs: Number(samples[14].toFixed(2)),
    coverage: result.groups,
    plans: [...plans].map(([sql, plan]) => ({ sql: sql.replace(/\s+/g, " ").trim(), plan })),
    cpuSampledMs: [...cpu]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([functionName, ms]) => ({ functionName, ms: Number(ms.toFixed(2)) })),
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify({
      sessions: count,
      medianMs: report.medianMs,
      p90Ms: report.p90Ms,
      sqlPlans: report.plans.length,
      cpu: report.cpuSampledMs.slice(0, 4),
    }),
  );
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  inspector.disconnect();
  store?.close();
  database.close();
  rmSync(root, { recursive: true, force: true });
}
