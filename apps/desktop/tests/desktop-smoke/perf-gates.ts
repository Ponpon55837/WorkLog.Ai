/**
 * The desktop performance gates. `performance.spec.ts` measures each item `PERF_RUNS` times and compares the MEDIAN
 * with the gate here, so one slow run on a busy CI runner does not fail the job, while a real regression (every run
 * slower) does.
 *
 * Where the numbers come from (synthetic data only: an empty database made by the real store):
 * - Local Linux under xvfb (1.6.44, nine samples): cold start median about 500 ms, repair window about 550 ms, quit
 *   about 14 ms, main process about 155 MiB and backend about 94 MiB five seconds after MANAGED.
 * - CI smoke of 7602d51, each whole test case (launch, assertions and quit): Ubuntu 0.65-0.9 s, Windows 1.0-2.6 s,
 *   macOS 1.2-9.1 s. macOS runners are the slowest and the most uneven, Windows the next.
 * The Linux and Windows time gates are at least three times the slowest whole test case seen there. The macOS ones
 * (15 s) are above its single slowest case (9.1 s, a first launch on a cold runner) and over ten times its typical
 * one, because the gate is a median: one cold launch out of three does not decide it. So a gate fails on a regression
 * of that order and not on runner noise. The memory gates are about twice what Linux measures: they catch a
 * leak or an accidental eager load of a large module, not a few megabytes of drift. Windows and macOS have no local
 * numbers yet; the first CI artifacts (`desktop-perf-<os>.json`) are the evidence to tighten them with.
 */
export const PERF_RUNS = 3;

/** How long after MANAGED the idle memory is read: the backend's start-up work and first GC are over by then. */
export const IDLE_SETTLE_MS = 5_000;

export interface PerfGates {
  /** `electron.launch` to MANAGED with this test's own health proof passing. */
  readonly coldStartMs: number;
  /** `electron.launch` to the repair window showing its "choose database" button, for a missing database. */
  readonly repairWindowMs: number;
  /** Asking the App to quit to the backend process gone and its port free. */
  readonly quitMs: number;
  /** The main (browser) process working set, from `app.getAppMetrics()`. */
  readonly mainMemoryBytes: number;
  /** The backend child's resident set (Linux VmRSS, macOS `ps` rss, Windows WorkingSet64). */
  readonly backendMemoryBytes: number;
}

const MB = 1024 * 1024;

export const PERF_GATES: Readonly<Record<"linux" | "darwin" | "win32", PerfGates>> = {
  linux: {
    coldStartMs: 3_000,
    repairWindowMs: 3_000,
    quitMs: 2_000,
    mainMemoryBytes: 300 * MB,
    backendMemoryBytes: 300 * MB,
  },
  win32: {
    coldStartMs: 8_000,
    repairWindowMs: 8_000,
    quitMs: 5_000,
    mainMemoryBytes: 300 * MB,
    backendMemoryBytes: 300 * MB,
  },
  darwin: {
    coldStartMs: 15_000,
    repairWindowMs: 15_000,
    quitMs: 5_000,
    mainMemoryBytes: 300 * MB,
    backendMemoryBytes: 300 * MB,
  },
};

export function gatesForPlatform(platform: NodeJS.Platform): PerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PERF_GATES[platform];
  throw new Error(`no desktop performance gates for ${platform}`);
}
