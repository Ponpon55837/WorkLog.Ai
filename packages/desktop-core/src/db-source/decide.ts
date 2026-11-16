import type {
  DbProbeStatus,
  DbSourceDecision,
  DbSourceGroup,
  DbSourceKind,
  ResolvedCandidate,
  UseReason,
} from "./types.js";

export interface DecideOptions {
  /** True when the volume holding this directory is known to be offline (an unplugged drive). */
  isOfflineVolume?: (directory: string) => boolean;
  /** Returns the parent directory of a path; injected only so decide stays free of platform path rules. */
  parentDirectory: (path: string) => string;
}

const LEGACY_KINDS: ReadonlySet<DbSourceKind> = new Set(["legacy-service", "plugin-link", "agent-mcp"]);
const DEFAULT_KINDS: ReadonlySet<DbSourceKind> = new Set(["standalone-default", "checkout-default"]);

function groupsOfKinds(groups: readonly DbSourceGroup[], kinds: ReadonlySet<DbSourceKind>): DbSourceGroup[] {
  return groups.filter((group) => group.candidates.some((candidate) => kinds.has(candidate.kind)));
}

/** A choice made by the user: authoritative, so an unavailable one blocks instead of falling through. */
function decideChoice(group: DbSourceGroup, kind: DbSourceKind, reason: UseReason): DbSourceDecision {
  if (group.probeStatus === "ok") return { kind: "use", group, reason };
  return {
    kind: "blocked",
    reason: "selected-source-unavailable",
    status: group.probeStatus as Exclude<DbProbeStatus, "ok">,
    group,
    source: kind,
  };
}

/**
 * Picks among sources nobody chose explicitly (legacy configs, then defaults): they must agree to be used. A `missing`
 * group is a stale pointer with nothing to preserve, so it is ignored; any other unusable group might be a different
 * real database, so it makes the picture unverifiable. Returns null when every group is missing.
 */
function decideInferred(groups: readonly DbSourceGroup[], reason: UseReason): DbSourceDecision | null {
  const present = groups.filter((group) => group.probeStatus !== "missing");
  if (present.length === 0) return null;
  const ok = present.filter((group) => group.probeStatus === "ok");
  if (ok.length === 0) return { kind: "needs-user-choice", groups: present, reason: "unverifiable" };
  if (ok.length > 1) {
    const conflict = ok.some((group) => group.status === "conflict");
    return { kind: "needs-user-choice", groups: ok, reason: conflict ? "conflict" : "multiple-distinct" };
  }
  const only = ok[0]!;
  if (only.status === "conflict") return { kind: "needs-user-choice", groups: [only], reason: "conflict" };
  if (present.length > 1) return { kind: "needs-user-choice", groups: present, reason: "unverifiable" };
  return { kind: "use", group: only, reason };
}

function offerNewDatabase(
  defaults: readonly DbSourceGroup[],
  candidates: readonly ResolvedCandidate[],
  options: DecideOptions,
): DbSourceDecision {
  const target =
    candidates.find((candidate) => candidate.kind === "standalone-default") ??
    candidates.find((candidate) => candidate.kind === "checkout-default");
  if (!target) return { kind: "needs-user-choice", groups: [], reason: "unverifiable" };
  if (options.isOfflineVolume?.(options.parentDirectory(target.absolutePath))) {
    return { kind: "needs-user-choice", groups: [...defaults], reason: "unverifiable" };
  }
  return { kind: "offer-new-database", path: target.absolutePath, requiresExplicitConsent: true };
}

/**
 * Selection is priority of CHOICE, not error fallback: committed > explicit > consistent legacy > default. Once a
 * higher tier has any candidate it alone decides; an unavailable chosen source blocks rather than quietly using a
 * lower one (an unplugged drive must never lead to a fresh empty database). Never creates anything.
 */
export function decideDbSource(
  groups: readonly DbSourceGroup[],
  candidates: readonly ResolvedCandidate[],
  options: DecideOptions,
): DbSourceDecision {
  for (const [kind, reason] of [
    ["desktop-committed", "desktop-committed"],
    ["explicit-selection", "explicit-selection"],
  ] as const) {
    const chosen = groupsOfKinds(groups, new Set([kind]));
    if (chosen.length > 1) return { kind: "needs-user-choice", groups: chosen, reason: "multiple-distinct" };
    if (chosen[0]) return decideChoice(chosen[0], kind, reason);
  }
  const legacyGroups = groupsOfKinds(groups, LEGACY_KINDS);
  const legacy = decideInferred(legacyGroups, "consistent-legacy");
  if (legacy) return legacy;

  const defaults = groupsOfKinds(groups, DEFAULT_KINDS);
  const fromDefaults = decideInferred(defaults, "default");
  if (fromDefaults) return fromDefaults;
  // Only missing paths remain. A dangling legacy pointer means a database was expected somewhere: ask, don't create.
  if (legacyGroups.length > 0) return { kind: "needs-user-choice", groups: legacyGroups, reason: "unverifiable" };
  return offerNewDatabase(defaults, candidates, options);
}
