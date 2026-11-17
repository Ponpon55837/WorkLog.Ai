// Gates the import structure precheck (assertProjectImportFitsHeap) on request-limit bodies. Run after `pnpm build`:
//   node apps/server/bench/import-precheck.bench.mjs --check
// The precheck scans the body on the API's event loop before it goes to the worker, so its time is request latency.
// Realistic text-heavy rows must pass; the worst-case shape of tiny containers (`{},`) must be rejected.
import console from "node:console";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const checkMode = process.argv.includes("--check");
// About 5x the slowest measured scan (104 ms for the worst case); fails an order-of-magnitude regression, not CI noise.
const SCAN_LIMIT_MS = 500;
const runs = 5;
const repositoryRoot = resolve(
  process.env.WI_BACKUP_BENCH_BUILD_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url)),
);
const { MAX_PROJECT_IMPORT_BYTES, RequestBodyError, assertProjectImportFitsHeap } = await import(
  pathToFileURL(join(repositoryRoot, "apps", "server", "dist", "http.js")).href
);

function repeatToLimit(unit) {
  const unitBytes = Buffer.from(unit, "utf8");
  const body = Buffer.allocUnsafe(Math.floor(MAX_PROJECT_IMPORT_BYTES / unitBytes.length) * unitBytes.length);
  for (let offset = 0; offset < body.length; offset += unitBytes.length) unitBytes.copy(body, offset);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function scan(body) {
  const started = performance.now();
  let rejected = false;
  try {
    assertProjectImportFitsHeap(body);
  } catch (error) {
    if (!(error instanceof RequestBodyError) || error.statusCode !== 413) throw error;
    rejected = true;
  }
  return { rejected, ms: performance.now() - started };
}

const cases = [
  {
    name: "text-heavy rows (50 MiB)",
    body: repeatToLimit(`{"id":"x","summary":"${"文字 ".repeat(60)}"},`),
    rejects: false,
  },
  { name: "worst case {}, (50 MiB)", body: repeatToLimit("{},"), rejects: true },
];

const results = [];
for (const { name, body, rejects } of cases) {
  scan(body);
  const timings = [];
  let verdict = true;
  for (let run = 0; run < runs; run += 1) {
    const { rejected, ms } = scan(body);
    if (rejected !== rejects) verdict = false;
    timings.push(ms);
  }
  timings.sort((left, right) => left - right);
  const medianMs = timings[Math.floor(timings.length / 2)];
  const maxMs = timings[timings.length - 1];
  results.push({
    case: name,
    bytes: body.byteLength,
    medianMs: Number(medianMs.toFixed(1)),
    maxMs: Number(maxMs.toFixed(1)),
    limitMs: SCAN_LIMIT_MS,
    expected: rejects ? "rejected" : "accepted",
    verdictOk: verdict,
    passed: verdict && maxMs <= SCAN_LIMIT_MS,
  });
}

console.table(results);
if (checkMode) {
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    console.error(`Import precheck gate failed: ${failures.map((result) => result.case).join(", ")}`);
    process.exitCode = 1;
  }
}
