// Synthetic read-path benchmark for WorkIntelligenceStore.
//
// Usage:
//   pnpm --filter @work-intelligence/storage build
//   node packages/storage/bench/read-paths.bench.mjs [sessionCount]
//
// Seeding thousands of Sessions is slow, so set WI_BENCH_CACHE=<path prefix> to keep the
// seeded SQLite file and reuse it on the next run (for before/after comparisons).
import console from "node:console";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { LATEST_SCHEMA_VERSION, toSessionDigests, WorkIntelligenceStore } from "../dist/index.js";
import { evaluateRecallQuestions, parseRecallEvaluationQuestions } from "../../../apps/mcp/dist/recall-evaluation.js";

import {
  getMcpRuntimeDirectory,
  getMcpRuntimeStatus,
  readMcpBuildIdentity,
  registerMcpProcess,
} from "../../shared/dist/mcp-runtime.js";

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

function seedOutstandingItems(targetStore, projectIds) {
  const database = new DatabaseSync(targetStore.databasePath);
  try {
    const sessions = database
      .prepare("SELECT id, project_id, created_at FROM sessions WHERE project_id IN (?, ?) ORDER BY id")
      .all(...projectIds);
    const insertItem = database.prepare(
      `INSERT OR IGNORE INTO outstanding_items
       (id, source_session_id, project_id, position, text, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, 'pending', ?, ?)`,
    );
    const insertEvent = database.prepare(
      `INSERT OR IGNORE INTO outstanding_item_events
       (id, item_id, project_id, from_status, to_status, source, actor_session_id, created_at)
       VALUES (?, ?, ?, NULL, 'pending', 'migration', NULL, ?)`,
    );
    sessions.forEach((session, index) => {
      if (index % 5 !== 0) return;
      const id = `benchmark-outstanding-${index}`;
      const createdAt = String(session.created_at);
      insertItem.run(id, session.id, session.project_id, `Synthetic pending item ${index}`, createdAt, createdAt);
      insertEvent.run(`benchmark-outstanding-event-${index}`, id, session.project_id, createdAt);
    });
  } finally {
    database.close();
  }
}

function seedOutstandingCleanupReview(targetStore, project) {
  const database = new DatabaseSync(targetStore.databasePath);
  try {
    const insertRequest = database.prepare(
      `INSERT INTO outstanding_cleanup_requests
       (id, project_id, idempotency_key, status, requested_at, completed_at, item_count)
       VALUES (?, ?, ?, 'completed', ?, ?, 0)`,
    );
    for (let index = 0; index < 100; index += 1) {
      const at = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
      insertRequest.run(
        `benchmark-cleanup-history-${index}`,
        project.id,
        `benchmark-cleanup-history-key-${index}`,
        at,
        at,
      );
    }
  } finally {
    database.close();
  }

  const laterEvidence = targetStore.finalizeSession({
    projectRoot: project.rootPath,
    idempotencyKey: "benchmark-cleanup-later-evidence",
    title: "Synthetic later cleanup evidence",
    summary: "A finalized same-project Session used by the synthetic cleanup benchmark.",
    workSummary: {
      outcomes: [],
      scope: [],
      decisions: [],
      verification: ["Synthetic benchmark evidence."],
      nextSteps: [],
    },
    changedFiles: [],
    verification: { status: "passed", summary: "Synthetic benchmark evidence." },
  });
  if (laterEvidence.outcome !== "finalized") {
    throw new Error(`Could not finalize cleanup benchmark evidence: ${laterEvidence.outcome}`);
  }

  const created = targetStore.createOutstandingCleanupRequest({
    projectId: project.id,
    idempotencyKey: "benchmark-outstanding-cleanup-request",
  });
  if (created.outcome !== "outstanding_cleanup_request_created") {
    throw new Error(`Could not create cleanup benchmark request: ${created.outcome}`);
  }
  const pending = targetStore.listOutstandingItems({
    projectId: project.id,
    status: "pending",
    page: 1,
    pageSize: 100,
  });
  if (pending.outcome !== "outstanding_items" || pending.items.length === 0) {
    throw new Error("The cleanup benchmark needs at least one synthetic pending item.");
  }
  const submitted = targetStore.submitOutstandingCleanupProposals({
    requestId: created.request.id,
    idempotencyKey: "benchmark-outstanding-cleanup-submission",
    examinedItemIds: pending.items.map((item) => item.id),
    proposals: pending.items.map((item) => ({
      itemId: item.id,
      status: "completed",
      reason: "Synthetic benchmark proposal with same-project later evidence.",
      evidenceSessionIds: [laterEvidence.session.id],
    })),
  });
  if (submitted.outcome !== "outstanding_cleanup_proposals_submitted") {
    throw new Error(`Could not seed cleanup benchmark proposals: ${submitted.outcome}`);
  }
  return created.request.id;
}

function listSessionDigestPage(targetStore, projectId) {
  const result = targetStore.listSessionsPage({ projectId, trackedOnly: true, page: 1, pageSize: 100 });
  const pendingItems = targetStore.pendingOutstandingItemsForSessions(result.items.map(({ id }) => id));
  return { ...result, items: toSessionDigests(result.items, pendingItems) };
}

try {
  if (!cached) {
    seed();
    if (cachePath) {
      store.close();
      copyFileSync(databasePath, cachePath);
    }
  }
  const mcpRuntimeRoot = join(root, "synthetic-runtime");
  const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  mkdirSync(mcpRuntimeRoot);
  copyFileSync(join(repositoryRoot, "package.json"), join(mcpRuntimeRoot, "package.json"));
  for (const directory of [
    "apps/mcp/dist",
    "packages/core/dist",
    "packages/project-policy/dist",
    "packages/schema/dist",
    "packages/shared/dist",
    "packages/storage/dist",
  ]) {
    cpSync(join(repositoryRoot, directory), join(mcpRuntimeRoot, directory), { recursive: true });
  }
  const runtimeBuild = readMcpBuildIdentity(mcpRuntimeRoot);
  const runtimeDirectory = getMcpRuntimeDirectory(mcpRuntimeRoot);
  mkdirSync(runtimeDirectory, { recursive: true });
  const seedExpiredLeases = () => {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    for (let index = 0; index < 286; index += 1) {
      const instanceId = randomUUID();
      const path = join(runtimeDirectory, `${instanceId}.${index % 2 === 0 ? "json" : "tmp"}`);
      writeFileSync(path, JSON.stringify({ instanceId, heartbeatAt: old.toISOString(), buildId: "synthetic" }));
      utimesSync(path, old, old);
    }
  };
  const benchStore = cachePath && !cached ? new WorkIntelligenceStore(databasePath) : store;
  if (cached) {
    // Only the copied synthetic database is changed; cache roots belonged to a removed previous run.
    const projects = benchStore.listProjects();
    for (const [name, projectRoot] of [
      ["alpha", alphaRoot],
      ["beta", betaRoot],
    ]) {
      const project = projects.find((entry) => entry.name === name);
      if (!project) throw new Error(`Synthetic cache is missing project ${name}.`);
      benchStore.updateProjectLocation(project.id, projectRoot, true);
    }
  }
  const alpha = benchStore.listProjects().find((project) => project.name === "alpha");
  const beta = benchStore.listProjects().find((project) => project.name === "beta");
  let maintenanceFinalizeIndex = 0;
  const finalizeWithKnowledgePageMaintenance = () => {
    const index = ++maintenanceFinalizeIndex;
    const result = benchStore.finalizeSession({
      projectRoot: alphaRoot,
      idempotencyKey: `bench-page-maintenance-${index}`,
      title: `Synthetic maintenance Session ${index}`,
      summary: "Synthetic Session used to measure the knowledge-page maintenance reminder.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") {
      throw new Error(`Could not finalize the maintenance benchmark Session: ${result.outcome}`);
    }
    return result;
  };
  seedOutstandingItems(benchStore, [alpha.id, beta.id]);
  // Capture the original graph/recall fixture before cleanup adds an evidence Session with no changed files.
  const [newestAlpha] = benchStore.listSessionsPage({ projectId: alpha.id, page: 1, pageSize: 1 }).items;
  const cleanupRequestId = seedOutstandingCleanupReview(benchStore, alpha);
  seedStaleKnowledge(benchStore, alpha);
  seedKnowledgePages(benchStore, alpha);
  // A file of the newest original alpha Session, so the path search walks project → Session → file.
  const pathTarget = `file:${alpha.id}:${newestAlpha.changedFiles.at(-1)}`;
  const benchPath = benchStore.getGraphPath({ projectId: alpha.id, from: `project:${alpha.id}`, to: pathTarget });
  if (benchPath.outcome !== "graph_path" || !benchPath.found) {
    throw new Error("The graph path benchmark must measure a path that exists.");
  }
  benchStore.finalizeSession({
    projectRoot: alphaRoot,
    idempotencyKey: "bench-verification-progress",
    title: "Synthetic verification progress",
    summary: "Completed synthetic checkpoint with an unfinished verification.",
    completedAt: "2026-03-11T12:00:00.000Z",
    changedFiles: [],
    verification: { status: "in_progress" },
  });
  const architectureSession = benchStore.finalizeSession({
    projectRoot: alphaRoot,
    idempotencyKey: "bench-architecture",
    title: "Synthetic architecture",
    summary: "Bounded diagram snapshot",
    changedFiles: [],
    verification: { status: "passed" },
    diagrams: [
      {
        title: "200 synthetic nodes",
        kind: "architecture",
        formatVersion: 1,
        source: JSON.stringify({
          version: 1,
          nodes: Array.from({ length: 200 }, (_, index) => ({
            id: `n${index}`,
            label: `Node ${index}`,
            description: "Synthetic architecture source",
          })),
          edges: Array.from({ length: 199 }, (_, index) => ({
            id: `e${index}`,
            from: `n${index}`,
            to: `n${index + 1}`,
          })),
        }),
      },
    ],
  });
  if (architectureSession.outcome !== "finalized") throw new Error("Expected the synthetic architecture Session.");
  const evaluationQuestions = parseRecallEvaluationQuestions([
    {
      id: "read-path-benchmark-recall",
      mode: "recall",
      query: "report pipeline",
      projectRoot: alpha.rootPath,
      expectedIds: [newestAlpha.id],
    },
    {
      id: "read-path-benchmark-context",
      mode: "context",
      query: "report pipeline",
      projectRoot: alpha.rootPath,
      expectedIds: [newestAlpha.id],
    },
  ]);

  const cases = {
    "getSessionDetail (200 architecture nodes)": () => {
      const result = benchStore.getSessionDetail(architectureSession.session.id);
      if (!result?.diagrams.length) throw new Error("Expected a complete architecture snapshot.");
      return result;
    },
    "listSessionsPage (default)": () => benchStore.listSessionsPage({ page: 1, pageSize: 20 }),
    "listSessionsPage (page 50)": () => benchStore.listSessionsPage({ page: 50, pageSize: 20 }),
    "listSessionsPage (date range)": () =>
      benchStore.listSessionsPage({ from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (project + range)": () =>
      benchStore.listSessionsPage({ projectId: beta.id, from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (query)": () => benchStore.listSessionsPage({ query: "graph", page: 1, pageSize: 20 }),
    "listSessionDigests (page 100 + pending items)": () => listSessionDigestPage(benchStore, alpha.id),
    getDashboardSummary: () => benchStore.getDashboardSummary(),
    "getReport week": () => benchStore.getReport({ period: "week", date: "2026-03-11" }),
    "getReport (in-progress verification)": () => {
      const result = benchStore.getReport({ period: "week", date: "2026-03-11", projectId: alpha.id });
      if (
        result.outcome !== "report" ||
        result.totals.verification.in_progress !== 1 ||
        !result.risks.some((risk) => risk.label === "Verification 進行中")
      )
        throw new Error("Progress report benchmark must preserve its unconfirmed result.");
      return result;
    },
    "getReport month": () => benchStore.getReport({ period: "month", date: "2026-03-11" }),
    "getReport year": () => benchStore.getReport({ period: "year", date: "2026-03-11" }),
    getContext: () => benchStore.getContext(),
    "getContext (project with pages)": () => benchStore.getContext(alphaRoot),
    "getContext (related pending items)": () => {
      const result = benchStore.getContext(alphaRoot, {
        task: "report pipeline synthetic pending",
        paths: ["src/module-0.ts"],
      });
      if (result.outcome !== "context" || !result.relevant?.outstandingItems?.items.length)
        throw new Error("Related context benchmark must return pending pointers.");
      return result;
    },
    "finalizeSession (related pending reminder)": () => {
      const index = ++maintenanceFinalizeIndex;
      const result = benchStore.finalizeSession({
        projectRoot: alphaRoot,
        idempotencyKey: `bench-outstanding-finalize-${index}`,
        title: `Synthetic pending report pipeline ${index}`,
        summary: "Verified report pipeline work with related older pending items.",
        changedFiles: ["src/module-0.ts"],
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      });
      if (result.outcome !== "finalized" || !result.relatedOutstandingItems?.items.length)
        throw new Error("Related finalize benchmark must return pending pointers.");
      return result;
    },
    "listKnowledgePages (staleness)": () => benchStore.listKnowledgePages({}),
    "finalizeSession (knowledge page reminder)": finalizeWithKnowledgePageMaintenance,
    "MCP guarded finalize (schema check)": () =>
      benchStore.withCompatibleSchema(LATEST_SCHEMA_VERSION, finalizeWithKnowledgePageMaintenance),
    "getMcpRuntimeStatus (cached identity)": () => getMcpRuntimeStatus(mcpRuntimeRoot),
    "getMcpRuntimeStatus (286 expired leases)": () => getMcpRuntimeStatus(mcpRuntimeRoot),
    "registerMcpProcess (286 expired leases)": () => registerMcpProcess(mcpRuntimeRoot, runtimeBuild)(),
    "getKnowledgePageContext (review)": () =>
      benchStore.getKnowledgePageContext({ projectRoot: alphaRoot, slug: "pitfalls" }),
    "listSessionDecisions (pending)": () => benchStore.listSessionDecisions({ status: "pending", limit: 50 }),
    "listOutstandingItems (pending)": () =>
      benchStore.listOutstandingItems({ projectId: alpha.id, status: "pending", page: 1, pageSize: 20 }),
    "listOutstandingItems (source date range)": () =>
      benchStore.listOutstandingItems({
        projectId: alpha.id,
        status: "pending",
        from: "2026-03-01",
        to: "2026-03-31",
        page: 1,
        pageSize: 20,
      }),
    "listOutstandingCleanupRequests (page 5)": () => {
      const result = benchStore.listOutstandingCleanupRequests({ projectId: alpha.id, page: 1, pageSize: 5 });
      if (result.outcome !== "outstanding_cleanup_requests" || result.requests.length === 0) {
        throw new Error("Cleanup request benchmark must return synthetic tracked-project rows.");
      }
      return result;
    },
    "getOutstandingCleanupContext (5 items + 10 Sessions)": () => {
      const result = benchStore.getOutstandingCleanupContext({
        requestId: cleanupRequestId,
        itemPage: 1,
        itemPageSize: 5,
        sessionPage: 1,
        sessionPageSize: 10,
      });
      if (
        result.outcome !== "outstanding_cleanup_context" ||
        result.items.length === 0 ||
        result.sessions.length === 0
      ) {
        throw new Error("Cleanup context benchmark must return synthetic items and later Session pointers.");
      }
      return result;
    },
    "listOutstandingCleanupProposals (page 100)": () => {
      const result = benchStore.listOutstandingCleanupProposals({
        requestId: cleanupRequestId,
        page: 1,
        pageSize: 100,
      });
      if (result.outcome !== "outstanding_cleanup_proposals" || result.proposals.length === 0) {
        throw new Error("Cleanup proposal benchmark must return synthetic proposals.");
      }
      return result;
    },
    search: () => benchStore.search("renderer"),
    "recall (month range)": () =>
      benchStore.recall({ q: "report pipeline", from: "2026-03-01", to: "2026-03-31", limit: 8 }),
    "recall (synonym expansion)": () => benchStore.recall({ q: "endpoint performance", limit: 8 }),
    "recall evaluator (snapshot + MCP recall/context)": () =>
      evaluateRecallQuestions(databasePath, evaluationQuestions),
    "searchKnowledge (staleness)": () => benchStore.searchKnowledge({ projectRoot: alphaRoot, limit: 20 }),
    previewMetadataBackfill: () => benchStore.previewMetadataBackfill({}),
    getGraph: () => benchStore.getGraph({}),
    "getGraph (with derived)": () => benchStore.getGraph({ includeDerived: true }),
    "getGraphPath (500 nodes)": () =>
      benchStore.getGraphPath({ projectId: alpha.id, from: `project:${alpha.id}`, to: pathTarget }),
    "getTimeline (month)": () => benchStore.getTimeline({ from: "2026-03-01", to: "2026-03-31" }),
    "getTimeline (year)": () => benchStore.getTimeline({ from: "2025-10-01", to: "2026-09-30" }),
    "getActivity (year)": () => benchStore.getActivity({ from: "2025-10-01", to: "2026-09-30" }),
    "getHotspots (files)": () => benchStore.getHotspots({ limit: 20 }),
    "getHotspots (directories, month)": () =>
      benchStore.getHotspots({ groupBy: "directory", from: "2026-03-01", to: "2026-03-31", limit: 20 }),
  };

  const limitsMs = {
    "getSessionDetail (200 architecture nodes)": 250,
    "listSessionsPage (default)": 200,
    "listSessionDigests (page 100 + pending items)": 100,
    getDashboardSummary: 1000,
    "getReport week": 750,
    "getReport (in-progress verification)": 750,
    "getReport year": 1500,
    getContext: 2500,
    "getContext (project with pages)": 500,
    "getContext (related pending items)": 500,
    "finalizeSession (related pending reminder)": 250,
    "listKnowledgePages (staleness)": 250,
    "finalizeSession (knowledge page reminder)": 250,
    "MCP guarded finalize (schema check)": 250,
    "getMcpRuntimeStatus (cached identity)": 50,
    "getMcpRuntimeStatus (286 expired leases)": 100,
    "registerMcpProcess (286 expired leases)": 100,
    "getKnowledgePageContext (review)": 250,
    "listSessionDecisions (pending)": 250,
    "listOutstandingItems (pending)": 250,
    "listOutstandingItems (source date range)": 250,
    "listOutstandingCleanupRequests (page 5)": 250,
    "getOutstandingCleanupContext (5 items + 10 Sessions)": 250,
    "listOutstandingCleanupProposals (page 100)": 250,
    search: 500,
    "recall (month range)": 500,
    "recall (synonym expansion)": 500,
    "recall evaluator (snapshot + MCP recall/context)": 1000,
    "getGraph (with derived)": 750,
    "getGraphPath (500 nodes)": 750,
    "getTimeline (month)": 250,
    "getTimeline (year)": 750,
    "getActivity (year)": 250,
    "getHotspots (files)": 500,
    "getHotspots (directories, month)": 500,
    "searchKnowledge (staleness)": 500,
  };

  const results = [];
  const selectedCases = Object.entries(cases).filter(([name]) => !checkMode || name in limitsMs);
  for (const [name, run] of selectedCases) {
    if (name.includes("286 expired leases")) seedExpiredLeases();
    await run();
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      if (name.includes("286 expired leases")) seedExpiredLeases();
      const started = performance.now();
      await run();
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
  rmSync(getMcpRuntimeDirectory(join(root, "synthetic-runtime")), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
