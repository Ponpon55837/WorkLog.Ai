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

export function isKnowledgeInDoubt(item: { possiblyStale?: unknown; review?: unknown }): boolean {
  return Boolean(item.review || item.possiblyStale);
}
