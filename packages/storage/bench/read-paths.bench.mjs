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
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../dist/index.js";

const args = process.argv.slice(2);
const sessionCountArgument = args.find((argument) => !argument.startsWith("--"));
const sessionCount = Number(sessionCountArgument ?? 5000);
const checkMode = args.includes("--check");
if (!Number.isSafeInteger(sessionCount) || sessionCount < 1) {
  throw new Error("Session count must be a positive safe integer.");
}
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
      summary:
        index === 0
          ? `Completed synthetic task ${index} for benchmark coverage. 路由效能詞彙供 recall 基準使用。`
          : `Completed synthetic task ${index} for benchmark coverage.`,
      completedAt,
      workSummary: {
        outcomes: [`Outcome ${index}`],
        scope: [`src/module-${index % 40}.ts`],
        decisions: index % 10 === 0 ? [{ text: `Synthetic Agent decision ${index}`, origin: "agent_autonomous" }] : [],
        verification: ["pnpm test passed"],
        nextSteps: [],
      },
      changedFiles: [`src/module-${index % 40}.ts`, `src/feature-${index % 90}/index.ts`],
      verification: { status: index % 5 === 0 ? "not_run" : "passed", summary: "synthetic" },
      events: [
        { type: "execution", summary: `Implemented step ${index}`, occurredAt: completedAt },
        {
          type: index % 3 === 0 ? "closing" : "verification",
          summary: `Verified step ${index}`,
          occurredAt: completedAt,
        },
      ],
    });
  }
  console.log(`seeded ${sessionCount} sessions in ${(performance.now() - started).toFixed(0)} ms`);
}

// Knowledge older than every synthetic Session, so the staleness check scans the whole project history.
function seedStaleKnowledge(targetStore, project) {
  for (let index = 0; index < 20; index += 1) {
    targetStore.recordKnowledge({
      projectRoot: alphaRoot,
      idempotencyKey: `bench-knowledge-${index}`,
      kind: "gotcha",
      title: `Synthetic knowledge ${index}`,
      body: "Synthetic knowledge body used to measure the staleness check.",
      appliesTo: [`src/module-${index}.ts`, "src/feature-*/index.ts"],
    });
  }
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("UPDATE knowledge SET created_at = ?, last_confirmed_at = NULL WHERE project_id = ?")
      .run("2025-09-01T00:00:00.000Z", project.id);
  } finally {
    database.close();
  }
}

// Three written pages sourced before every synthetic Session, so the staleness count scans the whole history.
function seedKnowledgePages(targetStore, project) {
  const [source] = targetStore.listSessionsPage({ projectId: project.id, page: 1, pageSize: 1 }).items;
  for (const slug of ["architecture", "in-progress", "pitfalls"]) {
    targetStore.requestKnowledgePageUpdate({ projectRoot: alphaRoot, slug });
    const saved = targetStore.saveKnowledgePage({
      projectRoot: alphaRoot,
      slug,
      idempotencyKey: `bench-page-${slug}`,
      sections: Array.from({ length: 6 }, (_, index) => ({
        heading: `Synthetic section ${index}`,
        content: "Synthetic page content used to measure the bounded context digest. ".repeat(8),
        sourceSessionIds: [source.id],
      })),
    });
    if (saved.outcome !== "knowledge_page_saved") throw new Error(`Could not seed page ${slug}: ${saved.outcome}`);
  }
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("UPDATE knowledge_pages SET sourced_through = ? WHERE project_id = ?")
      .run("2025-09-01T00:00:00.000Z", project.id);
  } finally {
    database.close();
  }
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
  const alpha = benchStore.listProjects().find((project) => project.name === "alpha");
  const beta = benchStore.listProjects().find((project) => project.name === "beta");
  seedStaleKnowledge(benchStore, alpha);
  seedKnowledgePages(benchStore, alpha);
  // A file of the newest alpha Session, so the path search walks project → Session → file inside the graph.
  const [newestAlpha] = benchStore.listSessionsPage({ projectId: alpha.id, page: 1, pageSize: 1 }).items;
  const pathTarget = `file:${alpha.id}:${newestAlpha.changedFiles.at(-1)}`;
  const benchPath = benchStore.getGraphPath({ projectId: alpha.id, from: `project:${alpha.id}`, to: pathTarget });
  if (benchPath.outcome !== "graph_path" || !benchPath.found) {
    throw new Error("The graph path benchmark must measure a path that exists.");
  }

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
    "getContext (project with pages)": () => benchStore.getContext(alphaRoot),
    "listKnowledgePages (staleness)": () => benchStore.listKnowledgePages({}),
    "getKnowledgePageContext (review)": () =>
      benchStore.getKnowledgePageContext({ projectRoot: alphaRoot, slug: "pitfalls" }),
    "listSessionDecisions (pending)": () => benchStore.listSessionDecisions({ status: "pending", limit: 50 }),
    search: () => benchStore.search("renderer"),
    "recall (month range)": () =>
      benchStore.recall({ q: "report pipeline", from: "2026-03-01", to: "2026-03-31", limit: 8 }),
    "recall (synonym expansion)": () => benchStore.recall({ q: "endpoint performance", limit: 8 }),
    "searchKnowledge (staleness)": () => benchStore.searchKnowledge({ projectRoot: alphaRoot, limit: 20 }),
    previewMetadataBackfill: () => benchStore.previewMetadataBackfill({}),
    getGraph: () => benchStore.getGraph({}),
    "getGraph (with derived)": () => benchStore.getGraph({ includeDerived: true }),
    "getGraphPath (500 nodes)": () =>
      benchStore.getGraphPath({ projectId: alpha.id, from: `project:${alpha.id}`, to: pathTarget }),
    "getTimeline (month)": () => benchStore.getTimeline({ from: "2026-03-01", to: "2026-03-31" }),
    "getTimeline (year)": () => benchStore.getTimeline({ from: "2025-10-01", to: "2026-09-30" }),
    "getHotspots (files)": () => benchStore.getHotspots({ limit: 20 }),
    "getHotspots (directories, month)": () =>
      benchStore.getHotspots({ groupBy: "directory", from: "2026-03-01", to: "2026-03-31", limit: 20 }),
  };

  const limitsMs = {
    "listSessionsPage (default)": 200,
    getDashboardSummary: 1000,
    "getReport week": 750,
    "getReport year": 1500,
    getContext: 2500,
    "getContext (project with pages)": 500,
    "listKnowledgePages (staleness)": 250,
    "getKnowledgePageContext (review)": 250,
    "listSessionDecisions (pending)": 250,
    search: 500,
    "recall (month range)": 500,
    "recall (synonym expansion)": 500,
    "getGraph (with derived)": 750,
    "getGraphPath (500 nodes)": 750,
    "getTimeline (month)": 250,
    "getTimeline (year)": 750,
    "getHotspots (files)": 500,
    "getHotspots (directories, month)": 500,
    "searchKnowledge (staleness)": 500,
  };

  const results = [];
  const selectedCases = Object.entries(cases).filter(([name]) => !checkMode || name in limitsMs);
  for (const [name, run] of selectedCases) {
    run();
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      run();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p90Ms = Number(samples[Math.ceil(runs * 0.9) - 1].toFixed(2));
    results.push({
      case: name,
      medianMs: Number(samples[Math.floor(runs / 2)].toFixed(2)),
      p90Ms,
      maxMs: Number(samples[runs - 1].toFixed(2)),
      limitMs: limitsMs[name] ?? null,
      passed: checkMode ? p90Ms <= limitsMs[name] : undefined,
    });
  }
  console.table(results);
  if (checkMode) {
    const failures = results.filter((result) => !result.passed);
    if (failures.length > 0) {
      console.error(
        `Performance regression gate failed: ${failures.map((result) => `${result.case} p90 ${result.p90Ms} ms > ${result.limitMs} ms`).join("; ")}`,
      );
      process.exitCode = 1;
    } else {
      console.log(`Performance regression gate passed (${sessionCount} synthetic sessions, p90 of ${runs} runs).`);
    }
  }
  benchStore.close();
} finally {
  try {
    store.close();
  } catch {
    // Already closed after seeding.
  }
  rmSync(root, { recursive: true, force: true });
}
