import type { StorageRisk, StorageRiskResult } from "./storage-risk.js";

/**
 * Test-build-only seam: a JSON object that maps a path prefix to the verdict a smoke test wants (the smoke tests cannot
 * mount a share or plug in a drive). The App reads it only in a test build that is not packaged; the classifier itself is
 * unit-tested per platform with fakes. A path under no prefix gets no override, so the real classifier answers.
 */

const RISKS: ReadonlySet<string> = new Set<StorageRisk>([
  "none",
  "network",
  "removable",
  "cloud-sync",
  "hard-link",
  "unknown",
]);

/** The `prefix -> risk` pairs of a JSON text; anything malformed is ignored (the override then says nothing). */
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

/** The verdict for `path` from the longest matching prefix, or undefined when none matches. */
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
