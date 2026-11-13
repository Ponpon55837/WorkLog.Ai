// Synthetic read-path benchmark for WorkIntelligenceStore.
//
// Usage:
//   pnpm --filter @work-intelligence/storage build
//   node packages/storage/bench/read-paths.bench.mjs [sessionCount]
//   node packages/storage/bench/read-paths.bench.mjs 5000 --check --case=finalize-related-reminder
//   node packages/storage/bench/read-paths.bench.mjs 5000 --check --backup-worker-only --backup-worker-mode=sync|worker
//
// Seeding thousands of Sessions is slow, so set WI_BENCH_CACHE=<path prefix> to keep the
// seeded SQLite file and reuse it on the next run (for before/after comparisons).
import console from "node:console";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const sessionCountArgument = args.find((argument) => !argument.startsWith("--"));
const sessionCount = Number(sessionCountArgument ?? 5000);
const checkMode = args.includes("--check");
const backupWorkerOnly = args.includes("--backup-worker-only");
const caseArgument = args.find((argument) => argument.startsWith("--case="));
const caseFilter = caseArgument?.slice("--case=".length);
const benchmarkCaseFilter =
  caseFilter === "finalize-related-reminder" ? "finalizeSession (related pending reminder)" : caseFilter;
const backupWorkerModeArgument = args.find((argument) => argument.startsWith("--backup-worker-mode="));
const backupWorkerMode = backupWorkerModeArgument?.slice("--backup-worker-mode=".length) ?? "worker";
if (!Number.isSafeInteger(sessionCount) || sessionCount < 1) {
  throw new Error("Session count must be a positive safe integer.");
}
if (backupWorkerMode !== "worker" && backupWorkerMode !== "sync") {
  throw new Error("Backup worker benchmark mode must be 'worker' or 'sync'.");
}
const repositoryRoot = resolve(
  process.env.WI_BACKUP_BENCH_BUILD_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url)),
);
const [
  { LATEST_SCHEMA_VERSION, toAgentReportContext, toSessionDigests, WorkIntelligenceStore },
  recallEvaluation,
  mcpRuntime,
  { appliesToEntries, appliesToStrength, compileAppliesTo, createAppliesToBudget },
  { findKnowledgeCandidateOverlaps },
  { findKnowledgeToReview },
] = await Promise.all([
  import(pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "index.js")).href),
  import(pathToFileURL(join(repositoryRoot, "apps", "mcp", "dist", "recall-evaluation.js")).href),
  import(pathToFileURL(join(repositoryRoot, "packages", "shared", "dist", "mcp-runtime.js")).href),
  import(pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "applies-to-match.js")).href),
  import(pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "knowledge-candidate-overlap.js")).href),
  import(pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "knowledge-review-hint.js")).href),
]);
const { evaluateRecallQuestions, parseRecallEvaluationQuestions } = recallEvaluation;
const { getMcpRuntimeDirectory, getMcpRuntimeStatus, readMcpBuildIdentity, registerMcpProcess } = mcpRuntime;
const runs = 15;
const backupWorkerBenchIdleTimeoutMs = 15_000;
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
let closeBenchmarkApi = async () => {};
let benchmarkApiClosed = false;

const heavyApiClientScript = `
import { request } from "node:http";
import { performance } from "node:perf_hooks";
const [baseUrl, path, sessionCountArgument, healthArgument] = process.argv.slice(1);
const sessionCount = Number(sessionCountArgument);
const collectHealth = healthArgument === "health";
const bodyChunks = [];
for await (const chunk of process.stdin) bodyChunks.push(Buffer.from(chunk));
const body = Buffer.concat(bodyChunks);
const operationStarted = performance.now();
const operationPromise = new Promise((resolve, reject) => {
  const operation = request(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.once("error", reject);
    response.once("end", () => {
      const content = Buffer.concat(chunks);
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        reject(new Error("Heavy API request failed: " + response.statusCode + " " + content.toString("utf8")));
        return;
      }
      if (path === "/api/backups") {
        const result = JSON.parse(content.toString("utf8"));
        if (result.outcome !== "database_backups" || !result.created?.bytes) {
          reject(new Error("Expected a written backup."));
          return;
        }
      } else if (path === "/api/export" && body.toString("utf8").includes("scope")) {
        const result = JSON.parse(content.toString("utf8"));
        if (!Array.isArray(result.tables?.sessions) || result.tables.sessions.length < sessionCount) {
          reject(new Error("Expected every synthetic Session exported."));
          return;
        }
      } else if (path === "/api/import/preview") {
        const result = JSON.parse(content.toString("utf8"));
        if (result.outcome !== "project_data_import_preview" || (result.skipped?.sessions ?? 0) < sessionCount) {
          reject(new Error("Expected every synthetic Session previewed as already present."));
          return;
        }
      } else if (path === "/api/import") {
        const result = JSON.parse(content.toString("utf8"));
        if (
          result.outcome !== "project_data_imported" ||
          (result.skipped?.sessions ?? 0) < sessionCount ||
          result.changed !== false ||
          result.backupFileName !== undefined
        ) {
          // Since 1.6.30 an import that changes nothing writes no pre-import snapshot.
          reject(new Error("Expected every synthetic Session skipped, with no change and no pre-import backup."));
          return;
        }
      } else if (path === "/api/export" && content.byteLength === 0) {
        reject(new Error("Expected a written database export."));
        return;
      }
      resolve({ status: response.statusCode, bytes: content.byteLength });
    });
  });
  operation.once("error", (error) => {
    reject(error);
  });
  operation.end(body);
});
const healthSamples = [];
let operationComplete = false;
let healthMonitor = Promise.resolve();
if (collectHealth) {
  let nextProbeAt = performance.now();
  healthMonitor = (async () => {
    while (!operationComplete) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextProbeAt - performance.now())));
      if (operationComplete) break;
      const scheduledAt = nextProbeAt;
      const response = await fetch(new URL("/api/health", baseUrl));
      await response.arrayBuffer();
      if (!response.ok) throw new Error("Health request failed: " + response.status);
      healthSamples.push(performance.now() - scheduledAt);
      nextProbeAt = Math.max(scheduledAt + 10, performance.now() + 10);
    }
  })();
}
const [operationResult] = await Promise.allSettled([operationPromise]);
operationComplete = true;
const [healthResult] = await Promise.allSettled([healthMonitor]);
if (healthResult.status === "rejected") throw healthResult.reason;
if (operationResult.status === "rejected") throw operationResult.reason;
const operation = operationResult.value;
healthSamples.sort((left, right) => left - right);
const healthP90Ms = healthSamples[Math.ceil(healthSamples.length * 0.9) - 1] ?? 0;
const healthMaxMs = healthSamples.at(-1) ?? 0;
process.stdout.write(JSON.stringify({
  ...(collectHealth ? { healthP90Ms, healthMaxMs, healthProbeCount: healthSamples.length } : {}),
  operationMs: performance.now() - operationStarted,
  ...operation,
}));
`;

function runHeavyApiClient(baseUrl, path, body, targetSessionCount, probeHealth = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        heavyApiClientScript,
        baseUrl,
        path,
        String(targetSessionCount),
        probeHealth ? "health" : "operation",
      ],
      {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        reject(new Error(`Heavy API client failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(new Error(`Heavy API client returned invalid output: ${output}`, { cause: error }));
      }
    });
    child.stdin.once("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(body);
  });
}

async function measureProcessResources(run) {
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const rssBefore = process.memoryUsage.rss();
  let rssPeak = rssBefore;
  const rssTimer = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
  }, 10);
  eventLoop.enable();
  let value;
  try {
    value = await run();
  } finally {
    clearInterval(rssTimer);
    eventLoop.disable();
  }
  const rssAfter = process.memoryUsage.rss();
  rssPeak = Math.max(rssPeak, rssAfter);
  const toMs = (nanoseconds) => (Number.isFinite(nanoseconds) ? Number((nanoseconds / 1e6).toFixed(2)) : 0);
  const toMb = (bytes) => Number((bytes / 1024 / 1024).toFixed(1));
  return {
    value,
    eventLoopP90Ms: toMs(eventLoop.percentile(90)),
    eventLoopMaxMs: toMs(eventLoop.max),
    rssBeforeMb: toMb(rssBefore),
    rssPeakMb: toMb(rssPeak),
    rssAfterMb: toMb(rssAfter),
  };
}

function observeWriteTransactionDurations(targetStore) {
  const database = targetStore.db;
  const originalExec = database.exec;
  const samples = [];
  let transactionStartedAt;
  database.exec = function (statement) {
    const normalized = statement.trim().toUpperCase();
    const result = originalExec.call(database, statement);
    if (normalized === "BEGIN IMMEDIATE") transactionStartedAt = performance.now();
    if (normalized === "COMMIT" && transactionStartedAt !== undefined) {
      samples.push(performance.now() - transactionStartedAt);
      transactionStartedAt = undefined;
    }
    if (normalized === "ROLLBACK") transactionStartedAt = undefined;
    return result;
  };
  return {
    samples,
    restore() {
      database.exec = originalExec;
    },
  };
}

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
  const candidateByProject = new Map();
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
      const term = `candidatekey${index}x`;
      insertItem.run(id, session.id, session.project_id, `Synthetic pending ${term}`, createdAt, createdAt);
      insertEvent.run(`benchmark-outstanding-event-${index}`, id, session.project_id, createdAt);
      if (!candidateByProject.has(session.project_id)) candidateByProject.set(session.project_id, { id, term });
    });
  } finally {
    database.close();
  }
  return candidateByProject;
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

/**
 * Separate databases at the stored-text limits of the 1.6.27 review, so the worst cases never touch benchStore: 200
 * Knowledge rows with 30 appliesTo entries of 1,000 characters (the list search, linear in rows: x10 for 2,000), 200 Knowledge items with the same
 * appliesTo and 5,000 later Sessions of 20 x 100-character files (finalize knowledgeToReview), and a Knowledge read
 * whose staleness check meets the same 5,000 Sessions. Rows are copied in SQL; only the first goes through the store.
 */
function seedStoredTextWorstCases(baseRoot) {
  const worstRoot = join(baseRoot, "worst-text");
  const listRoot = join(baseRoot, "worst-list");
  mkdirSync(worstRoot, { recursive: true });
  mkdirSync(listRoot, { recursive: true });
  const path = join(baseRoot, "worst-text.sqlite");
  const worstStore = new WorkIntelligenceStore(path);
  // The list rows live in a project of their own, so the review and staleness cases never read them.
  const project = worstStore.addProject("worst-text", worstRoot);
  worstStore.updateProject(project.id, { status: "tracked" });
  worstStore.updateProject(worstStore.addProject("worst-list", listRoot).id, { status: "tracked" });
  const record = (key, appliesTo, kind = "gotcha", projectRoot = worstRoot) => {
    const recorded = worstStore.recordKnowledge({
      projectRoot,
      idempotencyKey: key,
      kind,
      title: `Synthetic worst-case rule ${key}`,
      body: "Synthetic body.",
      appliesTo,
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error(`Could not seed ${key}`);
    return recorded.knowledge.id;
  };
  const finalize = (key, changedFiles, completedAt) => {
    const result = worstStore.finalizeSession({
      projectRoot: worstRoot,
      idempotencyKey: key,
      title: `Synthetic worst-case Session ${key}`,
      summary: "Synthetic.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status: "passed" },
      completedAt,
    });
    if (result.outcome !== "finalized") throw new Error(`Could not seed ${key}`);
    return result.session;
  };
  record("list-0", [], "gotcha", listRoot);
  for (let index = 0; index < 200; index += 1) record(`review-${index}`, ["src/shared/lease.ts"]);
  record("stale", ["src/stale/target.ts"], "decision");
  finalize("touch", ["src/shared/lease.ts"], "2026-01-02T00:00:00.000Z");
  finalize("template", ["src/x.ts"], "2026-01-03T00:00:00.000Z");
  worstStore.close();
  const database = new DatabaseSync(path);
  try {
    database
      .prepare("UPDATE knowledge SET created_at = ?, updated_at = ?")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const appliesTo = JSON.stringify(
      Array.from({ length: 30 }, (_, entry) =>
        entry === 29 ? `${"a".repeat(992)}bbbbbbbb` : `${entry}${"a".repeat(999)}`,
      ),
    );
    database.prepare("UPDATE knowledge SET applies_to_json = ? WHERE idempotency_key = 'list-0'").run(appliesTo);
    const copyRows = (table, key, count, change) => {
      const row = database.prepare(`SELECT * FROM ${table} WHERE idempotency_key = ?`).get(key);
      const columns = Object.keys(row);
      const insert = database.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      database.exec("BEGIN");
      for (let index = 0; index < count; index += 1) {
        const copy = { ...row, ...change(index) };
        insert.run(...columns.map((column) => copy[column]));
      }
      database.exec("COMMIT");
    };
    copyRows("knowledge", "list-0", 199, (index) => ({
      id: `list-${index + 1}`,
      idempotency_key: `list-${index + 1}`,
    }));
    // 5,000 later Sessions of 20 files of about 100 characters: no file contains the review fragment (the oldest
    // Session touches every candidate), and the staleness check cannot afford to parse them all.
    copyRows("sessions", "template", 5_000, (index) => ({
      id: `later-${index}`,
      idempotency_key: `later-${index}`,
      completed_at: new Date(Date.parse("2026-01-04T00:00:00.000Z") + index * 1_000).toISOString(),
      changed_files_json: JSON.stringify(
        Array.from({ length: 20 }, (_, file) => `src/other/${index}/${file}/${"z".repeat(80)}.ts`),
      ),
    }));
  } finally {
    database.close();
  }
  const reopened = new WorkIntelligenceStore(path);
  const focus = (() => {
    const session = reopened.finalizeSession({
      projectRoot: worstRoot,
      idempotencyKey: "focus",
      title: "Synthetic focus",
      summary: "Synthetic.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/shared/lease.ts"],
      verification: { status: "passed" },
      completedAt: "2026-06-01T00:00:00.000Z",
    });
    if (session.outcome !== "finalized") throw new Error("Could not seed the focus Session.");
    return {
      projectId: project.id,
      sessionId: session.session.id,
      completedAt: session.session.completedAt,
      changedFiles: ["src/shared/lease.ts"],
      project: { name: "worst-text", rootPath: worstRoot },
    };
  })();
  const nearMiss = Array.from({ length: 8 }, (_, index) => `${"a".repeat(199 - index)}${"b".repeat(index + 1)}`).join(
    " ",
  );
  return { store: reopened, path, root: worstRoot, listRoot, focus, nearMiss };
}

/**
 * The staleness shapes of the 1.6.27 gate review, in a database of their own: 2,000 later Sessions of 50 distinct
 * paths of about 100 characters with 200 Knowledge items of five appliesTo entries (two one-star globs), where 1.6.27
 * compared every entry with every path (2.9 s for a page of 20 here, 1.0 s in 1.6.14); and, in a second project, 20
 * Knowledge items whose 15-star glob every path of 10 Sessions x 200 x 1,000 characters is a candidate for, which must
 * stop at the match ceiling and mark them unchecked. Sessions are copied in SQL from one finalized template.
 */
function seedDistinctPathStaleness(baseRoot) {
  const distinctRoot = join(baseRoot, "distinct-paths");
  const starRoot = join(baseRoot, "star-glob");
  mkdirSync(distinctRoot, { recursive: true });
  mkdirSync(starRoot, { recursive: true });
  const path = join(baseRoot, "distinct-paths.sqlite");
  const seedStore = new WorkIntelligenceStore(path);
  const projects = [distinctRoot, starRoot].map((projectRoot, index) => {
    const project = seedStore.addProject(index === 0 ? "distinct-paths" : "star-glob", projectRoot);
    seedStore.updateProject(project.id, { status: "tracked" });
    return project;
  });
  const record = (projectRoot, key, appliesTo) => {
    const recorded = seedStore.recordKnowledge({
      projectRoot,
      idempotencyKey: key,
      kind: "gotcha",
      title: `Synthetic staleness rule ${key}`,
      body: "Synthetic body.",
      appliesTo,
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error(`Could not seed ${key}`);
  };
  for (let index = 0; index < 200; index += 1) {
    record(distinctRoot, `distinct-${index}`, [
      `src/m${index}/*.ts`,
      index % 3 === 0 ? `src/d${index * 7}/*.ts` : `docs/g${index}/*.md`,
      `src/zz${index}.ts`,
      `packages/p${index}/index.ts`,
      index % 5 === 0 ? `src/d${index * 3}` : `lib/q${index}`,
    ]);
  }
  for (let index = 0; index < 20; index += 1) record(starRoot, `star-${index}`, ["*a".repeat(15)]);
  for (const [index, projectRoot] of [distinctRoot, starRoot].entries()) {
    const template = seedStore.finalizeSession({
      projectRoot,
      idempotencyKey: `template-${index}`,
      title: "Synthetic template",
      summary: "Synthetic.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/x.ts"],
      verification: { status: "passed" },
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    if (template.outcome !== "finalized") throw new Error("Could not seed the staleness template.");
  }
  seedStore.close();
  const database = new DatabaseSync(path);
  try {
    database
      .prepare("UPDATE knowledge SET created_at = ?, updated_at = ?")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const copies = [
      [
        "template-0",
        projects[0].id,
        2_000,
        (session) => Array.from({ length: 50 }, (_, file) => `src/d${session}/${"f".repeat(85)}${file}.ts`),
      ],
      [
        "template-1",
        projects[1].id,
        10,
        (session) => Array.from({ length: 200 }, (_, file) => `${session}-${file}-${"a".repeat(990)}`),
      ],
    ];
    database.exec("BEGIN");
    for (const [key, projectId, count, files] of copies) {
      const row = database.prepare("SELECT * FROM sessions WHERE idempotency_key = ?").get(key);
      const columns = Object.keys(row);
      const insert = database.prepare(
        `INSERT INTO sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (let index = 0; index < count; index += 1) {
        const copy = {
          ...row,
          id: `${key}-${index}`,
          idempotency_key: `${key}-${index}`,
          project_id: projectId,
          completed_at: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1_000).toISOString(),
          changed_files_json: JSON.stringify(files(index)),
        };
        insert.run(...columns.map((column) => copy[column]));
      }
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  return { store: new WorkIntelligenceStore(path), distinctRoot, starRoot };
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
  const freshReviewKnowledge = { id: "", path: "" };
  let freshReviewIndex = 0;
  // Untimed: Knowledge recorded before every synthetic Session and never touched since.
  const seedFreshReviewKnowledge = () => {
    freshReviewIndex += 1;
    freshReviewKnowledge.path = `src/fresh-review-${freshReviewIndex}.ts`;
    const recorded = benchStore.recordKnowledge({
      projectRoot: alphaRoot,
      idempotencyKey: `bench-fresh-review-${freshReviewIndex}`,
      kind: "gotcha",
      title: `Synthetic fresh review rule ${freshReviewIndex}`,
      body: "Synthetic Knowledge that a benchmark finalize puts in doubt for the first time.",
      appliesTo: [freshReviewKnowledge.path],
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Could not seed the fresh review Knowledge.");
    freshReviewKnowledge.id = recorded.knowledge.id;
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare("UPDATE knowledge SET created_at = ?, updated_at = ? WHERE id = ?")
        .run("2025-09-01T00:00:00.000Z", "2025-09-01T00:00:00.000Z", recorded.knowledge.id);
    } finally {
      database.close();
    }
  };
  const outstandingCandidates = seedOutstandingItems(benchStore, [alpha.id, beta.id]);
  const finalizeReminderCandidate = outstandingCandidates.get(alpha.id);
  if (!finalizeReminderCandidate) throw new Error("Expected a synthetic finalize reminder candidate.");
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
  const architectureDetail = benchStore.getSessionDetailForAgent({ sessionId: architectureSession.session.id });
  if (architectureDetail.outcome !== "session_detail") throw new Error("Expected the architecture Session detail.");
  const architectureRevision = architectureDetail.session.revision;
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

  const presentationRequest = benchStore.createReportSynthesisRequest({
    period: "year",
    date: "2026-03-11",
    projectId: alpha.id,
  });
  if (presentationRequest.outcome !== "report_synthesis_request") throw new Error("Missing presentation request");
  benchStore.getReportSynthesisContext({ requestId: presentationRequest.request.id });
  const presentationBase = benchStore.saveReportSummary({
    requestId: presentationRequest.request.id,
    title: "Synthetic presentation",
    executiveSummary: "Synthetic immutable base.",
    highlights: [{ title: "Synthetic outcome", detail: "Synthetic evidence.", sourceSessionIds: [newestAlpha.id] }],
    risks: [],
    decisions: [],
    nextSteps: [],
    sourceSessionIds: [newestAlpha.id],
    generatedByAgent: "benchmark",
    promptVersion: "benchmark-v1",
  });
  if (presentationBase.outcome !== "report_summary_saved") throw new Error("Missing presentation base");
  benchStore.updateReportPresentation({
    summaryId: presentationBase.summary.id,
    expectedRevision: 0,
    state: { pinned: ["highlights"], hidden: [], overrides: [] },
  });

  const reminder = benchStore.getAttention({ projectId: alpha.id, kind: "outstanding" });
  if (reminder.outcome !== "attention" || !reminder.items.length)
    throw new Error("Missing preference benchmark source");
  const pointer = reminder.items[0];
  benchStore.updateAttentionPreference({
    projectId: alpha.id,
    kind: pointer.kind,
    sourceId: pointer.sourceId,
    sourceRevision: pointer.sourceRevision,
    expectedRevision: pointer.preference.revision,
    action: "hide",
  });

  const pendingLargeReport = benchStore.createReportSynthesisRequest({
    period: "year",
    date: "2026-03-11",
    projectId: alpha.id,
  });
  if (pendingLargeReport.outcome !== "report_synthesis_request") throw new Error("Missing pending source request");
  const metadataFollowUpPreview = benchStore.previewMetadataBackfill({ limit: 1 });
  if (metadataFollowUpPreview.outcome !== "backfill_preview")
    throw new Error("Missing metadata follow-up benchmark source");
  const expectedMetadataFollowUpTotals = metadataFollowUpPreview.totals;
  // db:maintain runs ANALYZE; measure the year report on a snapshot with planner statistics, because the
  // statistics once flipped the decision queries to a full Session scan (4.6-8 ms became 43-130 ms).
  const analyzedPath = join(root, "bench-analyzed.sqlite");
  const snapshot = new DatabaseSync(databasePath);
  try {
    snapshot.exec(`VACUUM INTO '${analyzedPath.replaceAll("'", "''")}'`);
  } finally {
    snapshot.close();
  }
  const analyzedDatabase = new DatabaseSync(analyzedPath);
  try {
    analyzedDatabase.exec("ANALYZE;");
  } finally {
    analyzedDatabase.close();
  }
  const analyzedStore = new WorkIntelligenceStore(analyzedPath);
  // A second connection writes like another process (the REST server and MCP servers share the file).
  const withBenchConnection = (path, operation) => {
    const connection = new DatabaseSync(path);
    try {
      connection.exec("PRAGMA busy_timeout = 5000");
      operation(connection);
    } finally {
      connection.close();
    }
  };
  // One project-data write moves the data revision, so the next follow-up count is a cache miss.
  const touchProjectData = () =>
    withBenchConnection(databasePath, (connection) =>
      connection.prepare("UPDATE projects SET updated_at = updated_at WHERE id = ?").run(alpha.id),
    );
  // Queried paths also match Knowledge appliesTo: the 20 seeded Knowledge records are linked to files only that way
  // (an exact module path and a glob), so the bounded appliesTo scan and the trust batch both do real work.
  const recallPathsAppliesTo = () => {
    const result = benchStore.recall({
      paths: ["src/module-3.ts", "src/feature-7/index.ts"],
      projectRoot: alphaRoot,
      limit: 8,
    });
    if (result.outcome !== "recall" || !result.hits.some((hit) => hit.type === "knowledge"))
      throw new Error("Path recall must return appliesTo-matched Knowledge.");
    return result;
  };
  const getContextPathsAppliesTo = () => {
    const result = benchStore.getContext(alphaRoot, {
      task: "adjust module wiring",
      paths: ["src/module-3.ts", "src/feature-7/index.ts"],
    });
    if (result.outcome !== "context" || !result.relevant?.knowledge.length)
      throw new Error("Path-focused context must offer appliesTo-matched Knowledge.");
    return result;
  };
  // A task without paths: the similar Sessions' changed files lead to appliesTo-scoped Knowledge the task words miss.
  // The baseline switches the gate off on this store's service (a private field, reached only by this benchmark). The
  // seeded context is budget-tight and its recent Knowledge already covers the matches, so the work done is checked
  // by counting the inference ranking passes instead of requiring a visible pointer.
  const taskContextService = benchStore.contextRecallService;
  // `inference` false closes the gate; true runs the weighted inference (every file of the similar Sessions in one
  // appliesTo scan, knowledgeForWeightedPaths) with the service's default options.
  const getContextTaskOnly = (inference) => () => {
    const original = taskContextService.shouldInferTaskPaths;
    const searchIndex = taskContextService.searchIndex;
    const rank = searchIndex.knowledgeForWeightedPaths;
    let passes = 0;
    taskContextService.shouldInferTaskPaths = inference ? () => true : () => false;
    searchIndex.knowledgeForWeightedPaths = (...args) => {
      passes += 1;
      return rank.apply(searchIndex, args);
    };
    try {
      const result = benchStore.getContext(alphaRoot, { task: "graph renderer module" });
      if (result.outcome !== "context" || passes !== (inference ? 1 : 0))
        throw new Error("Task-only context must run the weighted scan exactly when inference is on.");
      return result;
    } finally {
      searchIndex.knowledgeForWeightedPaths = rank;
      taskContextService.shouldInferTaskPaths = original;
    }
  };
  // Re-indexing churns the FTS index, so the dirty-backlog case runs on its own copy and leaves later cases alone.
  const reindexPath = join(root, "bench-reindex.sqlite");
  withBenchConnection(databasePath, (connection) =>
    connection.exec(`VACUUM INTO '${reindexPath.replaceAll("'", "''")}'`),
  );
  const reindexStore = new WorkIntelligenceStore(reindexPath);
  const dirtyDocumentCount = Math.min(5000, sessionCount);
  const markSessionsDirty = () =>
    withBenchConnection(reindexPath, (connection) =>
      connection.exec(
        `INSERT OR IGNORE INTO search_dirty (doc_type, doc_id)
         SELECT 'session', id FROM sessions ORDER BY id LIMIT ${dirtyDocumentCount}`,
      ),
    );
  // Knowledge backlog cases run on their own copy: the request case writes rows, and the seeded signals
  // (confirmed decisions, links, recovered verification, re-reads) must not change the other cases' data.
  const backlogPath = join(root, "bench-backlog.sqlite");
  withBenchConnection(databasePath, (connection) =>
    connection.exec(`VACUUM INTO '${backlogPath.replaceAll("'", "''")}'`),
  );
  withBenchConnection(backlogPath, (connection) => {
    const alphaSessions = connection
      .prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY completed_at, id")
      .all(alpha.id);
    connection.exec("BEGIN");
    connection.exec(
      "UPDATE session_decisions SET review_status = 'confirmed' WHERE rowid % 4 = 0 OR review_status = 'pending'",
    );
    const insertLink = connection.prepare(
      `INSERT OR IGNORE INTO session_links (id, session_id, related_session_id, relation, source, created_at)
       VALUES (?, ?, ?, 'continues', 'agent', '2026-03-01T00:00:00.000Z')`,
    );
    const insertUpdate = connection.prepare(
      `INSERT INTO session_verification_updates (id, session_id, source, previous_json, resulting_json, created_at)
       VALUES (?, ?, 'agent', '{"status":"failed"}', '{"status":"passed"}', '2026-03-01T00:00:00.000Z')`,
    );
    const insertAudit = connection.prepare(
      `INSERT INTO agent_read_audit (id, created_at, tool, outcome) VALUES (?, '2026-03-01T00:00:00.000Z', 'work_get_session', 'ok')`,
    );
    const insertRecord = connection.prepare(
      "INSERT INTO agent_read_audit_records (audit_id, record_type, record_id) VALUES (?, 'session', ?)",
    );
    alphaSessions.forEach((session, index) => {
      if (index % 20 === 0 && alphaSessions[index + 1])
        insertLink.run(randomUUID(), alphaSessions[index + 1].id, session.id);
      if (index % 50 === 0) insertUpdate.run(randomUUID(), session.id);
      if (index % 40 === 0) {
        const auditId = `bench-backlog-read-${index}`;
        insertAudit.run(auditId);
        insertRecord.run(auditId, session.id);
      }
    });
    connection.exec("COMMIT");
  });
  const backlogStore = new WorkIntelligenceStore(backlogPath);
  const resetBacklogRequests = () =>
    withBenchConnection(backlogPath, (connection) => connection.exec("DELETE FROM knowledge_candidate_requests"));
  // No open request (the request case leaves one), and a project-data write so the next read misses the memo.
  const prepareColdBacklogRead = () =>
    withBenchConnection(backlogPath, (connection) => {
      connection.exec("DELETE FROM knowledge_candidate_requests");
      connection.prepare("UPDATE projects SET updated_at = updated_at WHERE id = ?").run(alpha.id);
    });
  const expectedAnalyzedYear = JSON.stringify(benchStore.getReport({ period: "year", date: "2026-03-11" }));
  // A full audit window (5,000 rows) over 12 tools, with durations, failures, and untimed legacy rows.
  const auditSeed = new DatabaseSync(databasePath);
  try {
    auditSeed
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
         INSERT OR IGNORE INTO agent_read_audit
           (id, created_at, tool, agent_client, project_id, outcome, returned_count, duration_ms, error_code)
         SELECT 'bench-read-' || i,
                strftime('%Y-%m-%dT%H:%M:%fZ', '2026-03-01', '+' || i || ' minutes'),
                'work_tool_' || (i % 12), 'bench-agent-' || (i % 3), CASE WHEN i % 4 = 0 THEN NULL ELSE ? END,
                CASE WHEN i % 50 = 0 THEN 'error' ELSE 'ok' END, i % 9,
                CASE WHEN i % 20 = 0 THEN NULL ELSE (i * 37) % 900 END,
                CASE WHEN i % 50 = 0 THEN 'database_busy' ELSE NULL END
         FROM n`,
      )
      .run(alpha.id);
  } finally {
    auditSeed.close();
  }
  // A separate project database with 500 Knowledge items, so the candidate overlap check scans a large project.
  const overlapPath = join(root, "overlap.sqlite");
  const overlapRoot = join(root, "overlap");
  mkdirSync(overlapRoot, { recursive: true });
  const overlapSeed = new WorkIntelligenceStore(overlapPath);
  const overlapProject = overlapSeed.addProject("overlap", overlapRoot);
  overlapSeed.updateProject(overlapProject.id, { status: "tracked" });
  for (let index = 0; index < 500; index += 1)
    overlapSeed.recordKnowledge({
      projectRoot: overlapRoot,
      idempotencyKey: `bench-overlap-${index}`,
      kind: "gotcha",
      title: `Synthetic module ${index} cache keeps stale entries after reload ${index % 7}`,
      body: `Synthetic module ${index} keeps stale cache entries after a reload; clear the cache in the reload handler. `.repeat(
        3,
      ),
    });
  overlapSeed.close();
  const overlapDatabase = new DatabaseSync(overlapPath, { readOnly: true });
  const overlapCandidates = Array.from({ length: 30 }, (_, index) => ({
    title: `Synthetic module ${index * 3} cache is stale after reload`,
    body: `Synthetic module ${index * 3} returns stale cache entries after a reload until the handler clears it.`,
  }));
  const worstText = seedStoredTextWorstCases(root);
  const worstTextDatabase = new DatabaseSync(worstText.path);
  const distinctPaths = seedDistinctPathStaleness(root);
  const cases = {
    "getContext (large report source request)": () => {
      const result = benchStore.getContext(alphaRoot);
      if (result.outcome !== "context" || JSON.stringify(result).length > 16_000)
        throw new Error("Pending sources exceeded the context budget");
      if (result.pendingRequests.reportSynthesis[0].sourceSessionIds.length > 5)
        throw new Error("Pending source pointers must be bounded");
      return result;
    },
    "report fixed-source context page": () => {
      const result = benchStore.getReportSynthesisContext({
        requestId: presentationRequest.request.id,
        sessionPage: 2,
        maxSessions: 24,
      });
      if (result.outcome !== "report_context" || !result.sessions.length) throw new Error("Missing fixed sources");
      return result;
    },
    "report Agent context budget": () => {
      const result = toAgentReportContext(
        benchStore.getReportSynthesisContext({ requestId: presentationRequest.request.id }),
      );
      if (JSON.stringify(result).length > 24_000) throw new Error("Agent budget exceeded");
      return result;
    },
    "report Agent context later page": () => {
      const result = toAgentReportContext(
        benchStore.getReportSynthesisContext({ requestId: presentationRequest.request.id, sessionPage: 2 }),
      );
      if (result.reportBlockOnSessionPage !== 1 || "totals" in result.report || JSON.stringify(result).length > 24_000)
        throw new Error("A later Agent context page must leave the report block to page 1 and keep its budget");
      return result;
    },
    "getAttention (suppressed preferences)": () => {
      const result = benchStore.getAttention({ projectId: alpha.id, kind: "outstanding", view: "suppressed" });
      if (result.outcome !== "attention" || !result.suppressedCount || !result.items.length)
        throw new Error("Suppressed benchmark must read persisted preferences");
      return result;
    },
    "exportReportPresentation (snapshot and Markdown)": () =>
      benchStore.exportReportPresentation({ summaryId: presentationBase.summary.id, revision: 1, locale: "zh-TW" }),
    "getReportPresentation (version and source gate)": () =>
      benchStore.getReportPresentation(presentationBase.summary.id),
    "getRelatedWork (file overlap)": () => {
      const result = benchStore.getRelatedWork(newestAlpha.id);
      if (result.state !== "ready" || !result.items.length) throw new Error("Expected eligible shared-file candidates");
      return result;
    },
    "getAttention (mixed sources)": () => {
      const result = benchStore.getAttention({ page: 1, pageSize: 20 });
      if (
        result.outcome !== "attention" ||
        !result.items.length ||
        result.groups.some((group) => group.state === "failed")
      ) {
        throw new Error("Attention benchmark must measure available synthetic source groups.");
      }
      return result;
    },
    "getSessionDetail (200 architecture nodes)": () => {
      const result = benchStore.getSessionDetail(architectureSession.session.id);
      if (!result?.diagrams.length) throw new Error("Expected a complete architecture snapshot.");
      return result;
    },
    "getSessionDetailForAgent (full + revision, 200 nodes)": () => {
      const result = benchStore.getSessionDetailForAgent({ sessionId: architectureSession.session.id });
      if (result.outcome !== "session_detail" || !result.session.revision) throw new Error("Expected a revision.");
      return result;
    },
    "getSessionDetailForAgent (unchanged knownRevision, 200 nodes)": () => {
      const result = benchStore.getSessionDetailForAgent({
        sessionId: architectureSession.session.id,
        knownRevision: architectureRevision,
      });
      if (result.outcome !== "session_unchanged") throw new Error("Expected an unchanged revision.");
      return result;
    },
    "getSessionProjection (completion, 200 nodes omitted)": () =>
      benchStore.getSessionDetailForAgent({ sessionId: architectureSession.session.id, view: "completion" }),
    "getSessionProjection (handoff, 200 nodes omitted)": () =>
      benchStore.getSessionDetailForAgent({ sessionId: architectureSession.session.id, view: "handoff" }),
    "getSessionProjection (selected native source)": () =>
      benchStore.getSessionDetailForAgent({
        sessionId: architectureSession.session.id,
        select: ["session.changedFiles", "diagrams"],
      }),
    "listSessionsPage (default)": () => benchStore.listSessionsPage({ page: 1, pageSize: 20 }),
    "listSessionsPage (page 50)": () => benchStore.listSessionsPage({ page: 50, pageSize: 20 }),
    "listSessionsPage (date range)": () =>
      benchStore.listSessionsPage({ from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (project + range)": () =>
      benchStore.listSessionsPage({ projectId: beta.id, from: "2026-03-01", to: "2026-03-31", page: 1, pageSize: 20 }),
    "listSessionsPage (query)": () => benchStore.listSessionsPage({ query: "graph", page: 1, pageSize: 20 }),
    "listSessionsPage (query, no match)": () =>
      benchStore.listSessionsPage({ query: "zzqxnomatchterm", page: 1, pageSize: 20 }),
    "listSessionDigests (page 100 + pending items)": () => listSessionDigestPage(benchStore, alpha.id),
    // Synthetic Sessions record no commit, so this times the ambiguity check, count and page on the index seek.
    "listSessionsForAgent (commitSha prefix)": () =>
      benchStore.listSessionsForAgent({ commitSha: "abc1234", page: 1, pageSize: 20 }),
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
    "getReport year (after ANALYZE)": () => {
      const result = analyzedStore.getReport({ period: "year", date: "2026-03-11" });
      if (JSON.stringify(result) !== expectedAnalyzedYear)
        throw new Error("The ANALYZE snapshot must produce the same year report.");
      return result;
    },
    getContext: () => benchStore.getContext(),
    "metadata follow-up counts": () => {
      const result = benchStore.countMetadataBackfillFollowUps();
      if (!result || JSON.stringify(result) !== JSON.stringify(expectedMetadataFollowUpTotals)) {
        throw new Error("Metadata follow-up count query must match the complete preview totals.");
      }
      return result;
    },
    // Every run follows a write by another connection, so the count is scanned again instead of reused.
    "metadata follow-up counts (after a write)": () => {
      const result = benchStore.countMetadataBackfillFollowUps();
      if (!result || JSON.stringify(result) !== JSON.stringify(expectedMetadataFollowUpTotals)) {
        throw new Error("Metadata follow-up count after a write must match the complete preview totals.");
      }
      return result;
    },
    // A bulk change left 5,000 Session documents dirty; the first read re-indexes them all before searching.
    "first read after 5,000 dirty documents": () => {
      const result = reindexStore.search("zzqxnomatchterm");
      withBenchConnection(reindexPath, (connection) => {
        if (connection.prepare("SELECT COUNT(*) AS count FROM search_dirty").get().count !== 0)
          throw new Error("The first read must re-index every dirty document before it searches.");
      });
      return result;
    },
    // Scores every uncovered Session of the project, ranks the top ten, and writes the request row.
    "requestKnowledgeCandidates selection": () => {
      const result = backlogStore.requestKnowledgeCandidates(alphaRoot);
      if (
        result.outcome !== "knowledge_candidate_request" ||
        result.duplicate ||
        result.request.sourceSessionIds.length !== 10 ||
        result.remaining?.highValueSessions === undefined
      )
        throw new Error("The request benchmark must select ten source Sessions and report what remains.");
      return result;
    },
    // A write by another connection precedes every run, so the backlog is scored again.
    "getContext with knowledge backlog (cold token)": () => {
      const result = backlogStore.getContext(alphaRoot);
      if (result.outcome !== "context" || !result.pendingRequests.knowledgeBacklog)
        throw new Error("The backlog benchmark must offer the Knowledge candidate backlog.");
      return result;
    },
    "getContext with knowledge backlog (warm token)": () => {
      const result = backlogStore.getContext(alphaRoot);
      if (result.outcome !== "context" || !result.pendingRequests.knowledgeBacklog)
        throw new Error("The backlog benchmark must offer the Knowledge candidate backlog.");
      return result;
    },
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
    // Repeated reads of unchanged data reuse the remembered staleness results (the revision cache); the "(after a
    // write)" case below reads the later Sessions again on every run, which is what a first read at the start of
    // work costs.
    "getContext (paths, appliesTo-matched Knowledge)": getContextPathsAppliesTo,
    "getContext (paths, appliesTo-matched Knowledge, after a write)": getContextPathsAppliesTo,
    "getContext (task only, no inference)": getContextTaskOnly(false),
    "getContext (task only, inferred-path Knowledge)": getContextTaskOnly(true),
    "finalizeSession (related pending reminder)": () => {
      const index = ++maintenanceFinalizeIndex;
      const focus = [
        finalizeReminderCandidate.term,
        ...Array.from({ length: 23 }, (_, termIndex) => `reminderprobe${termIndex}x`),
      ].join(" ");
      const result = benchStore.finalizeSession({
        projectRoot: alphaRoot,
        idempotencyKey: `bench-outstanding-finalize-${index}`,
        title: focus,
        summary: focus,
        changedFiles: [],
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      });
      if (
        result.outcome !== "finalized" ||
        !result.relatedOutstandingItems?.items.some((item) => item.id === finalizeReminderCandidate.id) ||
        result.relatedOutstandingItems.total !== 1
      )
        throw new Error(
          `Related finalize benchmark must return only ${finalizeReminderCandidate.id} for ${finalizeReminderCandidate.term}; ` +
            `got ${JSON.stringify(result.relatedOutstandingItems)}.`,
        );
      return result;
    },
    // A realistic closing write: 20 changed paths shared with pending items' Sessions and with Knowledge appliesTo,
    // so the related-item path scoring and the knowledgeToReview check both do real work. The seeded module
    // Knowledge is already possiblyStale (an early exit); the fresh Knowledge seeded before each run is not, so its
    // check walks every later Session of the project before it is reported.
    "finalizeSession (changed files, Knowledge review)": () => {
      const index = ++maintenanceFinalizeIndex;
      const changedFiles = [
        ...Array.from({ length: 9 }, (_, fileIndex) => [
          `src/module-${fileIndex}.ts`,
          `src/feature-${fileIndex}/index.ts`,
        ]).flat(),
        `src/module-9.ts`,
        freshReviewKnowledge.path,
      ];
      const result = benchStore.finalizeSession({
        projectRoot: alphaRoot,
        idempotencyKey: `bench-changed-files-finalize-${index}`,
        title: `Synthetic module refactor ${index}`,
        summary: "Refactored synthetic modules and their feature entry points; verified with the synthetic suite.",
        changedFiles,
        verification: { status: "passed" },
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      });
      if (
        result.outcome !== "finalized" ||
        !result.relatedOutstandingItems?.total ||
        result.knowledgeToReview?.length !== 1 ||
        result.knowledgeToReview[0].id !== freshReviewKnowledge.id
      )
        throw new Error("Changed-files finalize benchmark must return related items and only the fresh Knowledge.");
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
    "getKnowledgePageContext (not_found diagnostics)": () =>
      benchStore.getKnowledgePageContext({ projectRoot: alphaRoot, slug: "pitfall-notes" }),
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
    // Twenty stale-checked Knowledge hits; trust must be read in one batch, not once per hit.
    // Every run follows a write by another connection, so the staleness is read again instead of reused.
    "recall (20 Knowledge hits with staleness)": () =>
      benchStore.recall({ q: "synthetic knowledge staleness", projectRoot: alphaRoot, limit: 30 }),
    "recall (paths, appliesTo)": recallPathsAppliesTo,
    "recall (paths, appliesTo, after a write)": recallPathsAppliesTo,
    "recall evaluator (snapshot + MCP recall/context)": () =>
      evaluateRecallQuestions(databasePath, evaluationQuestions),
    "searchKnowledge (staleness)": () => benchStore.searchKnowledge({ projectRoot: alphaRoot, limit: 20 }),
    // A strict miss: relaxed ranking over the FTS index, appliesTo path matching, and the archived count.
    "searchKnowledgeForAgent (relaxed fallback)": () =>
      benchStore.searchKnowledgeForAgent({
        projectRoot: alphaRoot,
        q: "synthetic staleness src/feature-a/index.ts zzyzx",
      }),
    previewMetadataBackfill: () => benchStore.previewMetadataBackfill({}),
    getGraph: () => benchStore.getGraph({}),
    "getGraph (default 180 nodes)": () => {
      const result = benchStore.getGraph({});
      if (result.outcome !== "graph" || result.nodes.length !== 180 || result.totalNodes <= 180) {
        throw new Error("Default graph benchmark must truncate to 180 nodes of a larger synthetic graph.");
      }
      return result;
    },
    "getGraph (with derived)": () => benchStore.getGraph({ includeDerived: true }),
    "getGraphPath (500 nodes)": () =>
      benchStore.getGraphPath({ projectId: alpha.id, from: `project:${alpha.id}`, to: pathTarget }),
    "getTimeline (month)": () => benchStore.getTimeline({ from: "2026-03-01", to: "2026-03-31" }),
    "getTimeline (year)": () => benchStore.getTimeline({ from: "2025-10-01", to: "2026-09-30" }),
    "getActivity (year)": () => benchStore.getActivity({ from: "2025-10-01", to: "2026-09-30" }),
    "getHotspots (files)": () => benchStore.getHotspots({ limit: 20 }),
    "getHotspots (directories, month)": () =>
      benchStore.getHotspots({ groupBy: "directory", from: "2026-03-01", to: "2026-03-31", limit: 20 }),
    // Three paths with 28–125 Sessions each: whole-history totals, digests, attention, and appliesTo Knowledge.
    "getFileHistory (3 paths)": () => {
      const result = benchStore.getFileHistory({
        projectRoot: alphaRoot,
        paths: ["src/module-0.ts", "src/module-2.ts", "src/feature-0/index.ts"],
      });
      if (result.outcome !== "file_history" || result.files.some((file) => file.totals.sessions < 20))
        throw new Error("File history benchmark must read the synthetic histories of all three paths.");
      return result;
    },
    // A stored star-heavy appliesTo against caller paths at the 500-character limit; a backtracking matcher hangs here.
    "appliesTo glob (star-heavy pattern, 500-char paths)": () => {
      const pattern = "**a**a**a**a**a**a**a**b";
      for (const path of ["a".repeat(500), `${"a/".repeat(249)}a`, "ba".repeat(250)])
        if (appliesToStrength(pattern, path) !== 0) throw new Error("The star-heavy pattern must not match.");
    },
    // The second security review's input: 30 entries of 500 stars against 20 paths at the 1,000-character limit.
    // The star bound rejects each pair in one step; unbounded, this took about 3.5 s.
    "appliesTo glob (30 x 500-star patterns, 20 x 1,000-char paths)": () => {
      const budget = createAppliesToBudget();
      const pattern = "a*".repeat(500);
      for (let entry = 0; entry < 30; entry += 1)
        for (let path = 0; path < 20; path += 1)
          if (appliesToStrength(pattern, "a".repeat(1_000), budget) !== 0)
            throw new Error("A glob above the star bound must not match.");
      if (budget.exhausted) throw new Error("Over-complex pairs must be rejected without simulating them.");
    },
    // The costliest globs the star bound allows (16 stars between literal runs a long path contains) until one scan's
    // match budget runs out: the wall-clock side of the deterministic step limit.
    "appliesTo scan (16-star patterns until the match budget runs out)": () => {
      const budget = createAppliesToBudget();
      const matches = compileAppliesTo(`${`**${"a".repeat(62)}`.repeat(15)}**`);
      for (let pair = 0; pair < 600 && !budget.exhausted; pair += 1) matches("a".repeat(1_000), budget);
      if (!budget.exhausted) throw new Error("The scan must stop at its match budget.");
    },
    // The third review's first finding: 2-star globs around ~600 characters of near-miss literal runs against paths
    // at the length limit, as one call's 2,000 rows x 30 entries x 20 paths. The literal search is linear and charged
    // per character, so the scan stops at the budget (charged 1 step per pair and quadratic, this took about 50 s).
    "appliesTo scan (near-miss literal runs, 2,000 rows x 30 x 20 paths)": () => {
      const budget = createAppliesToBudget();
      const paths = Array.from({ length: 20 }, (_, index) => `x${"a".repeat(996 - index)}y`);
      for (let row = 0; row < 2_000 && !budget.exhausted; row += 1)
        for (let entry = 0; entry < 30 && !budget.exhausted; entry += 1) {
          const matches = compileAppliesTo(`x*${"a".repeat(300)}b${"a".repeat(300 - (entry % 3))}*y`, budget);
          for (const path of paths) if (matches(path, budget)) throw new Error("The near-miss glob must not match.");
        }
      if (!budget.exhausted) throw new Error("The scan must stop at its match budget.");
    },
    // The second finding: a crafted 2 MB entry (skipped before it is tokenized; from 1.6.27 parsing costs 4 units per
    // character, so a 5 MB list alone would spend the budget, and SQL no longer loads lists above about 2.5 MB) and distinct 1,000-character entries
    // that defeat the compile cache (each miss charged) until the budget runs out.
    "appliesTo stored entries (2 MB entry, distinct 1,000-char entries)": () => {
      const budget = createAppliesToBudget();
      const crafted = JSON.stringify([`src/*${"a".repeat(2_000_000)}*.ts`, "src/*.ts"]);
      if (appliesToEntries(crafted, [], budget).length !== 1 || budget.skippedEntries !== 1)
        throw new Error("The oversized entry must be skipped without normalizing it.");
      for (let entry = 0; !budget.exhausted; entry += 1)
        compileAppliesTo(`${entry}-*${"a".repeat(985)}*`, budget)("src/a.ts", budget);
    },
    // 30 submitted candidates against 500 Knowledge items of one project: each existing item is tokenized once.
    "knowledgeCandidateOverlaps (30 candidates, 500 Knowledge)": () => {
      const result = findKnowledgeCandidateOverlaps(
        overlapDatabase,
        { projectId: overlapProject.id, requestId: "bench-request", createdAtOrBefore: "9999-12-31T00:00:00.000Z" },
        overlapCandidates,
      );
      if (result.length !== 30 || result.some((overlaps) => overlaps.length === 0))
        throw new Error("Every synthetic candidate must overlap its module's Knowledge.");
      return result;
    },
    // The 1.6.27 review's list-search shape: eight 200-character near-miss words over 200 rows of the largest
    // appliesTo (15.7 s with LIKE). With instr each row costs at most its bytes x words; every row is read, no warning.
    "searchKnowledge (200 x 30 x 1,000-char appliesTo, 8 near-miss words)": () => {
      const result = worstText.store.searchKnowledge({ projectRoot: worstText.listRoot, q: worstText.nearMiss });
      if (result.outcome !== "knowledge" || result.pageInfo.total !== 200 || result.warnings)
        throw new Error("The worst-case list search must read every row within its cap, without a warning.");
      return result;
    },
    // 200 candidates, 5,000 later Sessions, the oldest touching all of them (3.0 s when each candidate scanned alone).
    "knowledgeToReview (200 candidates, 5,000 later Sessions)": () => {
      const result = findKnowledgeToReview(worstTextDatabase, worstText.focus);
      if (result.hints.length !== 0 || result.truncated)
        throw new Error("The one-pass review check must decide every candidate within its budget.");
      return result;
    },
    // A Knowledge read after 5,000 later Sessions of 20 x 100-character files (50 x 100 took 433 ms and 235 MB with
    // one .all()); the read is charged row by row and its budget grows with the rows, so it finishes.
    "searchKnowledge (staleness over 5,000 Sessions of 20 x 100-char files)": () => {
      const result = worstText.store.searchKnowledge({ projectRoot: worstText.root, kind: "decision" });
      if (result.outcome !== "knowledge" || result.items.length !== 1 || result.items[0].stalenessUnchecked)
        throw new Error("The staleness check must finish on legitimate history.");
      return result;
    },
    // Each appliesTo entry is resolved against an index of the distinct later paths (later-change-index.ts).
    "searchKnowledge (staleness, 2,000 Sessions of 50 distinct files, page 20)": () => {
      const result = distinctPaths.store.searchKnowledge({ projectRoot: distinctPaths.distinctRoot, pageSize: 20 });
      if (
        result.outcome !== "knowledge" ||
        result.items.length !== 20 ||
        result.items.some((item) => item.stalenessUnchecked) ||
        !result.items.some((item) => item.possiblyStale)
      )
        throw new Error("The indexed staleness check must finish on distinct-path history.");
      return result;
    },
    // Every path is a candidate for this glob and costs the full simulation. The read either decides every item or
    // stops at the match ceiling and marks them unchecked; what this case bounds is the time either way. (With the
    // 50M ceiling first chosen this data stopped; at 300M it is decided. tests/storage/later-change-index.test.ts
    // covers the stop itself with an injected ceiling.)
    "searchKnowledge (15-star glob over long paths, decided or stopped at the match ceiling)": () => {
      const result = distinctPaths.store.searchKnowledge({ projectRoot: distinctPaths.starRoot, pageSize: 20 });
      if (result.outcome !== "knowledge" || result.items.length === 0)
        throw new Error("A 15-star glob tested against every long path must be answered or marked unchecked.");
      return result;
    },
    "summarizeAgentReads (5,000 rows)": () => {
      const result = benchStore.summarizeAgentReads({});
      if (result.tools.length !== 12 || result.tools.some((tool) => tool.p95Ms === null))
        throw new Error("Agent read stats must cover the seeded tools");
      return result;
    },
  };

  const projectDataBundle = benchStore.exportProjectData({ type: "all" });
  // The heavy API cases (backup, export, import preview) copy or read the whole database, so their time grows with
  // the file. The other cases write into benchStore (finalize, per-run Knowledge, outstanding cleanup…), which made
  // the heavy cases copy a larger file in a full run than with --backup-worker-only. They therefore run against a
  // byte copy of the database taken here, after all seeding and before any case runs: the same file in both modes.
  withBenchConnection(databasePath, (connection) => connection.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
  const heavyDatabasePath = join(root, "bench-heavy.sqlite");
  copyFileSync(databasePath, heavyDatabasePath);
  const heavyStore = new WorkIntelligenceStore(heavyDatabasePath);
  const heavyDatabaseBytes = () => statSync(heavyDatabasePath).size;
  const exportDirectory = join(root, "export");
  const resetHeavyOutputs = () => {
    rmSync(join(root, "backups"), { recursive: true, force: true });
    rmSync(exportDirectory, { recursive: true, force: true });
    mkdirSync(exportDirectory);
  };
  const { createApiHandler } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "server.js")).href
  );
  const workerClientModule =
    backupWorkerMode === "worker"
      ? await import(pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "backup-worker-client.js")).href)
      : undefined;
  const BackupWorkerClient = workerClientModule?.BackupWorkerClient;
  const backgroundStore = BackupWorkerClient
    ? new BackupWorkerClient(heavyDatabasePath, {}, LATEST_SCHEMA_VERSION, {
        idleTimeoutMs: backupWorkerBenchIdleTimeoutMs,
      })
    : undefined;
  const coldStartWorkers = new Set();
  const coldStartWorkerClosures = new Set();
  function runColdStartWorker(operation) {
    const worker = new BackupWorkerClient(heavyDatabasePath, {}, LATEST_SCHEMA_VERSION, { idleTimeoutMs: 0 });
    coldStartWorkers.add(worker);
    const result = operation(worker);
    const closeWorker = () => {
      const closing = worker.close().finally(() => coldStartWorkers.delete(worker));
      coldStartWorkerClosures.add(closing);
      void closing.then(
        () => coldStartWorkerClosures.delete(closing),
        () => coldStartWorkerClosures.delete(closing),
      );
    };
    void result.then(closeWorker, closeWorker);
    return result;
  }
  async function waitForColdStartWorkersClosed() {
    while (coldStartWorkerClosures.size > 0) {
      await Promise.allSettled([...coldStartWorkerClosures]);
    }
  }
  const coldStartBackgroundStore = BackupWorkerClient
    ? {
        createBackup: () => runColdStartWorker((worker) => worker.createBackup()),
        backupIfDue: () => runColdStartWorker((worker) => worker.backupIfDue()),
        exportTo: (target) => runColdStartWorker((worker) => worker.exportTo(target)),
        exportProjectData: (scope) => runColdStartWorker((worker) => worker.exportProjectData(scope)),
        previewProjectDataImport: (input) => runColdStartWorker((worker) => worker.previewProjectDataImport(input)),
        importProjectData: (input) => runColdStartWorker((worker) => worker.importProjectData(input)),
        async close() {
          await Promise.all([...coldStartWorkers].map((worker) => worker.close()));
          await waitForColdStartWorkersClosed();
        },
      }
    : undefined;
  const benchmarkServer = createServer(
    createApiHandler(heavyStore, {
      ...(backgroundStore ? { backgroundStore } : {}),
    }),
  );
  await new Promise((resolve, reject) => {
    benchmarkServer.once("error", reject);
    benchmarkServer.listen(0, "127.0.0.1", resolve);
  });
  const benchmarkAddress = benchmarkServer.address();
  if (!benchmarkAddress || typeof benchmarkAddress === "string") {
    throw new Error("The synthetic benchmark API did not expose a TCP address.");
  }
  const benchmarkBaseUrl = `http://127.0.0.1:${benchmarkAddress.port}`;
  let coldStartServer;
  let coldStartBaseUrl;
  if (coldStartBackgroundStore) {
    coldStartServer = createServer(createApiHandler(heavyStore, { backgroundStore: coldStartBackgroundStore }));
    await new Promise((resolve, reject) => {
      coldStartServer.once("error", reject);
      coldStartServer.listen(0, "127.0.0.1", resolve);
    });
    const coldStartAddress = coldStartServer.address();
    if (!coldStartAddress || typeof coldStartAddress === "string") {
      throw new Error("The cold-start synthetic benchmark API did not expose a TCP address.");
    }
    coldStartBaseUrl = `http://127.0.0.1:${coldStartAddress.port}`;
  }
  closeBenchmarkApi = async () => {
    if (benchmarkApiClosed) return;
    benchmarkApiClosed = true;
    const closeServer = (server) =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    await closeServer(benchmarkServer);
    if (coldStartServer) await closeServer(coldStartServer);
    await backgroundStore?.close();
    await coldStartBackgroundStore?.close();
  };

  const makeHeavyCases = (baseUrl, probeHealth) => ({
    createBackup: () => runHeavyApiClient(baseUrl, "/api/backups", "{}", sessionCount, probeHealth),
    "exportTo (whole database)": () => runHeavyApiClient(baseUrl, "/api/export", "{}", sessionCount, probeHealth),
    "exportProjectData (all projects)": () =>
      runHeavyApiClient(baseUrl, "/api/export", JSON.stringify({ scope: "all" }), sessionCount, probeHealth),
    "previewProjectDataImport (all projects)": () =>
      runHeavyApiClient(
        baseUrl,
        "/api/import/preview",
        JSON.stringify({ bundle: projectDataBundle }),
        sessionCount,
        probeHealth,
      ),
    // The whole online import (pre-import backup, validation, plan, write transaction, index sync) of data already
    // present: every row is skipped, so each run leaves the snapshot as it was apart from one audit row.
    "importProjectData (all projects, already present)": () =>
      runHeavyApiClient(
        baseUrl,
        "/api/import",
        JSON.stringify({ bundle: projectDataBundle }),
        sessionCount,
        probeHealth,
      ),
  });
  const heavyCases = makeHeavyCases(benchmarkBaseUrl, false);
  const heavyHealthCases = makeHeavyCases(benchmarkBaseUrl, true);
  const coldStartHeavyCases = coldStartBaseUrl ? makeHeavyCases(coldStartBaseUrl, false) : {};
  const heavyRuns = 5;
  const beforeEachRun = {
    "finalizeSession (changed files, Knowledge review)": seedFreshReviewKnowledge,
    "metadata follow-up counts (after a write)": touchProjectData,
    "recall (20 Knowledge hits with staleness)": touchProjectData,
    "recall (paths, appliesTo, after a write)": touchProjectData,
    "getContext (paths, appliesTo-matched Knowledge, after a write)": touchProjectData,
    "requestKnowledgeCandidates selection": resetBacklogRequests,
    "getContext with knowledge backlog (cold token)": prepareColdBacklogRead,
    "first read after 5,000 dirty documents": markSessionsDirty,
    "getMcpRuntimeStatus (286 expired leases)": seedExpiredLeases,
    "registerMcpProcess (286 expired leases)": seedExpiredLeases,
    createBackup: resetHeavyOutputs,
    "exportTo (whole database)": resetHeavyOutputs,
    "importProjectData (all projects, already present)": resetHeavyOutputs,
  };

  const limitsMs = {
    "getContext (large report source request)": 500,
    "report fixed-source context page": 1500,
    "report Agent context budget": 1500,
    "report Agent context later page": 1500,
    "getReportPresentation (version and source gate)": 250,
    "exportReportPresentation (snapshot and Markdown)": 250,
    "getAttention (mixed sources)": 500,
    "getAttention (suppressed preferences)": 500,
    "getRelatedWork (file overlap)": 250,
    "getSessionDetail (200 architecture nodes)": 250,
    "getSessionDetailForAgent (full + revision, 200 nodes)": 250,
    "getSessionDetailForAgent (unchanged knownRevision, 200 nodes)": 250,
    "getSessionProjection (completion, 200 nodes omitted)": 250,
    "getSessionProjection (handoff, 200 nodes omitted)": 250,
    "getSessionProjection (selected native source)": 250,
    "listSessionsPage (default)": 200,
    "listSessionsPage (query)": 300,
    "listSessionsPage (query, no match)": 300,
    "listSessionDigests (page 100 + pending items)": 100,
    "listSessionsForAgent (commitSha prefix)": 50,
    getDashboardSummary: 250,
    "getReport week": 750,
    "getReport (in-progress verification)": 750,
    "getReport year": 1500,
    "getReport year (after ANALYZE)": 1500,
    getContext: 500,
    "metadata follow-up counts": 100,
    "metadata follow-up counts (after a write)": 100,
    "requestKnowledgeCandidates selection": 250,
    "getContext with knowledge backlog (cold token)": 500,
    "getContext with knowledge backlog (warm token)": 500,
    "first read after 5,000 dirty documents": 1500,
    "getContext (project with pages)": 500,
    "getContext (related pending items)": 500,
    "getContext (paths, appliesTo-matched Knowledge)": 250,
    "getContext (paths, appliesTo-matched Knowledge, after a write)": 400,
    "getContext (task only, no inference)": 250,
    "getContext (task only, inferred-path Knowledge)": 250,
    "recall (paths, appliesTo)": 100,
    "recall (paths, appliesTo, after a write)": 150,
    "finalizeSession (related pending reminder)": 250,
    "finalizeSession (changed files, Knowledge review)": 250,
    "listKnowledgePages (staleness)": 250,
    "finalizeSession (knowledge page reminder)": 250,
    "MCP guarded finalize (schema check)": 250,
    "getMcpRuntimeStatus (cached identity)": 50,
    "getMcpRuntimeStatus (286 expired leases)": 100,
    "registerMcpProcess (286 expired leases)": 100,
    "getKnowledgePageContext (review)": 250,
    "getKnowledgePageContext (not_found diagnostics)": 50,
    "listSessionDecisions (pending)": 250,
    "listOutstandingItems (pending)": 250,
    "listOutstandingItems (source date range)": 250,
    "listOutstandingCleanupRequests (page 5)": 250,
    "getOutstandingCleanupContext (5 items + 10 Sessions)": 250,
    "listOutstandingCleanupProposals (page 100)": 250,
    search: 500,
    "recall (month range)": 500,
    "recall (synonym expansion)": 500,
    "recall (20 Knowledge hits with staleness)": 250,
    "recall evaluator (snapshot + MCP recall/context)": 1000,
    "getGraph (default 180 nodes)": 250,
    "getGraph (with derived)": 750,
    "getGraphPath (500 nodes)": 750,
    "getTimeline (month)": 250,
    "getTimeline (year)": 750,
    "getActivity (year)": 250,
    "getHotspots (files)": 500,
    "getHotspots (directories, month)": 500,
    "getFileHistory (3 paths)": 50,
    "appliesTo glob (star-heavy pattern, 500-char paths)": 20,
    "appliesTo glob (30 x 500-star patterns, 20 x 1,000-char paths)": 20,
    "appliesTo scan (16-star patterns until the match budget runs out)": 250,
    "appliesTo scan (near-miss literal runs, 2,000 rows x 30 x 20 paths)": 250,
    "appliesTo stored entries (2 MB entry, distinct 1,000-char entries)": 250,
    "knowledgeCandidateOverlaps (30 candidates, 500 Knowledge)": 150,
    "summarizeAgentReads (5,000 rows)": 100,
    "searchKnowledge (staleness)": 500,
    "searchKnowledge (200 x 30 x 1,000-char appliesTo, 8 near-miss words)": 1000,
    "knowledgeToReview (200 candidates, 5,000 later Sessions)": 250,
    "searchKnowledge (staleness over 5,000 Sessions of 20 x 100-char files)": 500,
    "searchKnowledge (staleness, 2,000 Sessions of 50 distinct files, page 20)": 1000,
    "searchKnowledge (15-star glob over long paths, decided or stopped at the match ceiling)": 1000,
    "searchKnowledgeForAgent (relaxed fallback)": 250,
    createBackup: 300,
    "exportTo (whole database)": 300,
    "exportProjectData (all projects)": 400,
    "previewProjectDataImport (all projects)": 1500,
    "importProjectData (all projects, already present)": 1500,
  };
  const transactionLimitsMs = {
    "finalizeSession (related pending reminder)": 50,
    "finalizeSession (changed files, Knowledge review)": 50,
  };
  // Ubuntu CI observed 11.26–44.83 ms event-loop block p90; twice the 44.83 ms maximum rounds up to 100 ms.
  const eventLoopBlockLimitMs = 100;

  const results = [];
  // The heavy cases run first. They read their own snapshot through their own store, so nothing they do reaches the
  // other cases; run last, they were measured while the operating system was still writing out what the earlier
  // cases produced (the dirty-document copy, the worst-case stores), and Ubuntu CI saw createBackup at 193–213 ms and
  // exportTo at 262–305 ms against 133 and 225 ms before those cases existed, with every CPU-bound case unchanged.
  const benchmarkCases = backupWorkerOnly ? heavyCases : { ...heavyCases, ...cases };
  const selectedCases = Object.entries(benchmarkCases).filter(
    ([name]) =>
      (backupWorkerOnly || !checkMode || name in limitsMs) && (!benchmarkCaseFilter || name === benchmarkCaseFilter),
  );
  if (benchmarkCaseFilter && selectedCases.length === 0) {
    throw new Error(`No benchmark case matched --case=${caseFilter}.`);
  }
  // Shared CI runners occasionally stall a whole case; a failing case is measured once more before the gate fails.
  const measureCase = async (name, run) => {
    const isHeavyCase = name in heavyCases;
    const caseRuns = isHeavyCase ? heavyRuns : runs;
    const databaseBytesBefore = isHeavyCase ? heavyDatabaseBytes() : undefined;
    beforeEachRun[name]?.();
    await run();
    const transactionObserver = name in transactionLimitsMs ? observeWriteTransactionDurations(benchStore) : undefined;
    const samples = [];
    const transactionSamples = transactionObserver?.samples ?? [];
    const operationSamples = [];
    const eventLoopP90Samples = [];
    const eventLoopMaxSamples = [];
    const rssPeakSamples = [];
    const healthP90Samples = [];
    const healthProbeSamples = [];
    try {
      for (let index = 0; index < caseRuns; index += 1) {
        beforeEachRun[name]?.();
        if (isHeavyCase) {
          const measured = await measureProcessResources(run);
          samples.push(measured.value.operationMs);
          operationSamples.push(measured.value.operationMs);
          eventLoopP90Samples.push(measured.eventLoopP90Ms);
          eventLoopMaxSamples.push(measured.eventLoopMaxMs);
          rssPeakSamples.push(measured.rssPeakMb);
          beforeEachRun[name]?.();
          const healthRun = await heavyHealthCases[name]();
          healthP90Samples.push(healthRun.healthP90Ms);
          healthProbeSamples.push(healthRun.healthProbeCount);
        } else {
          const started = performance.now();
          await run();
          samples.push(performance.now() - started);
        }
      }
    } finally {
      transactionObserver?.restore();
    }
    samples.sort((a, b) => a - b);
    const p90Ms = Number(samples[Math.ceil(caseRuns * 0.9) - 1].toFixed(2));
    const result = {
      case: name,
      runs: caseRuns,
      medianMs: Number(samples[Math.floor(caseRuns / 2)].toFixed(2)),
      p90Ms,
      maxMs: Number(samples[caseRuns - 1].toFixed(2)),
      limitMs: limitsMs[name] ?? null,
      passed: checkMode ? p90Ms <= limitsMs[name] : undefined,
    };
    if (transactionSamples.length > 0) {
      transactionSamples.sort((left, right) => left - right);
      const transactionP90Ms = Number(transactionSamples[Math.ceil(transactionSamples.length * 0.9) - 1].toFixed(2));
      const transactionLimitMs = transactionLimitsMs[name];
      Object.assign(result, {
        transactionMedianMs: Number(transactionSamples[Math.floor(transactionSamples.length / 2)].toFixed(2)),
        transactionP90Ms,
        transactionLimitMs,
        passed:
          checkMode && transactionLimitMs !== undefined
            ? result.passed && transactionP90Ms <= transactionLimitMs
            : result.passed,
      });
    }
    if (isHeavyCase) {
      operationSamples.sort((a, b) => a - b);
      eventLoopP90Samples.sort((a, b) => a - b);
      eventLoopMaxSamples.sort((a, b) => a - b);
      rssPeakSamples.sort((a, b) => a - b);
      healthP90Samples.sort((a, b) => a - b);
      const operationP90Ms = Number(operationSamples[Math.ceil(caseRuns * 0.9) - 1].toFixed(2));
      const healthP90Ms = Number(healthP90Samples[Math.ceil(caseRuns * 0.9) - 1].toFixed(2));
      const eventLoopBlockP90Ms = Number(eventLoopMaxSamples[Math.ceil(caseRuns * 0.9) - 1].toFixed(2));
      const eventLoopBlockMaxMs = Number(eventLoopMaxSamples.at(-1).toFixed(2));
      const eventLoopDelayP90Ms = Number(
        eventLoopP90Samples.sort((a, b) => a - b)[Math.ceil(caseRuns * 0.9) - 1].toFixed(2),
      );
      const operationLimitMs = limitsMs[name];
      const eventLoopLimitMs = eventLoopBlockLimitMs;
      const passed =
        healthP90Ms <= operationLimitMs &&
        operationP90Ms <= operationLimitMs &&
        eventLoopBlockP90Ms <= eventLoopLimitMs;
      Object.assign(result, {
        operationMedianMs: Number(operationSamples[Math.floor(caseRuns / 2)].toFixed(2)),
        operationP90Ms,
        operationLimitMs,
        healthP90Ms,
        healthLimitMs: operationLimitMs,
        eventLoopDelayP90Ms,
        eventLoopBlockP90Ms,
        eventLoopBlockMaxMs,
        eventLoopLimitMs,
        healthProbeCountMedian: Number(healthProbeSamples.sort((a, b) => a - b)[Math.floor(caseRuns / 2)]),
        rssPeakMaxMb: rssPeakSamples.at(-1),
        databaseBytes: databaseBytesBefore,
        passed: checkMode ? passed : undefined,
      });

      if (coldStartHeavyCases[name]) {
        const coldStartOperationSamples = [];
        for (let index = 0; index < caseRuns; index += 1) {
          beforeEachRun[name]?.();
          const coldStartRun = await coldStartHeavyCases[name]();
          coldStartOperationSamples.push(coldStartRun.operationMs);
          await waitForColdStartWorkersClosed();
        }
        coldStartOperationSamples.sort((a, b) => a - b);
        Object.assign(result, {
          coldStartOperationMedianMs: Number(coldStartOperationSamples[Math.floor(caseRuns / 2)].toFixed(2)),
          coldStartOperationP90Ms: Number(coldStartOperationSamples[Math.ceil(caseRuns * 0.9) - 1].toFixed(2)),
          coldStartOperationMaxMs: Number(coldStartOperationSamples.at(-1).toFixed(2)),
        });
      }
    }
    return result;
  };
  for (const [name, run] of selectedCases) {
    results.push(await measureCase(name, run));
  }
  if (checkMode) {
    for (const [index, result] of results.entries()) {
      if (result.passed) continue;
      const remeasured = await measureCase(result.case, benchmarkCases[result.case]);
      console.warn(
        `Re-measured ${result.case} after a failed first pass: ${remeasured.passed ? "passed" : "failed again"} (first p90 ${result.operationP90Ms ?? result.p90Ms} ms, second p90 ${remeasured.operationP90Ms ?? remeasured.p90Ms} ms).`,
      );
      results[index] = { ...remeasured, remeasured: true, firstPassP90Ms: result.operationP90Ms ?? result.p90Ms };
    }
  }
  if (backgroundStore) {
    const processRssBeforeAutoBackupMb = Number((process.memoryUsage.rss() / 1024 / 1024).toFixed(1));
    const automaticBackup = await measureProcessResources(() => backgroundStore.backupIfDue());
    await new Promise((resolve) => setTimeout(resolve, backupWorkerBenchIdleTimeoutMs + 250));
    const workerIdleRssMb = Number((process.memoryUsage.rss() / 1024 / 1024).toFixed(1));
    console.log("Backup worker RSS (synthetic automatic backup):", {
      processRssBeforeAutoBackupMb,
      autoBackupRssBeforeMb: automaticBackup.rssBeforeMb,
      automaticBackupPeakRssMb: automaticBackup.rssPeakMb,
      afterWorkerIdleRssMb: workerIdleRssMb,
      idleDeltaMb: Number((workerIdleRssMb - processRssBeforeAutoBackupMb).toFixed(1)),
      workerIdleTimeoutMs: backupWorkerBenchIdleTimeoutMs,
    });
  }
  console.table(results);
  if (checkMode) {
    const failures = results.filter((result) => !result.passed);
    if (failures.length > 0) {
      console.error(
        `Performance regression gate failed: ${failures
          .map((result) =>
            result.transactionP90Ms !== undefined && result.transactionP90Ms > result.transactionLimitMs
              ? `${result.case} operation p90 ${result.p90Ms}/${result.limitMs} ms, transaction p90 ${result.transactionP90Ms}/${result.transactionLimitMs} ms`
              : result.operationP90Ms === undefined
                ? `${result.case} p90 ${result.p90Ms} ms > ${result.limitMs} ms`
                : `${result.case} health p90 ${result.healthP90Ms}/${result.healthLimitMs} ms, operation p90 ${result.operationP90Ms}/${result.operationLimitMs} ms, event-loop blocking p90 ${result.eventLoopBlockP90Ms}/${result.eventLoopLimitMs} ms`,
          )
          .join("; ")}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        backupWorkerOnly
          ? `Backup worker gate passed (${backupWorkerMode}, ${sessionCount} synthetic sessions; operation totals were timed without probes, while health was probed every 10 ms in a separate pass; event-loop p90 limit ${eventLoopBlockLimitMs} ms).`
          : `Performance regression gate passed (${sessionCount} synthetic sessions; operation totals and continuous health probes used separate passes; event-loop p90 limit ${eventLoopBlockLimitMs} ms).`,
      );
    }
  }
  await closeBenchmarkApi();
  analyzedStore.close();
  heavyStore.close();
  worstText.store.close();
  worstTextDatabase.close();
  distinctPaths.store.close();
  reindexStore.close();
  backlogStore.close();
  overlapDatabase.close();
  benchStore.close();
} finally {
  try {
    await closeBenchmarkApi();
  } catch (error) {
    console.error(`Synthetic benchmark API cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  try {
    store.close();
  } catch {
    // Already closed after seeding.
  }
  rmSync(getMcpRuntimeDirectory(join(root, "synthetic-runtime")), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
