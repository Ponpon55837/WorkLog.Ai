/**
 * The packaged-App performance gates. `performance.spec.ts` measures each item `PACKAGED_PERF_RUNS` times and compares the
 * MEDIAN with the gate here, so one slow run on a busy CI runner does not fail the job while a real regression does.
 *
 * What is measured, on the packaged App with synthetic data (an empty database made by the real store):
 * - `firstStartMs`: a fresh userData to MANAGED with `GET /api/health` 200. It includes installing the bundled runtime
 *   (about 135 MB copied and hashed), so it is the slowest item and the one antivirus or a slow disk moves most.
 * - `firstStartAclMs`: the Windows ACL reads of that first start, summed from the `runtime installed` log line (` acl=`
 *   plus every ` acl-failed=` tier), so a slow PowerShell start shows on its own. macOS and Linux read no ACL: 0.
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
 * - win32 and darwin: the medians of packaged CI runs of 1.6.45 (printed in the job log and uploaded as
 *   `desktop-packaged-perf-<os>.json`), with the margin each platform's runners need; the comment above each platform
 *   names the run its numbers come from.
 */
export const PACKAGED_PERF_RUNS = 3;

/** How long after MANAGED the idle memory is read: the backend's start-up work and first GC are over by then. */
export const PACKAGED_IDLE_SETTLE_MS = 5_000;

export interface PackagedPerfGates {
  readonly firstStartMs: number;
  readonly firstStartAclMs: number;
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
    firstStartAclMs: 0,
    warmStartMs: 2_500,
    repairWindowMs: 3_500,
    quitMs: 1_000,
    idleMemoryBytes: 360 * MB,
    backendMemoryBytes: 128 * MB,
  },
  // Medians of three from the packaged CI run 43991395594 (1.6.45, windows-latest): first start 2123 ms, its ACL read
  // 186 ms, warm 524 ms, repair window 2021 ms, quit 114 ms, idle working set 262.3 MiB (main 89, gpu 49, utility 44,
  // backend 68; conhost and the Dashboard's Edge are not the App's and are excluded), backend 71.6 MiB. Times are about
  // three times the median (four for the short warm start and almost nine for quit, whose 114 ms a scan by real-time
  // antivirus alone can triple); the ACL gate stays under the 2-2.6 s a cold Windows PowerShell start costs, so a read
  // that is cold on every run fails it. Memory is the median plus about a quarter (330 MiB) and, for the backend, plus
  // about 40% (100 MiB), as on the other platforms.
  win32: {
    firstStartMs: 7_000,
    firstStartAclMs: 1_500,
    warmStartMs: 2_000,
    repairWindowMs: 6_000,
    quitMs: 1_000,
    idleMemoryBytes: 330 * MB,
    backendMemoryBytes: 100 * MB,
  },
  // Memory from the first packaged CI run (1.6.45, `ps` RSS): arm64 346-347 MiB (main 158, gpu 56, utility 42.5,
  // backend 90), x64 213 MiB. The gate is the arm64 total plus about a quarter (440 MiB), the backend 90 MiB plus about
  // 40% (128 MiB). Times, medians of three from the same run (arm64 / x64): first start 1455 / 2325 ms, warm 1232 / 1154
  // ms, repair window 1524 / 2703 ms, quit 434 / 565 ms (one x64 sample took 10.4 s; the median absorbs it). The gates
  // are about three times the slower architecture, since macOS runners are the most uneven and the first launch of an
  // unseen binary pays Gatekeeper/XProtect scanning.
  darwin: {
    firstStartMs: 7_000,
    firstStartAclMs: 0,
    warmStartMs: 4_000,
    repairWindowMs: 8_000,
    quitMs: 2_000,
    idleMemoryBytes: 440 * MB,
    backendMemoryBytes: 128 * MB,
  },
};

export function packagedGatesForPlatform(platform: NodeJS.Platform): PackagedPerfGates {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return PACKAGED_PERF_GATES[platform];
  throw new Error(`no packaged performance gates for ${platform}`);
}
