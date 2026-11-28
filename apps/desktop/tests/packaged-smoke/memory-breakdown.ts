import { readPssBytes } from "../support/process-tools.js";
import { executablePathOf, isInside, type ProcessInfo } from "./helpers.js";
import { median } from "./median.js";

/** One metric per measurement so roles add up: Linux PSS (RSS fallback if any process is unreadable), macOS RSS, Windows working set. */

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
  readonly detail: string;
  readonly bytes: number;
  readonly rssBytes: number;
}

export interface RoleMemory {
  readonly count: number;
  readonly bytes: number;
}

// An external browser the OS started for the Dashboard is a child of the App on Windows.
export interface ExcludedProcess {
  readonly pid: number;
  readonly name: string;
  readonly rssBytes: number;
}

export interface MemoryBreakdown {
  readonly metric: MemoryMetric;
  readonly totalBytes: number;
  readonly totalRssBytes: number;
  readonly byRole: Readonly<Record<ProcessRole, RoleMemory>>;
  readonly processes: readonly ProcessMemory[];
  readonly excluded: readonly ExcludedProcess[];
}

export interface TreeRoots {
  readonly mainPid: number;
  readonly backendPid: number;
}

export interface AppScope {
  readonly programDirectory: string;
  readonly runtimeDirectory: string;
}

const CHROMIUM_ROLES: Readonly<Record<string, ProcessRole>> = {
  "gpu-process": "gpu",
  renderer: "renderer",
  utility: "utility",
  zygote: "zygote",
};

export function memoryMetricForPlatform(platform: NodeJS.Platform): MemoryMetric {
  if (platform === "linux") return "pss";
  return platform === "win32" ? "workingSet" : "rss";
}

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

function executableName(info: ProcessInfo, executable: string | undefined): string {
  const path = executable ?? info.commandLine.split(" ")[0] ?? "";
  return path.split(/[\\/]/).at(-1) || "(unknown)";
}

export function measureMemory(tree: readonly ProcessInfo[], roots: TreeRoots, scope: AppScope): MemoryBreakdown {
  const excluded: ExcludedProcess[] = [];
  const own = tree.filter((info) => {
    if (info.pid === roots.mainPid || info.pid === roots.backendPid) return true;
    const executable = info.executable ?? executablePathOf(info.pid, tree);
    if (
      executable !== undefined &&
      (isInside(scope.programDirectory, executable) || isInside(scope.runtimeDirectory, executable))
    ) {
      return true;
    }
    excluded.push({ pid: info.pid, name: executableName(info, executable), rssBytes: info.rssBytes });
    return false;
  });
  const pss = own.map((info) => readPssBytes(info.pid));
  const fallback: MemoryMetric = process.platform === "win32" ? "workingSet" : "rss";
  const metric =
    memoryMetricForPlatform(process.platform) === "pss" && pss.every((value) => value !== undefined) ? "pss" : fallback;
  const processes = own.map((info, index): ProcessMemory => ({
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
    excluded,
  };
}

export function medianBytesByRole(runs: readonly MemoryBreakdown[]): Record<ProcessRole, number> {
  return Object.fromEntries(
    PROCESS_ROLES.map((role) => [role, Math.round(median(runs.map((run) => run.byRole[role].bytes)))]),
  ) as Record<ProcessRole, number>;
}

export function formatBreakdown(breakdown: MemoryBreakdown): string {
  const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const lines = PROCESS_ROLES.filter((role) => breakdown.byRole[role].count > 0).map((role) => {
    const { count, bytes } = breakdown.byRole[role];
    return `  ${role.padEnd(8)} ${String(count).padStart(2)} process${count === 1 ? " " : "es"} ${mib(bytes).padStart(11)}`;
  });
  const excluded = breakdown.excluded.map(
    (other) => `  excluded (not the App) ${other.name} pid ${other.pid} ${mib(other.rssBytes)}`,
  );
  return [
    `idle memory by process role (${breakdown.metric})`,
    ...lines,
    `  total ${mib(breakdown.totalBytes)}`,
    ...excluded,
  ].join("\n");
}
