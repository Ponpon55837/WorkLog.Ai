import { isAbsolute, join } from "node:path";
import {
  UsageCache,
  defaultUsageSourceDirs,
  resolveUsageSources,
  summarizeFiles,
  type UsageProjectInput,
  type UsageReport,
  type UsageSourceDirs,
  type UsageSourceProblem,
} from "@work-intelligence/shared/agent-usage";

interface UsageSourcesFound {
  projectId: string;
  claudeFolders: number;
  codexFiles: number;
  problem?: UsageSourceProblem;
}

interface UsageGroupFound {
  projectIds: string[];
  claudeFolders: number;
  codexFiles: number;
}

export interface UsageSourcesResult {
  projects: UsageSourcesFound[];
  groups: UsageGroupFound[];
}

export interface UsageScanInput {
  projects: UsageProjectInput[];
  allProjects?: UsageProjectInput[];
  manualFolders: string[];
  since?: string;
  until?: string;
  now?: number;
}

export interface UsageScanOutcome {
  report: UsageReport;
  problems: Array<{ projectId: string; problem: UsageSourceProblem }>;
}

export interface UsageScanContext {
  dirs: UsageSourceDirs;
  cacheFile?: string;
}

export interface UsageOperations {
  sources(projects: UsageProjectInput[], signal?: AbortSignal): Promise<UsageSourcesResult>;
  scan(input: UsageScanInput, signal?: AbortSignal): Promise<UsageScanOutcome>;
}

export const USAGE_SCAN_TIMEOUT_MS = 60_000;

function usageCacheFileFor(dataDirectory: string): string {
  return join(dataDirectory, "cache", "agent-usage-cache.json");
}

export function defaultUsageScanContext(dataDirectory: string | undefined): UsageScanContext {
  return {
    dirs: defaultUsageSourceDirs(),
    ...(dataDirectory ? { cacheFile: usageCacheFileFor(dataDirectory) } : {}),
  };
}

export function isScannableFolder(folder: string): boolean {
  return isAbsolute(folder) && !folder.includes("\0");
}

export async function runUsageSources(
  projects: UsageProjectInput[],
  context: UsageScanContext,
  signal?: AbortSignal,
): Promise<UsageSourcesResult> {
  const found = await resolveUsageSources(projects, context.dirs, { signal });
  return {
    projects: found.projects.map((entry) => ({
      projectId: entry.projectId,
      claudeFolders: entry.claudeFolders.length,
      codexFiles: entry.codexFiles.length,
      ...(entry.problem ? { problem: entry.problem } : {}),
    })),
    groups: found.groups.map((group) => ({
      projectIds: group.projectIds,
      claudeFolders: group.claudeFolders.length,
      codexFiles: group.codexFiles.length,
    })),
  };
}

export async function runUsageScan(
  input: UsageScanInput,
  context: UsageScanContext,
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<UsageScanOutcome> {
  const { signal, deadlineMs } = options;
  const universe = input.allProjects ?? input.projects;
  const sources = await resolveUsageSources(universe, context.dirs, { signal });
  const selected = new Set(input.projects.map((project) => project.id));
  const roots = new Map(universe.map((project) => [project.id, project.root]));
  const own = sources.projects.filter((entry) => selected.has(entry.projectId));
  const paths = [
    ...own.flatMap((entry) => [...entry.claudeFolders, ...entry.codexFiles]),
    ...input.manualFolders.filter(isScannableFolder),
  ];
  const groups = sources.groups
    .filter((group) => group.projectIds.some((id) => selected.has(id)))
    .map((group) => ({
      projects: group.projectIds.map((id) => ({ id, root: roots.get(id) ?? "", selected: selected.has(id) })),
      paths: [...group.claudeFolders, ...group.codexFiles],
    }));
  const cache = new UsageCache(context.cacheFile ? { file: context.cacheFile } : {});
  await cache.load();
  const report = await summarizeFiles([...new Set(paths)], {
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(signal ? { signal } : {}),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(groups.length > 0 ? { allocation: { groups } } : {}),
    cache,
  });
  try {
    await cache.save();
  } catch {
    // The cache only speeds up the next scan.
  }
  return {
    report,
    problems: own.flatMap((entry) => (entry.problem ? [{ projectId: entry.projectId, problem: entry.problem }] : [])),
  };
}

export class InlineUsageOperations implements UsageOperations {
  public constructor(
    private readonly context: UsageScanContext,
    private readonly timeoutMs = USAGE_SCAN_TIMEOUT_MS,
  ) {}

  public sources(projects: UsageProjectInput[], signal?: AbortSignal): Promise<UsageSourcesResult> {
    return runUsageSources(projects, this.context, signal);
  }

  public scan(input: UsageScanInput, signal?: AbortSignal): Promise<UsageScanOutcome> {
    return runUsageScan(input, this.context, {
      ...(signal ? { signal } : {}),
      deadlineMs: Date.now() + this.timeoutMs,
    });
  }
}
