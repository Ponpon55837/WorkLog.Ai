/** Compact trust detail that travels beside a `possiblyStale: true` flag in digests, hits, and context pointers. */
export interface StaleFlags {
  possiblyStale?: true;
  staleReason?: "broad_applies_to";
  broadChangesSince?: number;
}

interface StaleSource {
  possiblyStale?: boolean | { reason?: string };
  staleReason?: string;
  broadChangesSince?: number;
}

/**
 * The compact form of a Knowledge record's staleness: `possiblyStale: true` as before, `staleReason` only for a broad
 * appliesTo, and `broadChangesSince` only above 0, so an ordinary response does not grow. Works on a full record
 * (possiblyStale is an object) and on an already compact shape (flags copied through).
 */
export function staleFlags(source: StaleSource): StaleFlags {
  const stale = source.possiblyStale;
  const reason = typeof stale === "object" ? stale.reason : source.staleReason;
  return {
    ...(stale ? { possiblyStale: true as const } : {}),
    ...(stale && reason === "broad_applies_to" ? { staleReason: "broad_applies_to" as const } : {}),
    ...(source.broadChangesSince && source.broadChangesSince > 0
      ? { broadChangesSince: source.broadChangesSince }
      : {}),
  };
}
