import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSandbox,
  logLines,
  packagedExecutable,
  pollUntil,
  portIsFree,
  processIsAlive,
  processTree,
  programDirectory,
  readLog,
  removeSandbox,
  runToExit,
  sleep,
  startApp,
  stopApp,
  waitForLog,
  waitForManaged,
  type PackagedSandbox,
  type RunningApp,
} from "./helpers.js";
import { formatBreakdown, measureMemory, median, medianBytesByRole, type MemoryBreakdown } from "./memory-breakdown.js";
import {
  PACKAGED_IDLE_SETTLE_MS,
  PACKAGED_PERF_RUNS,
  packagedGatesForPlatform,
  type PackagedPerfGates,
} from "./packaged-perf-gates.js";

/**
 * Packaged-App performance: first start (with the runtime install), warm start, the repair window, `--quit` and idle
 * memory of the whole process tree (also split by process role, see memory-breakdown.ts), each measured
 * `PACKAGED_PERF_RUNS` times on synthetic data. The medians are checked against `packaged-perf-gates.ts`, written to
 * `perf-results/packaged-perf-<os>.json` and printed to stdout (the CI log is readable where the artifact is not).
 * Polling is every 10 ms, so a time is at most that much late.
 */

const here = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = resolve(here, "..", "..", "perf-results");

type Metric = keyof PackagedPerfGates;

interface MetricResult {
  readonly samples: number[];
  readonly median: number;
  readonly gate: number;
  readonly unit: "ms" | "bytes";
  readonly passed: boolean;
}

const samples: Record<Metric, number[]> = {
  firstStartMs: [],
  firstStartAclMs: [],
  firstStartAclPrewarmMs: [],
  warmStartMs: [],
  repairWindowMs: [],
  quitMs: [],
  idleMemoryBytes: [],
  backendMemoryBytes: [],
};

const idleBreakdowns: MemoryBreakdown[] = [];

let sandbox: PackagedSandbox | undefined;
let app: RunningApp | undefined;

/**
 * The ACL wait of a `runtime installed` line: ` acl=<tier> <ms> ms` plus every ` acl-failed=<tier> <ms> ms`. With a
 * prewarmed PowerShell that is only the time after the files were in place; the start-up that overlapped the copy is
 * `aclPrewarmMilliseconds`, which is not part of this sum.
 */
function aclMilliseconds(line: string): number {
  let total = 0;
  for (const [, ms] of line.matchAll(/ acl(?:-failed)?=[\w-]+ (\d+(?:\.\d+)?) ms/g)) total += Number(ms);
  return total;
}

/** The start-up time of the prewarmed PowerShell of a `runtime installed` line (` acl-prewarm=<ms> ms`); 0 when none ran. */
function aclPrewarmMilliseconds(line: string): number {
  return Number(/ acl-prewarm=(\d+(?:\.\d+)?) ms/.exec(line)?.[1] ?? 0);
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  if (sandbox) await stopApp(sandbox, app);
  app = undefined;
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
});

for (let run = 1; run <= PACKAGED_PERF_RUNS; run += 1) {
  test(`first start, warm start, idle memory and quit (run ${run} of ${PACKAGED_PERF_RUNS})`, async () => {
    sandbox = await createSandbox({ withDatabase: true });

    let started = performance.now();
    app = startApp(sandbox);
    await waitForManaged(sandbox);
    samples.firstStartMs.push(performance.now() - started);
    await stopApp(sandbox, app);
    const installed = logLines(sandbox, /\[shell\] runtime installed /);
    expect(installed).toHaveLength(1);
    samples.firstStartAclMs.push(aclMilliseconds(installed[0] ?? ""));
    samples.firstStartAclPrewarmMs.push(aclPrewarmMilliseconds(installed[0] ?? ""));

    const since = readLog(sandbox).length;
    started = performance.now();
    app = startApp(sandbox);
    const backend = await waitForManaged(sandbox, since);
    samples.warmStartMs.push(performance.now() - started);
    expect(readLog(sandbox).slice(since)).toMatch(/\[shell\] runtime already-current /);

    await sleep(PACKAGED_IDLE_SETTLE_MS);
    const tree = processTree(app.pid);
    expect(
      tree.some((candidate) => candidate.pid === backend.pid),
      "the backend is in the process tree",
    ).toBe(true);
    // `--background` (the default launch): no Dashboard, so no browser is in the tree; whatever else is not the App's is
    // reported as excluded by name, never counted.
    expect(logLines(sandbox, /\[shell\] dashboard opened/), "a background launch opens no Dashboard").toEqual([]);
    const breakdown = measureMemory(
      tree,
      { mainPid: app.pid, backendPid: backend.pid },
      { programDirectory: programDirectory(packagedExecutable()), runtimeDirectory: join(sandbox.userData, "runtime") },
    );
    idleBreakdowns.push(breakdown);
    samples.idleMemoryBytes.push(breakdown.totalBytes);
    samples.backendMemoryBytes.push(breakdown.byRole.backend.bytes);
    process.stdout.write(`${formatBreakdown(breakdown)}\n`);

    started = performance.now();
    const quit = runToExit(sandbox, ["--quit"], 60_000);
    await pollUntil(
      async () => (!processIsAlive(backend.pid) && (await portIsFree(backend.port)) ? true : undefined),
      "the backend gone and its port free",
    );
    samples.quitMs.push(performance.now() - started);
    expect((await quit).code).toBe(0);
    await app.exited;
  });
}

for (let run = 1; run <= PACKAGED_PERF_RUNS; run += 1) {
  test(`repair window for a missing database (run ${run} of ${PACKAGED_PERF_RUNS})`, async () => {
    sandbox = await createSandbox({ withDatabase: false });
    const started = performance.now();
    // The repair window is what an interactive launch shows; a background launch sends a notification instead.
    app = startApp(sandbox, [], { interactive: true });
    await waitForLog(sandbox, /\[shell\] repair window shown/);
    samples.repairWindowMs.push(performance.now() - started);
  });
}

/** The nearest-rank 95th percentile (with three runs it is the slowest one). */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/** One compact line for the job log; the numbers are the ones the gates use, only rounded for reading. */
function perfSummary(results: Record<Metric, MetricResult>): string {
  const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  const repair = results.repairWindowMs;
  return (
    `[perf summary] ${process.platform} ` +
    `repairWindowMs median=${repair.median} p95=${p95(repair.samples)} (gate=${repair.gate}) | ` +
    `coldStartMs median=${results.firstStartMs.median} (warmStartMs median=${results.warmStartMs.median}) | ` +
    `quitMs median=${results.quitMs.median} | ` +
    `idleRssMiB median=${mib(results.idleMemoryBytes.median)} backend=${mib(results.backendMemoryBytes.median)}`
  );
}

test("the medians stay inside the gates and are written for CI", () => {
  const gates = packagedGatesForPlatform(process.platform);
  const results = {} as Record<Metric, MetricResult>;
  for (const metric of Object.keys(samples) as Metric[]) {
    const values = samples[metric];
    expect(values.length, `${metric} was measured ${PACKAGED_PERF_RUNS} times`).toBe(PACKAGED_PERF_RUNS);
    const value = median(values);
    results[metric] = {
      samples: values.map((sample) => Math.round(sample)),
      median: Math.round(value),
      gate: gates[metric],
      unit: metric.endsWith("Bytes") ? "bytes" : "ms",
      passed: value <= gates[metric],
    };
  }
  const report = {
    platform: process.platform,
    arch: process.arch,
    runs: PACKAGED_PERF_RUNS,
    idleSettleMs: PACKAGED_IDLE_SETTLE_MS,
    data: "synthetic",
    measuredAt: new Date().toISOString(),
    metrics: results,
    idleMemory: {
      metric: idleBreakdowns[0]?.metric,
      medianBytesByRole: medianBytesByRole(idleBreakdowns),
      medianRssBytes: Math.round(median(idleBreakdowns.map((run) => run.totalRssBytes))),
      runs: idleBreakdowns,
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(join(resultsDirectory, `packaged-perf-${process.platform}.json`), json);
  process.stdout.write(`packaged-perf-${process.platform}.json\n${json}`);
  process.stdout.write(`${perfSummary(results)}\n`);
  for (const [metric, result] of Object.entries(results)) {
    expect(result.median, `${metric} median ${result.median} ${result.unit} (gate ${result.gate})`).toBeLessThanOrEqual(
      result.gate,
    );
  }
});
