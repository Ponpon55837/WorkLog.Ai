import console from "node:console";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { performance } from "node:perf_hooks";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const childIndex = args.indexOf("--child");
// About 4x the measured development p90: catches an order-of-magnitude regression on a slow CI machine.
const EXPORT_P90_LIMIT_MS = Number(process.env.WI_WORKER_COLD_START_P90_MS ?? 400);

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function runChild(databasePath) {
  const importStart = performance.now();
  const { BackupWorkerClient } = await import(
    pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "backup-worker-client.js")).href
  );
  const importMs = performance.now() - importStart;
  const worker = new BackupWorkerClient(databasePath);
  const directory = mkdtempSync(join(dirname(databasePath), "export-"));
  const target = join(directory, "export.json");
  const exportStart = performance.now();
  await worker.exportProjectData({ type: "all" }, target);
  const exportMs = performance.now() - exportStart;
  await worker.close();
  const hash = createHash("sha256").update(readFileSync(target)).digest("hex");
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ importMs, exportMs, hash }));
}

async function seedDatabase(root) {
  const { WorkIntelligenceStore } = await import(
    pathToFileURL(join(repositoryRoot, "packages", "storage", "dist", "index.js")).href
  );
  const databasePath = join(root, "synthetic.sqlite");
  const projectRoot = join(root, "synthetic-project");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(databasePath);
  const project = store.addProject("Cold start fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  for (let index = 0; index < 20; index += 1) {
    store.finalizeSession({
      projectRoot,
      idempotencyKey: `cold-start-session-${index}`,
      title: `Synthetic Session ${index}`,
      summary: `Synthetic data for the worker cold-start benchmark, number ${index}.`,
      changedFiles: [`src/file-${index}.ts`],
      verification: { status: "passed" },
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    });
  }
  store.close();
  return databasePath;
}

if (childIndex >= 0) {
  await runChild(args[childIndex + 1]);
} else {
  const runs = Number(args.find((argument) => /^\d+$/.test(argument)) ?? 15);
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-worker-cold-start-"));
  try {
    const databasePath = await seedDatabase(root);
    const results = [];
    for (let run = 0; run < runs + 1; run += 1) {
      const start = performance.now();
      const child = spawnSync(process.execPath, [scriptPath, "--child", databasePath], { encoding: "utf8" });
      const processMs = performance.now() - start;
      if (child.status !== 0) throw new Error(`Cold-start child failed: ${child.stderr}`);
      // The first run only warms the file cache.
      if (run > 0) results.push({ ...JSON.parse(child.stdout), processMs });
    }
    const hashes = new Set(results.map((result) => result.hash));
    const summary = {};
    for (const key of ["importMs", "exportMs", "processMs"]) {
      const sorted = results.map((result) => result[key]).sort((a, b) => a - b);
      summary[key] = { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
      console.log(
        `${key.padEnd(10)} median ${summary[key].median.toFixed(1)} ms  p90 ${summary[key].p90.toFixed(1)} ms  (${runs} runs)`,
      );
    }
    if (args.includes("--hash")) console.log(`export sha256 (differs per run: exportedAt) ${hashes.size} distinct`);
    if (checkMode && summary.exportMs.p90 > EXPORT_P90_LIMIT_MS) {
      throw new Error(
        `Worker cold-start export p90 ${summary.exportMs.p90.toFixed(0)} ms exceeds ${EXPORT_P90_LIMIT_MS} ms.`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
