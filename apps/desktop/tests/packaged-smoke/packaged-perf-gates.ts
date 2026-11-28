import { median } from "./median.js";

// Each item is measured PACKAGED_PERF_RUNS times and the median is gated, so one slow CI run does not fail the job.
// A metric whose median misses its gate is measured PACKAGED_PERF_RUNS more times and the median of all samples is
// gated, so a slow runner has to be slow for the whole second batch as well. The gate values never change.
export const PACKAGED_PERF_RUNS = 3;

// The backend's start-up work and first GC are over by then.
export const PACKAGED_IDLE_SETTLE_MS = 5_000;

export interface PackagedPerfGates {
  readonly firstStartMs: number;
  /** Windows ACL wait after the files are in place (` acl=` plus every ` acl-failed=` tier); 0 elsewhere. */
  readonly firstStartAclMs: number;
  readonly firstStartAclPrewarmMs: number;
  readonly warmStartMs: number;
  readonly repairWindowMs: number;
  readonly quitMs: number;
  /** Whole process tree, one metric per platform (see memory-breakdown.ts). */
  readonly idleMemoryBytes: number;
  readonly backendMemoryBytes: number;
}

const MB = 1024 * 1024;

export const PACKAGED_PERF_GATES: Readonly<Record<"linux" | "darwin" | "win32", PackagedPerfGates>> = {
  // Local Xvfb medians times about three; memory is the median plus about a quarter (tree) and a half (backend).
  linux: {
    firstStartMs: 4_000,
    firstStartAclMs: 0,
    firstStartAclPrewarmMs: 0,
    warmStartMs: 2_500,
    repairWindowMs: 3_500,
    quitMs: 1_000,
    idleMemoryBytes: 360 * MB,
    backendMemoryBytes: 128 * MB,
  },
  // CI medians times about three (more for warm start and quit, which antivirus scans can triple); the ACL gate stays
  // under a cold PowerShell start. Memory is the median plus about a quarter, the backend plus about 40%.
  win32: {
    firstStartMs: 7_000,
    firstStartAclMs: 1_500,
    firstStartAclPrewarmMs: 8_000,
    warmStartMs: 2_000,
    repairWindowMs: 6_000,
    quitMs: 1_000,
    idleMemoryBytes: 330 * MB,
    backendMemoryBytes: 100 * MB,
  },
  // CI medians of the slower architecture times about three (uneven runners, Gatekeeper scans on first launch);
  // memory is the arm64 total plus about a quarter, the backend plus about 40%.
  darwin: {
    firstStartMs: 7_000,
    firstStartAclMs: 0,
    firstStartAclPrewarmMs: 0,
    warmStartMs: 4_000,
    repairWindowMs: 8_000,
    quitMs: 2_000,
    idleMemoryBytes: 440 * MB,
    backendMemoryBytes: 128 * MB,
  },
};

export type PackagedPerfMetric = keyof PackagedPerfGates;

export type PackagedPerfSamples = Record<PackagedPerfMetric, readonly number[]>;

export function metricsOverGate(samples: PackagedPerfSamples, gates: PackagedPerfGates): PackagedPerfMetric[] {
  return (Object.keys(gates) as PackagedPerfMetric[]).filter((metric) => median(samples[metric]) > gates[metric]);
}

export function withResamples(
  first: PackagedPerfSamples,
  extra: PackagedPerfSamples,
  resampled: readonly PackagedPerfMetric[],
): PackagedPerfSamples {
  const combined = { ...first };
  for (const metric of resampled) combined[metric] = [...first[metric], ...extra[metric]];
  return combined;
}

export function packagedGatesForPlatform(platform: NodeJS.Platform): PackagedPerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PACKAGED_PERF_GATES[platform];
  throw new Error(`no packaged performance gates for ${platform}`);
}
