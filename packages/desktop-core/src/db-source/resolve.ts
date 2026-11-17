import { posix, win32 } from "node:path";
import { decideDbSource } from "./decide.js";
import { groupCandidates } from "./grouping.js";
import type { StorageRiskResult } from "./storage-risk.js";
import type { DbCandidate, DbProbe, DbProbeResult, DbSourceResolution, ResolvedCandidate } from "./types.js";

export interface ResolveDbSourceOptions {
  candidates: readonly DbCandidate[];
  probe: DbProbe;
  platform?: NodeJS.Platform;
  /** True when the volume holding this directory is known to be offline; blocks offering a new database there. */
  isOfflineVolume?: (directory: string) => boolean;
  /** Maximum probes in flight at once (positive integer); unbounded when omitted. */
  concurrency?: number;
  /**
   * Classifies the storage of a group's database (DT-08); the verdict is kept on the group and read by the decision.
   * It never throws (a failure is `unknown`), and is called once per group, all together.
   */
  classifyStorage?: (absolutePath: string) => Promise<StorageRiskResult>;
}

/** Run `task` over `items` with at most `limit` in flight; results keep the input order. */
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

/**
 * Probes every distinct path once (in parallel, capped by `concurrency`; see {@link DbProbe} for the threading
 * contract of synchronous probes), groups the results by physical database, and decides. Strictly
 * read-only: it never creates, opens for writing or repairs anything; creating a database is a separate, explicitly
 * consented step.
 */
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
