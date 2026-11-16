import { posix, win32 } from "node:path";
import { decideDbSource } from "./decide.js";
import { groupCandidates } from "./grouping.js";
import type { DbCandidate, DbProbe, DbProbeResult, DbSourceResolution, ResolvedCandidate } from "./types.js";

export interface ResolveDbSourceOptions {
  candidates: readonly DbCandidate[];
  probe: DbProbe;
  platform?: NodeJS.Platform;
  /** True when the volume holding this directory is known to be offline; blocks offering a new database there. */
  isOfflineVolume?: (directory: string) => boolean;
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
 * Probes every distinct path once (in parallel), groups the results by physical database, and decides. Strictly
 * read-only: it never creates, opens for writing or repairs anything; creating a database is a separate, explicitly
 * consented step.
 */
export async function resolveDbSource(options: ResolveDbSourceOptions): Promise<DbSourceResolution> {
  const platform = options.platform ?? process.platform;
  const results = new Map<string, Promise<DbProbeResult>>();
  const resolved = await Promise.all(
    options.candidates.map(async (candidate) => {
      if (candidate.invalidReason) {
        return toResolved(candidate, { status: "unreadable", detail: candidate.invalidReason });
      }
      let pending = results.get(candidate.absolutePath);
      if (!pending) {
        pending = safeProbe(options.probe, candidate.absolutePath);
        results.set(candidate.absolutePath, pending);
      }
      return toResolved(candidate, await pending);
    }),
  );
  const groups = groupCandidates(resolved, platform);
  const api = platform === "win32" ? win32 : posix;
  const decision = decideDbSource(groups, resolved, {
    isOfflineVolume: options.isOfflineVolume,
    parentDirectory: (path) => api.dirname(path),
  });
  return { candidates: resolved, groups, decision };
}
