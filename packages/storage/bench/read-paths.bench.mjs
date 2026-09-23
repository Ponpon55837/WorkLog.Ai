// Synthetic read-path benchmark for WorkIntelligenceStore.
//
// Usage:
//   pnpm --filter @work-intelligence/storage build
//   node packages/storage/bench/read-paths.bench.mjs [sessionCount]
//
// Seeding thousands of Sessions is slow, so set WI_BENCH_CACHE=<path prefix> to keep the
// seeded SQLite file and reuse it on the next run (for before/after comparisons).
import console from "node:console";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { WorkIntelligenceStore } from "../dist/index.js";

const sessionCount = Number(process.argv[2] ?? 5000);
const runs = 15;
const root = mkdtempSync(join(tmpdir(), "wi-bench-"));
const alphaRoot = join(root, "alpha");
const betaRoot = join(root, "beta");
mkdirSync(alphaRoot);
mkdirSync(betaRoot);

const cachePath = process.env.WI_BENCH_CACHE ? `${process.env.WI_BENCH_CACHE}.${sessionCount}.sqlite` : undefined;
const databasePath = join(root, "bench.sqlite");
const cached = Boolean(cachePath && existsSync(cachePath));
if (cached) {
  copyFileSync(cachePath, databasePath);
}
const store = new WorkIntelligenceStore(databasePath);

function seed() {
  const roots = [alphaRoot, betaRoot];
  for (const [index, projectRoot] of roots.entries()) {
    const project = store.addProject(index === 0 ? "alpha" : "beta", projectRoot);
    store.updateProject(project.id, { status: "tracked" });
  }

  const start = Date.parse("2025-10-01T00:00:00.000Z");
  const span = 365 * 24 * 3600 * 1000;
  const started = performance.now();
  for (let index = 0; index < sessionCount; index += 1) {
    const completedAt = new Date(start + Math.floor((span * index) / sessionCount)).toISOString();
    store.finalizeSession({
      projectRoot: roots[index % 2],
      idempotencyKey: `bench-${index}`,
      title: `Session ${index} ${index % 7 === 0 ? "graph renderer" : "report pipeline"}`,
      summary: `Completed synthetic task ${index} for benchmark coverage.`,
      completedAt,
      workSummary: {
        outcomes: [`Outcome ${index}`],
        scope: [`src/module-${index % 40}.ts`],
        decisions: [],
        verification: ["pnpm test passed"],
        nextSteps: [],
      },
      changedFiles: [`src/module-${index % 40}.ts`, `src/feature-${index % 90}/index.ts`],
      verification: { status: index % 5 === 0 ? "not_run" : "passed", summary: "synthetic" },
      events: [
        { type: "execution", summary: `Implemented step ${index}`, occurredAt: completedAt },
        { type: index % 3 === 0 ? "closing" : "verification", summary: `Verified step ${index}`, occurredAt: completedAt },
      ],
    });
  }
  console.log(`seeded ${sessionCount} sessions in ${(performance.now() - started).toFixed(0)} ms`);
}

try {
  if (!cached) {
    seed();
    if (cachePath) {
      store.close();
      copyFileSync(databasePath, cachePath);
    }
  }
  const benchStore = cachePath && !cached ? new WorkIntelligenceStore(databasePath) : store;
  const beta = benchStore.listProjects().find((project) => project.name === "beta");

  const cases = {
    "listSessionsPage (default)": () => benchStore.listSessionsPage({ page: 1, pageSize: 20 }),
    "listSessionsPage (page 50)": () => benchStore.listSessionsPage({ page: 50, pageSize: 20 }),
    "listSessionsPage (date range)": () =>
      benchStore.listSessionsPage({ from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (project + range)": () =>
      benchStore.listSessionsPage({ projectId: beta.id, from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (query)": () => benchStore.listSessionsPage({ query: "graph", page: 1, pageSize: 20 }),
    getDashboardSummary: () => benchStore.getDashboardSummary(),
    "getReport week": () => benchStore.getReport({ period: "week", date: "2026-03-11" }),
    "getReport month": () => benchStore.getReport({ period: "month", date: "2026-03-11" }),
    "getReport year": () => benchStore.getReport({ period: "year", date: "2026-03-11" }),
    getContext: () => benchStore.getContext(),
    search: () => benchStore.search("renderer"),
    previewMetadataBackfill: () => benchStore.previewMetadataBackfill({}),
    getGraph: () => benchStore.getGraph({}),
  };

  const results = [];
  for (const [name, run] of Object.entries(cases)) {
    run();
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      run();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    results.push({
      case: name,
      medianMs: Number(samples[Math.floor(runs / 2)].toFixed(2)),
      maxMs: Number(samples[runs - 1].toFixed(2)),
    });
  }
  console.table(results);
  benchStore.close();
} finally {
  try {
    store.close();
  } catch {
    // Already closed after seeding.
  }
  rmSync(root, { recursive: true, force: true });
}
