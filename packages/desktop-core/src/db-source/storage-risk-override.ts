import type { StorageRisk, StorageRiskResult } from "./storage-risk.js";

const RISKS: ReadonlySet<string> = new Set<StorageRisk>([
  "none",
  "network",
  "removable",
  "cloud-sync",
  "hard-link",
  "unknown",
]);

export function parseStorageRiskOverride(text: string): ReadonlyMap<string, StorageRisk> {
  const entries = new Map<string, StorageRisk>();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return entries;
    for (const [prefix, risk] of Object.entries(parsed)) {
      if (prefix.length > 0 && typeof risk === "string" && RISKS.has(risk)) entries.set(prefix, risk as StorageRisk);
    }
  } catch {
    // Not JSON: no override.
  }
  return entries;
}

export function overriddenStorageRisk(
  path: string,
  entries: ReadonlyMap<string, StorageRisk>,
): StorageRiskResult | undefined {
  let best: string | undefined;
  for (const prefix of entries.keys()) {
    if (path.startsWith(prefix) && (best === undefined || prefix.length > best.length)) best = prefix;
  }
  return best === undefined
    ? undefined
    : { risk: entries.get(best) as StorageRisk, evidence: ["test-override"], symlinked: false };
}
