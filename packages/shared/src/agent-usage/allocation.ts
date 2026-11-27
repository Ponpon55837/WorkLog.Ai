import { bump } from "./metrics.js";
import { foldPath, isPathInside, normalizePath } from "./paths.js";
import type { ScanState } from "./state.js";
import type {
  AllocationBasis,
  AllocationBasisCounts,
  TokenCounts,
  UsageAllocation,
  UsageAllocationOptions,
} from "./types.js";

export interface SessionEvidence {
  group: number;
  roots: Record<string, number>;
  files: Record<string, number>;
  cwds: Record<string, number>;
}

export interface PreparedGroup {
  projects: { id: string; selected: boolean }[];
  roots: { id: string; root: string }[];
  allSelected: boolean;
}

const MIN_HITS = 3;

export function createEvidence(group: number): SessionEvidence {
  return { group, roots: {}, files: {}, cwds: {} };
}

export function countPath(counts: Record<string, number>, value: unknown): void {
  const path = typeof value === "string" ? normalizePath(value) : null;
  if (path !== null) bump(counts, path);
}

export function prepareGroups(options: UsageAllocationOptions | undefined): PreparedGroup[] {
  return (options?.groups ?? []).map((group) => {
    const roots = group.projects.flatMap((project) => {
      const root = normalizePath(project.root);
      return root === null ? [] : [{ id: project.id, root: foldPath(root) }];
    });
    roots.sort((a, b) => b.root.length - a.root.length);
    return {
      projects: group.projects.map((project) => ({ id: project.id, selected: project.selected })),
      roots,
      allSelected: group.projects.every((project) => project.selected),
    };
  });
}

function tally(group: PreparedGroup, counts: Record<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  for (const [path, count] of Object.entries(counts)) {
    const folded = foldPath(path);
    const owner = group.roots.find((entry) => isPathInside(entry.root, folded));
    if (owner) result.set(owner.id, (result.get(owner.id) ?? 0) + count);
  }
  return result;
}

function uniqueTop(counts: Map<string, number>): { id: string; count: number } | null {
  let best: { id: string; count: number } | null = null;
  let tie = false;
  for (const [id, count] of counts) {
    if (best === null || count > best.count) {
      best = { id, count };
      tie = false;
    } else if (count === best.count) tie = true;
  }
  return tie ? null : best;
}

function decideProject(
  evidence: SessionEvidence,
  group: PreparedGroup,
): { projectId: string; basis: AllocationBasis } | null {
  const named = uniqueTop(tally(group, evidence.roots));
  if (named) return { projectId: named.id, basis: "projectRoot" };
  const bases = [
    ["filePaths", evidence.files],
    ["cwd", evidence.cwds],
  ] as const;
  for (const [basis, counts] of bases) {
    const hits = tally(group, counts);
    const top = uniqueTop(hits);
    const total = [...hits.values()].reduce((sum, count) => sum + count, 0);
    if (top && top.count >= MIN_HITS && top.count * 2 > total) return { projectId: top.id, basis };
  }
  return null;
}

function emptyBasis(): AllocationBasisCounts {
  return { projectRoot: 0, filePaths: 0, cwd: 0 };
}

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function allocateSessions(state: ScanState): { allocation: UsageAllocation; excluded: Set<string> } {
  const excluded = new Set<string>();
  const groups = state.groups.map((group) => ({
    projects: group.projects.map((project) => project.id),
    allocated: new Map(
      group.projects.map((project) => [
        project.id,
        {
          projectId: project.id,
          included: project.selected,
          conversations: 0,
          tokens: emptyTokens(),
          primary: 0,
          byBasis: emptyBasis(),
        },
      ]),
    ),
    unallocated: { included: group.allSelected, conversations: 0, tokens: emptyTokens(), primary: 0 },
  }));
  for (const [key, session] of state.sessions) {
    const evidence = state.evidence.get(key);
    const group = evidence ? state.groups[evidence.group] : undefined;
    const target = evidence ? groups[evidence.group] : undefined;
    if (!evidence || !group || !target) continue;
    const decision = decideProject(evidence, group);
    const allocated = decision ? target.allocated.get(decision.projectId) : undefined;
    const bucket = allocated ?? target.unallocated;
    bucket.conversations += 1;
    for (const field of ["input", "output", "cacheRead", "cacheCreation"] as const) {
      bucket.tokens[field] += session.tokens[field];
    }
    bucket.primary += session.tokens.input + session.tokens.output;
    if (allocated && decision) allocated.byBasis[decision.basis] += 1;
    if (!bucket.included) excluded.add(key);
  }
  return {
    allocation: {
      groups: groups.map((group) => ({
        projects: group.projects,
        allocated: [...group.allocated.values()],
        unallocated: group.unallocated,
      })),
    },
    excluded,
  };
}
