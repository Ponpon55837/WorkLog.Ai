import { readPssBytes } from "../support/process-tools.js";
import type { ProcessInfo } from "./helpers.js";

/**
 * Idle memory of the packaged App's process tree, split by what each process is: the Electron main (browser) process,
 * the GPU process, the renderers, the utility processes (network service, ...), the zygote and the backend (the bundled
 * Node). One metric is used for every process of one measurement, so the roles add up to the total:
 * - Linux: PSS (`/proc/<pid>/smaps_rollup`), which splits shared pages among the processes that map them; when one process
 *   cannot be read the whole measurement falls back to RSS, so a sum never mixes the two.
 * - macOS: RSS (`ps -o rss`), which counts shared pages once per process.
 * - Windows: working set (CIM `WorkingSetSize`), which also counts shared pages once per process.
 * RSS and working set therefore read higher than the real footprint, most for the many Chromium processes; the RSS sum is
 * also kept on Linux, to compare with older measurements.
 */

export type ProcessRole = "main" | "gpu" | "renderer" | "utility" | "zygote" | "backend" | "other";

export type MemoryMetric = "pss" | "rss" | "workingSet";

export const PROCESS_ROLES: readonly ProcessRole[] = [
  "main",
  "gpu",
  "renderer",
  "utility",
  "zygote",
  "backend",
  "other",
];

export interface ProcessMemory {
  readonly pid: number;
  readonly role: ProcessRole;
  /** The utility process kind (`network.mojom.NetworkService`, ...); empty for the other roles. */
  readonly detail: string;
  readonly bytes: number;
  readonly rssBytes: number;
}

export interface RoleMemory {
  readonly count: number;
  readonly bytes: number;
}

export interface MemoryBreakdown {
  readonly metric: MemoryMetric;
  readonly totalBytes: number;
  /** The plain `ps` RSS (Windows: working set) sum, whatever the metric is. */
  readonly totalRssBytes: number;
  readonly byRole: Readonly<Record<ProcessRole, RoleMemory>>;
  readonly processes: readonly ProcessMemory[];
}

export interface TreeRoots {
  readonly mainPid: number;
  readonly backendPid: number;
}

const CHROMIUM_ROLES: Readonly<Record<string, ProcessRole>> = {
  "gpu-process": "gpu",
  renderer: "renderer",
  utility: "utility",
  zygote: "zygote",
};

/** The metric a platform's measurement uses at best (Linux falls back to `rss` when PSS is unreadable). */
export function memoryMetricForPlatform(platform: NodeJS.Platform): MemoryMetric {
  if (platform === "linux") return "pss";
  return platform === "win32" ? "workingSet" : "rss";
}

/** Chromium's `--type=` argument names the helper; the main process has none, and the backend is known by its pid. */
export function classifyProcess(
  info: Pick<ProcessInfo, "pid" | "commandLine">,
  roots: TreeRoots,
): Pick<ProcessMemory, "role" | "detail"> {
  if (info.pid === roots.backendPid) return { role: "backend", detail: "" };
  if (info.pid === roots.mainPid) return { role: "main", detail: "" };
  const type = /(?:^|\s)--type=([\w-]+)/.exec(info.commandLine)?.[1];
  const role = type ? (CHROMIUM_ROLES[type] ?? "other") : "other";
  const detail = role === "utility" ? (/(?:^|\s)--utility-sub-type=(\S+)/.exec(info.commandLine)?.[1] ?? "") : "";
  return { role, detail };
}

function emptyRoles(): Record<ProcessRole, RoleMemory> {
  return Object.fromEntries(PROCESS_ROLES.map((role) => [role, { count: 0, bytes: 0 }])) as Record<
    ProcessRole,
    RoleMemory
  >;
}

/** Measures every process of `tree` (the main process and its descendants) and groups it by role. */
export function measureMemory(tree: readonly ProcessInfo[], roots: TreeRoots): MemoryBreakdown {
  const pss = tree.map((info) => readPssBytes(info.pid));
  const fallback: MemoryMetric = process.platform === "win32" ? "workingSet" : "rss";
  const metric =
    memoryMetricForPlatform(process.platform) === "pss" && pss.every((value) => value !== undefined) ? "pss" : fallback;
  const processes = tree.map((info, index): ProcessMemory => ({
    pid: info.pid,
    ...classifyProcess(info, roots),
    bytes: metric === "pss" ? (pss[index] ?? 0) : info.rssBytes,
    rssBytes: info.rssBytes,
  }));
  const byRole = emptyRoles();
  for (const processMemory of processes) {
    const current = byRole[processMemory.role];
    byRole[processMemory.role] = { count: current.count + 1, bytes: current.bytes + processMemory.bytes };
  }
  return {
    metric,
    totalBytes: processes.reduce((total, processMemory) => total + processMemory.bytes, 0),
    totalRssBytes: processes.reduce((total, processMemory) => total + processMemory.rssBytes, 0),
    byRole,
    processes,
  };
}

/** The values' median (the mean of the two middle ones for an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The median bytes of each role over several measurements (a role that is absent in one counts as 0 there). */
export function medianBytesByRole(runs: readonly MemoryBreakdown[]): Record<ProcessRole, number> {
  return Object.fromEntries(
    PROCESS_ROLES.map((role) => [role, Math.round(median(runs.map((run) => run.byRole[role].bytes)))]),
  ) as Record<ProcessRole, number>;
}

/** One line per role of a measurement, for the stdout print: `renderer 2 processes 97.5 MiB`. */
export function formatBreakdown(breakdown: MemoryBreakdown): string {
  const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const lines = PROCESS_ROLES.filter((role) => breakdown.byRole[role].count > 0).map((role) => {
    const { count, bytes } = breakdown.byRole[role];
    return `  ${role.padEnd(8)} ${String(count).padStart(2)} process${count === 1 ? " " : "es"} ${mib(bytes).padStart(11)}`;
  });
  return [`idle memory by process role (${breakdown.metric})`, ...lines, `  total ${mib(breakdown.totalBytes)}`].join(
    "\n",
  );
}
