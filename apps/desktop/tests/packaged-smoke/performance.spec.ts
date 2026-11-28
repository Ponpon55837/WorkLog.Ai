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
  metricsOverGate,
  packagedGatesForPlatform,
  withResamples,
  type PackagedPerfMetric,
  type PackagedPerfSamples,
} from "./packaged-perf-gates.js";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = resolve(here, "..", "..", "perf-results");

type Metric = PackagedPerfMetric;

interface MetricResult {
  readonly samples: number[];
  readonly median: number;
  readonly gate: number;
  readonly unit: "ms" | "bytes";
  readonly resampled: boolean;
  readonly passed: boolean;
}

type MutableSamples = Record<Metric, number[]>;

function emptySamples(): MutableSamples {
  return {
    firstStartMs: [],
    firstStartAclMs: [],
    firstStartAclPrewarmMs: [],
    warmStartMs: [],
    repairWindowMs: [],
    quitMs: [],
    idleMemoryBytes: [],
    backendMemoryBytes: [],
  };
}

const samples = emptySamples();
const idleBreakdowns: MemoryBreakdown[] = [];

let sandbox: PackagedSandbox | undefined;
let app: RunningApp | undefined;

function aclMilliseconds(line: string): number {
  let total = 0;
  for (const [, ms] of line.matchAll(/ acl(?:-failed)?=[\w-]+ (\d+(?:\.\d+)?) ms/g)) total += Number(ms);
  return total;
}

function aclPrewarmMilliseconds(line: string): number {
  return Number(/ acl-prewarm=(\d+(?:\.\d+)?) ms/.exec(line)?.[1] ?? 0);
}

async function cleanUp(): Promise<void> {
  if (sandbox) await stopApp(sandbox, app);
  app = undefined;
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
}

async function measureStartCycle(into: MutableSamples): Promise<void> {
  sandbox = await createSandbox({ withDatabase: true });

  let started = performance.now();
  app = startApp(sandbox);
  await waitForManaged(sandbox);
  into.firstStartMs.push(performance.now() - started);
  await stopApp(sandbox, app);
  const installed = logLines(sandbox, /\[shell\] runtime installed /);
  expect(installed).toHaveLength(1);
  into.firstStartAclMs.push(aclMilliseconds(installed[0] ?? ""));
  into.firstStartAclPrewarmMs.push(aclPrewarmMilliseconds(installed[0] ?? ""));

  const since = readLog(sandbox).length;
  started = performance.now();
  app = startApp(sandbox);
  const backend = await waitForManaged(sandbox, since);
  into.warmStartMs.push(performance.now() - started);
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
  into.idleMemoryBytes.push(breakdown.totalBytes);
  into.backendMemoryBytes.push(breakdown.byRole.backend.bytes);
  process.stdout.write(`${formatBreakdown(breakdown)}\n`);

  started = performance.now();
  const quit = runToExit(sandbox, ["--quit"], 60_000);
  await pollUntil(
    async () => (!processIsAlive(backend.pid) && (await portIsFree(backend.port)) ? true : undefined),
    "the backend gone and its port free",
  );
  into.quitMs.push(performance.now() - started);
  expect((await quit).code).toBe(0);
  await app.exited;
}

async function measureRepairWindow(into: MutableSamples): Promise<void> {
  sandbox = await createSandbox({ withDatabase: false });
  const started = performance.now();
  // The repair window is what an interactive launch shows; a background launch sends a notification instead.
  app = startApp(sandbox, [], { interactive: true });
  await waitForLog(sandbox, /\[shell\] repair window shown/);
  into.repairWindowMs.push(performance.now() - started);
}

test.describe.configure({ mode: "serial" });

test.afterEach(cleanUp);

for (let run = 1; run <= PACKAGED_PERF_RUNS; run += 1) {
  test(`first start, warm start, idle memory and quit (run ${run} of ${PACKAGED_PERF_RUNS})`, async () => {
    await measureStartCycle(samples);
  });
}

for (let run = 1; run <= PACKAGED_PERF_RUNS; run += 1) {
  test(`repair window for a missing database (run ${run} of ${PACKAGED_PERF_RUNS})`, async () => {
    await measureRepairWindow(samples);
  });
}

/** One more batch of the same size for the metrics that missed their gate; the others keep their first batch. */
async function resample(missed: readonly Metric[]): Promise<PackagedPerfSamples> {
  const extra = emptySamples();
  const scenarios: [(into: MutableSamples) => Promise<void>, boolean][] = [
    [measureStartCycle, missed.some((metric) => metric !== "repairWindowMs")],
    [measureRepairWindow, missed.includes("repairWindowMs")],
  ];
  for (const [scenario, needed] of scenarios) {
    if (!needed) continue;
    for (let run = 1; run <= PACKAGED_PERF_RUNS; run += 1) {
      try {
        await scenario(extra);
      } finally {
        await cleanUp();
      }
    }
  }
  return withResamples(samples, extra, missed);
}

/** The nearest-rank 95th percentile (with three runs it is the slowest one). */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/** One compact line for the job log; the numbers are the ones the gates use, only rounded for reading. */
function perfSummary(results: Record<Metric, MetricResult>, resampled: readonly Metric[]): string {
  const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  const repair = results.repairWindowMs;
  return (
    `[perf summary] ${process.platform} ` +
    `repairWindowMs median=${repair.median} p95=${p95(repair.samples)} (gate=${repair.gate}) | ` +
    `coldStartMs median=${results.firstStartMs.median} (warmStartMs median=${results.warmStartMs.median}) | ` +
    `quitMs median=${results.quitMs.median} | ` +
    `idleRssMiB median=${mib(results.idleMemoryBytes.median)} backend=${mib(results.backendMemoryBytes.median)} | ` +
    `resampled=${resampled.length > 0 ? resampled.join(",") : "none"}`
  );
}

/** Every sample of every metric, so a slow job can be told from a regression without the JSON. */
function sampleLines(results: Record<Metric, MetricResult>): string {
  return Object.entries(results)
    .map(([metric, result]) => `[perf samples] ${metric} ${result.unit} [${result.samples.join(", ")}]`)
    .join("\n");
}

test("the medians stay inside the gates and are written for CI", async () => {
  test.setTimeout(600_000);
  const gates = packagedGatesForPlatform(process.platform);
  const missed = metricsOverGate(samples, gates);
  const collected = missed.length > 0 ? await resample(missed) : samples;
  const results = {} as Record<Metric, MetricResult>;
  for (const metric of Object.keys(samples) as Metric[]) {
    const values = collected[metric];
    const resampled = missed.includes(metric);
    expect(values.length, `${metric} was measured ${resampled ? 2 : 1} x ${PACKAGED_PERF_RUNS} times`).toBe(
      resampled ? 2 * PACKAGED_PERF_RUNS : PACKAGED_PERF_RUNS,
    );
    const value = median(values);
    results[metric] = {
      samples: values.map((sample) => Math.round(sample)),
      median: Math.round(value),
      gate: gates[metric],
      unit: metric.endsWith("Bytes") ? "bytes" : "ms",
      resampled,
      passed: value <= gates[metric],
    };
  }
  const report = {
    platform: process.platform,
    arch: process.arch,
    runs: PACKAGED_PERF_RUNS,
    resampled: missed,
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
  process.stdout.write(`${sampleLines(results)}\n${perfSummary(results, missed)}\n`);
  for (const [metric, result] of Object.entries(results)) {
    expect(result.median, `${metric} median ${result.median} ${result.unit} (gate ${result.gate})`).toBeLessThanOrEqual(
      result.gate,
    );
  }
});
