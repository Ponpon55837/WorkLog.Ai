import { isAbsolute, join } from "node:path";
import {
  UsageCache,
  defaultUsageSourceDirs,
  resolveProjectSources,
  summarizeFiles,
  type UsageProjectInput,
  type UsageReport,
  type UsageSourceDirs,
  type UsageSourceProblem,
} from "@work-intelligence/shared/agent-usage";

/** The scan itself, shared by the REST worker, the in-process fallback and the `usage` command. Paths never leave it. */
export interface UsageSourcesFound {
  projectId: string;
  claudeFolders: number;
  codexFiles: number;
  problem?: UsageSourceProblem;
}

export interface UsageScanInput {
  projects: UsageProjectInput[];
  /** Absolute folders the user added by hand; scanned read-only and never echoed. */
  manualFolders: string[];
  since?: string;
  until?: string;
}

export interface UsageScanOutcome {
  report: UsageReport;
  problems: Array<{ projectId: string; problem: UsageSourceProblem }>;
}

/** Where the logs are read and where the incremental cache lives. */
export interface UsageScanContext {
  dirs: UsageSourceDirs;
  cacheFile?: string;
}

/** What the REST routes need from a scanner; the production one runs in a child process. */
export interface UsageOperations {
  /** How many Claude folders and Codex files each project has. */
  sources(projects: UsageProjectInput[], signal?: AbortSignal): Promise<UsageSourcesFound[]>;
  /** Scans the projects' logs and the manual folders. A newer scan cancels the running one. */
  scan(input: UsageScanInput, signal?: AbortSignal): Promise<UsageScanOutcome>;
}

/** Longest a scan may run before it is stopped. */
export const USAGE_SCAN_TIMEOUT_MS = 60_000;

/** The cache file for a database: `cache/agent-usage-cache.json` in the data directory. */
function usageCacheFileFor(dataDirectory: string): string {
  return join(dataDirectory, "cache", "agent-usage-cache.json");
}

export function defaultUsageScanContext(dataDirectory: string | undefined): UsageScanContext {
  return {
    dirs: defaultUsageSourceDirs(),
    ...(dataDirectory ? { cacheFile: usageCacheFileFor(dataDirectory) } : {}),
  };
}

/** Whether a manual folder is something the scan may read: an absolute path without a NUL byte. */
export function isScannableFolder(folder: string): boolean {
  return isAbsolute(folder) && !folder.includes("\0");
}

export async function runUsageSources(
  projects: UsageProjectInput[],
  context: UsageScanContext,
  signal?: AbortSignal,
): Promise<UsageSourcesFound[]> {
  const found = await resolveProjectSources(projects, context.dirs, { signal });
  return found.map((entry) => ({
    projectId: entry.projectId,
    claudeFolders: entry.claudeFolders.length,
    codexFiles: entry.codexFiles.length,
    ...(entry.problem ? { problem: entry.problem } : {}),
  }));
}

export async function runUsageScan(
  input: UsageScanInput,
  context: UsageScanContext,
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<UsageScanOutcome> {
  const { signal, deadlineMs } = options;
  const sources = await resolveProjectSources(input.projects, context.dirs, { signal });
  const paths = [
    ...sources.flatMap((entry) => [...entry.claudeFolders, ...entry.codexFiles]),
    ...input.manualFolders.filter(isScannableFolder),
  ];
  const cache = new UsageCache(context.cacheFile ? { file: context.cacheFile } : {});
  await cache.load();
  const report = await summarizeFiles([...new Set(paths)], {
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
    ...(signal ? { signal } : {}),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    cache,
  });
  try {
    await cache.save();
  } catch {
    // The cache only speeds up the next scan.
  }
  return {
    report,
    problems: sources.flatMap((entry) =>
      entry.problem ? [{ projectId: entry.projectId, problem: entry.problem }] : [],
    ),
  };
}

/** Runs scans in this process (the `usage` command and tests); the server uses `UsageWorkerClient` instead. */
export class InlineUsageOperations implements UsageOperations {
  public constructor(
    private readonly context: UsageScanContext,
    private readonly timeoutMs = USAGE_SCAN_TIMEOUT_MS,
  ) {}

  public sources(projects: UsageProjectInput[], signal?: AbortSignal): Promise<UsageSourcesFound[]> {
    return runUsageSources(projects, this.context, signal);
  }

  public scan(input: UsageScanInput, signal?: AbortSignal): Promise<UsageScanOutcome> {
    return runUsageScan(input, this.context, {
      ...(signal ? { signal } : {}),
      deadlineMs: Date.now() + this.timeoutMs,
    });
  }
}
