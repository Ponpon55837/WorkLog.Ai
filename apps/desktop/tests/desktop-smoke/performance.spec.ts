import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  healthProofIsValid,
  launchApp,
  portIsFree,
  processIsAlive,
  readSnapshot,
  removeSandbox,
  type MainSnapshot,
  type Sandbox,
} from "./helpers.js";
import { gatesForPlatform, IDLE_SETTLE_MS, PERF_RUNS, type PerfGates } from "./perf-gates.js";

/**
 * Desktop performance: cold start, the repair window, quit and idle memory, each measured `PERF_RUNS` times on
 * synthetic data. The medians are checked against `perf-gates.ts` and written to `perf-results/desktop-perf-<os>.json`
 * (CI uploads it) and printed to stdout. Polling is every 10 ms, so a time is at most that much late.
 */

const here = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = resolve(here, "..", "..", "perf-results");
const POLL_MS = 10;
const STEP_TIMEOUT_MS = 60_000;

type Metric = keyof PerfGates;

interface MetricResult {
  readonly samples: number[];
  readonly median: number;
  readonly gate: number;
  readonly unit: "ms" | "bytes";
  readonly passed: boolean;
}

const samples: Record<Metric, number[]> = {
  coldStartMs: [],
  repairWindowMs: [],
  quitMs: [],
  mainMemoryBytes: [],
  backendMemoryBytes: [],
};

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Calls `read` every POLL_MS and returns its first defined value; a timeout says what was last seen. */
async function pollUntil<T>(
  read: () => Promise<T | undefined>,
  what: string,
  lastSeen: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`${what} did not happen within ${STEP_TIMEOUT_MS} ms; last seen: ${lastSeen()}`);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The resident memory of another process, in bytes, the way each platform reports it. */
function residentBytes(pid: number): number {
  if (process.platform === "linux") {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (!match?.[1]) throw new Error(`no VmRSS for ${pid}`);
    return Number(match[1]) * 1024;
  }
  if (process.platform === "darwin") {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
  }
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
    { encoding: "utf8" },
  );
  return Number(output.trim());
}

async function mainProcessBytes(launched: ElectronApplication): Promise<number> {
  const kilobytes = await launched.evaluate(({ app: electron }) => {
    const browser = electron.getAppMetrics().find((metric) => metric.type === "Browser");
    return browser?.memory.workingSetSize ?? null;
  });
  // A missing metric fails the run: a zero would pass every memory gate and hide a regression.
  if (kilobytes === null || kilobytes <= 0) throw new Error("app.getAppMetrics() has no Browser process memory");
  return kilobytes * 1024;
}

for (let run = 1; run <= PERF_RUNS; run += 1) {
  test(`cold start, idle memory and quit (run ${run} of ${PERF_RUNS})`, async () => {
    sandbox = await createSandbox({ withDatabase: true });
    const started = performance.now();
    app = await launchApp(sandbox);
    const launched = app;
    let last: { snapshot?: MainSnapshot; proof?: boolean } = {};
    const managed = await pollUntil(
      async () => {
        const snapshot: MainSnapshot = await readSnapshot(launched);
        const backend = snapshot.backend;
        last = { snapshot };
        if (snapshot.owner !== "MANAGED" || !backend) return undefined;
        const proof = await healthProofIsValid(backend.port, backend.runId);
        last = { snapshot, proof };
        return proof ? backend : undefined;
      },
      "MANAGED with a passing health proof",
      () => JSON.stringify(last),
    );
    samples.coldStartMs.push(performance.now() - started);

    await sleep(IDLE_SETTLE_MS);
    samples.mainMemoryBytes.push(await mainProcessBytes(launched));
    samples.backendMemoryBytes.push(residentBytes(managed.pid));

    const port = managed.port;
    const closed = launched.waitForEvent("close", { timeout: STEP_TIMEOUT_MS });
    const quitting = performance.now();
    await launched.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
    await pollUntil(
      async () => (!processIsAlive(managed.pid) && (await portIsFree(port)) ? true : undefined),
      "the backend gone and its port free",
    );
    samples.quitMs.push(performance.now() - quitting);
    await closed;
  });
}

for (let run = 1; run <= PERF_RUNS; run += 1) {
  test(`repair window for a missing database (run ${run} of ${PERF_RUNS})`, async () => {
    sandbox = await createSandbox({ withDatabase: false });
    const started = performance.now();
    app = await launchApp(sandbox);
    const window = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
    await window.locator('[data-id="choose-database"]').waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    samples.repairWindowMs.push(performance.now() - started);
  });
}

test("the medians stay inside the gates and are written for CI", () => {
  const gates = gatesForPlatform(process.platform);
  const results = {} as Record<Metric, MetricResult>;
  for (const metric of Object.keys(samples) as Metric[]) {
    const values = samples[metric];
    expect(values.length, `${metric} was measured ${PERF_RUNS} times`).toBe(PERF_RUNS);
    const value = median(values);
    results[metric] = {
      samples: values.map((sample) => Math.round(sample)),
      median: Math.round(value),
      gate: gates[metric],
      unit: metric.endsWith("Bytes") ? "bytes" : "ms",
      passed: value <= gates[metric],
    };
  }
  mkdirSync(resultsDirectory, { recursive: true });
  const report = {
    platform: process.platform,
    arch: process.arch,
    runs: PERF_RUNS,
    idleSettleMs: IDLE_SETTLE_MS,
    data: "synthetic",
    measuredAt: new Date().toISOString(),
    metrics: results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(resultsDirectory, `desktop-perf-${process.platform}.json`), json);
  // Also in the log: the CI artifact is not always reachable, the job log is.
  process.stdout.write(`desktop-perf-${process.platform}.json\n${json}`);
  for (const [metric, result] of Object.entries(results)) {
    expect(result.median, `${metric} median ${result.median} ${result.unit} (gate ${result.gate})`).toBeLessThanOrEqual(
      result.gate,
    );
  }
});
