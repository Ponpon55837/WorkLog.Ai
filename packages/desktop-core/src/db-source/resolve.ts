import { posix, win32 } from "node:path";
import { decideDbSource } from "./decide.js";
import { groupCandidates } from "./grouping.js";
import type { StorageRiskResult } from "./storage-risk.js";
import type { DbCandidate, DbProbe, DbProbeResult, DbSourceResolution, ResolvedCandidate } from "./types.js";

export interface ResolveDbSourceOptions {
  candidates: readonly DbCandidate[];
  probe: DbProbe;
  platform?: NodeJS.Platform;
  isOfflineVolume?: (directory: string) => boolean;
  concurrency?: number;
  classifyStorage?: (absolutePath: string) => Promise<StorageRiskResult>;
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function safeProbe(probe: DbProbe, path: string): Promise<DbProbeResult> {
  try {
    return await probe(path);
  } catch (error) {
    return { status: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
}

function toResolved(candidate: DbCandidate, result: DbProbeResult): ResolvedCandidate {
  return {
    ...candidate,
    status: result.status,
    identity: result.identity ?? null,
    preview: { schemaVersion: result.schemaVersion, projectCount: result.projectCount },
    detail: result.detail,
  };
}

export async function resolveDbSource(options: ResolveDbSourceOptions): Promise<DbSourceResolution> {
  const platform = options.platform ?? process.platform;
  const results = new Map<string, Promise<DbProbeResult>>();
  const limit = options.concurrency ?? Number.POSITIVE_INFINITY;
  if (!(limit >= 1)) throw new RangeError("concurrency must be a positive number");
  const resolved = await mapWithLimit(options.candidates, limit, async (candidate) => {
    if (candidate.invalidReason) {
      return toResolved(candidate, { status: "unreadable", detail: candidate.invalidReason });
    }
    let pending = results.get(candidate.absolutePath);
    if (!pending) {
      pending = safeProbe(options.probe, candidate.absolutePath);
      results.set(candidate.absolutePath, pending);
    }
    return toResolved(candidate, await pending);
  });
  const groups = groupCandidates(resolved, platform);
  const classify = options.classifyStorage;
  if (classify) {
    await Promise.all(
      groups
        .filter((group) => group.probeStatus !== "missing")
        .map(async (group) => {
          group.storageRisk = await classify(group.absolutePath).catch((): StorageRiskResult => ({
            risk: "unknown",
            evidence: ["classifier-error"],
            symlinked: false,
          }));
        }),
    );
  }
  const api = platform === "win32" ? win32 : posix;
  const decision = decideDbSource(groups, resolved, {
    isOfflineVolume: options.isOfflineVolume,
    parentDirectory: (path) => api.dirname(path),
  });
  return { candidates: resolved, groups, decision };
}
