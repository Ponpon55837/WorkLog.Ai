// Each item is measured PERF_RUNS times and the median is gated, so one slow CI run does not fail the job.
export const PERF_RUNS = 3;

// The backend's start-up work and first GC are over by then.
export const IDLE_SETTLE_MS = 5_000;

export interface PerfGates {
  readonly coldStartMs: number;
  readonly repairWindowMs: number;
  readonly quitMs: number;
  /** Main process working set from `app.getAppMetrics()`. */
  readonly mainMemoryBytes: number;
  /** Backend resident set: Linux VmRSS, macOS `ps` rss, Windows WorkingSet64. */
  readonly backendMemoryBytes: number;
}

const MB = 1024 * 1024;

// Times are about three times the slowest CI run of each item (quit: a whole-case upper bound); memory is about twice the Linux measurement.
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
