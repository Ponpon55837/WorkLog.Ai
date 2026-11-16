/**
 * The packaged-App performance gates. `performance.spec.ts` measures each item `PACKAGED_PERF_RUNS` times and compares the
 * MEDIAN with the gate here, so one slow run on a busy CI runner does not fail the job while a real regression does.
 *
 * What is measured, on the packaged App with synthetic data (an empty database made by the real store):
 * - `firstStartMs`: a fresh userData to MANAGED with `GET /api/health` 200. It includes installing the bundled runtime
 *   (about 135 MB copied and hashed), so it is the slowest item and the one antivirus or a slow disk moves most.
 * - `warmStartMs`: the same with the runtime already installed (`runtime already-current`): what a user waits for at
 *   every login.
 * - `repairWindowMs`: a missing database to the `repair window shown` log line.
 * - `quitMs`: spawning `<exe> --quit` to the backend gone and its port free. This is what the installer waits for.
 * - `idleMemoryBytes`: five seconds after MANAGED, the resident memory summed over the whole process tree: the main
 *   process, every Electron helper (GPU, network, renderer) and the backend. Windows sums CIM `WorkingSetSize`, which
 *   counts shared pages once per process, so it reads higher than the real footprint; macOS and Linux sum `ps` rss.
 *
 * Where the gates come from:
 * - linux: local numbers of this stage (Xvfb, nine samples) times about three, so a run that is three times slower than
 *   the development machine still passes and a real regression (a second runtime copy, an eager load) does not.
 * - win32 and darwin: no packaged measurement exists yet. They start from the unpackaged CI evidence of 1.6.44 (run
 *   43929965453: Windows cold start at most 1.0 s, macOS at most 1.5 s, both without the runtime install; see
 *   desktop-smoke/perf-gates.ts), multiplied for the larger packaged App (asar integrity, a 135 MB runtime on disk) and,
 *   for the first start, for the install itself. The first CI run's numbers (printed in the job log and uploaded as
 *   `desktop-packaged-perf-<os>.json`) must tighten these.
 */
export const PACKAGED_PERF_RUNS = 3;

/** How long after MANAGED the idle memory is read: the backend's start-up work and first GC are over by then. */
export const PACKAGED_IDLE_SETTLE_MS = 5_000;

export interface PackagedPerfGates {
  readonly firstStartMs: number;
  readonly warmStartMs: number;
  readonly repairWindowMs: number;
  readonly quitMs: number;
  readonly idleMemoryBytes: number;
}

const MB = 1024 * 1024;

export const PACKAGED_PERF_GATES: Readonly<Record<"linux" | "darwin" | "win32", PackagedPerfGates>> = {
  // Local medians: first 1153 ms, warm 672 ms, repair 1075 ms, quit 168 ms, idle tree 614 MiB.
  linux: {
    firstStartMs: 4_000,
    warmStartMs: 2_500,
    repairWindowMs: 3_500,
    quitMs: 1_000,
    idleMemoryBytes: 2000 * MB,
  },
  // Provisional (see above): 6 s warm is 6x the unpackaged Windows cold start; 30 s first start leaves room for the
  // 135 MB runtime copy under real-time antivirus on a CI runner.
  win32: {
    firstStartMs: 30_000,
    warmStartMs: 6_000,
    repairWindowMs: 6_000,
    quitMs: 4_000,
    idleMemoryBytes: 2000 * MB,
  },
  // Provisional (see above): macOS runners are the slowest and most uneven, and the first launch of an unseen binary
  // pays Gatekeeper/XProtect scanning.
  darwin: {
    firstStartMs: 30_000,
    warmStartMs: 8_000,
    repairWindowMs: 8_000,
    quitMs: 5_000,
    idleMemoryBytes: 2000 * MB,
  },
};

export function packagedGatesForPlatform(platform: NodeJS.Platform): PackagedPerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PACKAGED_PERF_GATES[platform];
  throw new Error(`no packaged performance gates for ${platform}`);
}
