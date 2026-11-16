/**
 * The desktop performance gates. `performance.spec.ts` measures each item `PERF_RUNS` times and compares the MEDIAN
 * with the gate here, so one slow run on a busy CI runner does not fail the job, while a real regression (every run
 * slower) does.
 *
 * Where the numbers come from (synthetic data only: an empty database made by the real store):
 * - Local Linux under xvfb (1.6.44, nine samples): cold start median about 500 ms, repair window about 550 ms, quit
 *   about 14 ms, main process about 155 MiB and backend about 94 MiB five seconds after MANAGED.
 * - CI of 1.6.44, run 43929965453, each WHOLE test case (launch, assertions, quit; the cold-start cases also hold the
 *   5 s idle settle): Windows cold start 5.9-6.0 s, so at most 1.0 s without the settle, repair window 0.69-0.76 s,
 *   second launch 0.97 s; macOS cold start 6.3-6.5 s (at most 1.5 s), repair window 1.6-2.0 s, and 4.7 s for the
 *   MANAGED test, a first launch on a cold runner. Ubuntu was 0.65-0.9 s per case in an earlier run (7602d51).
 * The gates are a median, so one cold launch out of three does not decide them. Each is about three times the slowest
 * observed time of its item (Windows: cold start 1.0 s -> 3 s, repair 0.76 s -> 3 s; macOS: cold start 1.5 s and repair
 * 2.0 s -> 5 s, whose runners are the most uneven), or more where only a whole-case upper bound is known (quit, which
 * is a few tens of milliseconds locally: Windows 2 s, macOS 3 s). That is tight enough to catch a regression that
 * doubles start-up and loose enough not to fail on runner noise. The memory gates are about twice what Linux measures:
 * they catch a leak or an accidental eager load of a large module, not a few megabytes of drift. Windows and macOS have
 * no memory numbers yet; the first CI artifacts (`desktop-perf-<os>.json`, also printed in the job log) are the evidence
 * to tighten them with.
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
    coldStartMs: 3_000,
    repairWindowMs: 3_000,
    quitMs: 2_000,
    mainMemoryBytes: 300 * MB,
    backendMemoryBytes: 300 * MB,
  },
  darwin: {
    coldStartMs: 5_000,
    repairWindowMs: 5_000,
    quitMs: 3_000,
    mainMemoryBytes: 300 * MB,
    backendMemoryBytes: 300 * MB,
  },
};

export function gatesForPlatform(platform: NodeJS.Platform): PerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PERF_GATES[platform];
  throw new Error(`no desktop performance gates for ${platform}`);
}
