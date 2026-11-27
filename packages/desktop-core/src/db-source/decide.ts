import type {
  DbProbeStatus,
  DbSourceDecision,
  DbSourceGroup,
  DbSourceKind,
  ResolvedCandidate,
  UseReason,
} from "./types.js";
import { storagePolicy } from "./storage-policy.js";

export interface DecideOptions {
  isOfflineVolume?: (directory: string) => boolean;
  parentDirectory: (path: string) => string;
}

const LEGACY_KINDS: ReadonlySet<DbSourceKind> = new Set(["legacy-service", "plugin-link", "agent-mcp"]);
const DEFAULT_KINDS: ReadonlySet<DbSourceKind> = new Set(["standalone-default", "checkout-default"]);

function groupsOfKinds(groups: readonly DbSourceGroup[], kinds: ReadonlySet<DbSourceKind>): DbSourceGroup[] {
  return groups.filter((group) => group.candidates.some((candidate) => kinds.has(candidate.kind)));
}

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
  // Network share, removable disk, sync folder, hard link or unclassified storage is never taken on one click.
  if (storagePolicy(only.storageRisk?.risk).note) {
    return { kind: "needs-user-choice", groups: [only], reason: "risky-storage" };
  }
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
 * Priority of choice, not error fallback: an unplugged drive must never lead to a fresh empty database. Never creates
 * anything.
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
  if (legacyGroups.length > 0) return { kind: "needs-user-choice", groups: legacyGroups, reason: "unverifiable" };
  return offerNewDatabase(defaults, candidates, options);
}
