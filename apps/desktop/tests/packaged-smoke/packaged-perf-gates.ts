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
 * - `idleMemoryBytes`: five seconds after MANAGED, the memory summed over the whole process tree: the main process, every
 *   Electron helper (GPU, network service, zygote, renderer) and the backend. One metric per platform, the same for every
 *   process (see memory-breakdown.ts): Linux sums PSS (`/proc/<pid>/smaps_rollup`, shared pages split among the processes
 *   that map them, RSS when it cannot be read); macOS sums `ps` RSS; Windows sums CIM `WorkingSetSize`. RSS and working
 *   set count shared pages once per process, so they read higher than the real footprint (on Linux about 1.8 times the
 *   PSS). The per-role split (main, gpu, renderer, utility, zygote, backend) is written to the JSON report beside it.
 * - `backendMemoryBytes`: the same metric for the backend (bundled Node) alone, so a backend regression is not hidden
 *   inside the Chromium total.
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
  readonly backendMemoryBytes: number;
}

const MB = 1024 * 1024;

export const PACKAGED_PERF_GATES: Readonly<Record<"linux" | "darwin" | "win32", PackagedPerfGates>> = {
  // Local medians (Xvfb, three runs): first 922 ms, warm 557 ms, repair 1155 ms, quit 161 ms, idle tree 292 MiB PSS
  // (538 MiB RSS), backend 87 MiB PSS. Before the memory work the tree was 352 MiB PSS (662 MiB RSS), 28 MiB of it a
  // spare renderer nothing used. The memory gates are the medians plus about a quarter (360 MiB) and a half (128 MiB),
  // since the main process alone moved by up to 30 MiB between runs on a loaded machine. A regression of about 70 MiB
  // (one more Chromium helper) fails the total; smaller ones show in the per-role JSON.
  linux: {
    firstStartMs: 4_000,
    warmStartMs: 2_500,
    repairWindowMs: 3_500,
    quitMs: 1_000,
    idleMemoryBytes: 360 * MB,
    backendMemoryBytes: 128 * MB,
  },
  // Provisional (see above). Memory: nothing was measured on Windows yet; 1 GiB is about twice the Linux RSS sum and 192
  // MiB twice the Linux backend RSS, and the first CI JSON (with the per-role split) must tighten both. Times: 6 s warm is 6x the unpackaged Windows cold start; 30 s first start leaves room for the
  // 135 MB runtime copy under real-time antivirus on a CI runner.
  win32: {
    firstStartMs: 30_000,
    warmStartMs: 6_000,
    repairWindowMs: 6_000,
    quitMs: 4_000,
    idleMemoryBytes: 1024 * MB,
    backendMemoryBytes: 192 * MB,
  },
  // Provisional (see above), memory as for Windows. Times: macOS runners are the slowest and most uneven, and the first launch of an unseen binary
  // pays Gatekeeper/XProtect scanning.
  darwin: {
    firstStartMs: 30_000,
    warmStartMs: 8_000,
    repairWindowMs: 8_000,
    quitMs: 5_000,
    idleMemoryBytes: 1024 * MB,
    backendMemoryBytes: 192 * MB,
  },
};

export function packagedGatesForPlatform(platform: NodeJS.Platform): PackagedPerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PACKAGED_PERF_GATES[platform];
  throw new Error(`no packaged performance gates for ${platform}`);
}
