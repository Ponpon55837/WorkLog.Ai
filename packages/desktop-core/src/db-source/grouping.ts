import { normalizePathForCompare } from "@work-intelligence/shared/file-identity";
import type { DbPreview, DbProbeStatus, DbSourceGroup, ResolvedCandidate } from "./types.js";

class UnionFind {
  private readonly parent: number[];
  private readonly size: number[];

  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, index) => index);
    this.size = new Array<number>(count).fill(1);
  }

  find(index: number): number {
    let node = index;
    while (this.parent[node] !== node) {
      this.parent[node] = this.parent[this.parent[node]!]!;
      node = this.parent[node]!;
    }
    return node;
  }

  union(a: number, b: number): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;
    if (this.size[rootA]! < this.size[rootB]!) [rootA, rootB] = [rootB, rootA];
    this.parent[rootB] = rootA;
    this.size[rootA]! += this.size[rootB]!;
  }
}

function fileKey(candidate: ResolvedCandidate): string | null {
  const id = candidate.identity?.fileId;
  return id ? `${id.device}:${id.inode}` : null;
}

function mergeEqualKeys(candidates: readonly ResolvedCandidate[], sets: UnionFind, platform: NodeJS.Platform): void {
  const byFileId = new Map<string, number>();
  const byPath = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const id = fileKey(candidate);
    // An id is stronger evidence than a path: two ids at one path (file replaced between probes) must stay apart.
    const map = id ?? normalizePathForCompare(candidate.identity?.realPath ?? candidate.absolutePath, platform);
    const table = id ? byFileId : byPath;
    const first = table.get(map);
    if (first === undefined) table.set(map, index);
    else sets.union(first, index);
  });
}

function pickRepresentative(members: readonly ResolvedCandidate[]): ResolvedCandidate {
  return members.find((member) => member.status === "ok") ?? members[0]!;
}

function buildGroup(id: string, members: ResolvedCandidate[]): DbSourceGroup {
  const representative = pickRepresentative(members);
  const preview: DbPreview = representative.preview;
  const probeStatus: DbProbeStatus = representative.status;
  return {
    id,
    candidates: members,
    kinds: [...new Set(members.map((member) => member.kind))],
    status: probeStatus,
    probeStatus,
    identity: representative.identity,
    preview,
    absolutePath: representative.identity?.realPath ?? representative.absolutePath,
  };
}

function markLineageConflicts(groups: DbSourceGroup[]): void {
  const byLineage = new Map<string, DbSourceGroup[]>();
  for (const group of groups) {
    const lineage = group.identity?.lineageId;
    if (!lineage) continue;
    const list = byLineage.get(lineage);
    if (list) list.push(group);
    else byLineage.set(lineage, [group]);
  }
  for (const list of byLineage.values()) {
    if (list.length < 2) continue;
    for (const group of list) group.status = "conflict";
  }
}

export function groupCandidates(candidates: readonly ResolvedCandidate[], platform: NodeJS.Platform): DbSourceGroup[] {
  const sets = new UnionFind(candidates.length);
  mergeEqualKeys(candidates, sets, platform);

  const members = new Map<number, ResolvedCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = sets.find(index);
    const list = members.get(root);
    if (list) list.push(candidate);
    else members.set(root, [candidate]);
  });

  const groups = [...members.values()].map((list, index) => buildGroup(`group-${index + 1}`, list));
  markLineageConflicts(groups);
  return groups;
}
