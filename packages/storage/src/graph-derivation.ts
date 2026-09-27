import type { GraphEdge, GraphNode, GraphPathStep } from "@work-intelligence/core";

/** Sessions listing more files than this are likely a polluted worktree and say nothing about co-change. */
const CO_CHANGE_FILE_LIMIT = 20;
/** Derived edges are an aid, not the graph: keep at most this many, strongest first. */
export const MAX_DERIVED_EDGES = 300;

export interface CoChangeSession {
  projectId: string;
  changedFiles: readonly string[];
}

/**
 * co_changed edges between file nodes already in the graph that at least `minSessions` Sessions changed
 * together. Pairs are counted in one pass with a hash map keyed by the sorted pair (O(Σ k²) for k loaded files
 * per Session, k ≤ 20), then the strongest pairs are kept.
 */
export function coChangedEdges(
  sessions: readonly CoChangeSession[],
  fileNodeIds: ReadonlySet<string>,
  minSessions: number,
): GraphEdge[] {
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const session of sessions) {
    if (session.changedFiles.length > CO_CHANGE_FILE_LIMIT) {
      continue;
    }
    const files = [...new Set(session.changedFiles)]
      .map((file) => `file:${session.projectId}:${file}`)
      .filter((id) => fileNodeIds.has(id))
      .sort();
    for (let left = 0; left < files.length; left += 1) {
      for (let right = left + 1; right < files.length; right += 1) {
        const key = `${files[left]}\u0000${files[right]}`;
        const pair = pairs.get(key);
        if (pair) {
          pair.count += 1;
        } else {
          pairs.set(key, { from: files[left]!, to: files[right]!, count: 1 });
        }
      }
    }
  }
  return [...pairs.values()]
    .filter((pair) => pair.count >= minSessions)
    .sort((left, right) => right.count - left.count || left.from.localeCompare(right.from))
    .slice(0, MAX_DERIVED_EDGES)
    .map((pair) => ({
      id: `co-changed:${pair.from}:${pair.to}`,
      from: pair.from,
      to: pair.to,
      kind: "co_changed",
      provenance: "derived",
      reason: `${pair.count} 筆 Session 同時修改了這兩個檔案`,
    }));
}

/** A plain-language reason for one step, read in the direction the path walks it. */
export function stepReason(edge: GraphEdge, from: GraphNode, to: GraphNode): string {
  if (edge.reason) {
    return edge.reason;
  }
  const forward = edge.from === from.id;
  const [source, target] = forward ? [from, to] : [to, from];
  switch (edge.kind) {
    case "contains":
      return `專案「${source.label}」包含 Session「${target.label}」`;
    case "changed_file":
      return `Session「${source.label}」修改了 ${target.label}`;
    case "has_knowledge":
      return `Knowledge「${target.label}」記錄自「${source.label}」`;
    case "has_evidence":
      return `Session「${source.label}」附有 Evidence「${target.label}」`;
    case "session_link":
      return `Session「${source.label}」與「${target.label}」有記錄的關聯`;
    default:
      return `${source.label} 與 ${target.label} 相關`;
  }
}

/** Breadth-first shortest path over the undirected graph; undefined when `to` is unreachable from `from`. */
export function shortestPath(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  fromId: string,
  toId: string,
): GraphPathStep[] | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(fromId) || !byId.has(toId)) {
    return undefined;
  }
  if (fromId === toId) {
    return [];
  }
  const adjacency = new Map<string, Array<{ next: string; edge: GraphEdge }>>();
  const link = (a: string, b: string, edge: GraphEdge) => {
    const list = adjacency.get(a);
    if (list) {
      list.push({ next: b, edge });
    } else {
      adjacency.set(a, [{ next: b, edge }]);
    }
  };
  // Among equally short paths, prefer specific relations: a project "contains" every Session, so walking
  // through the project explains little. Those edges are explored last.
  const ordered = [...edges].sort(
    (left, right) => Number(left.kind === "contains") - Number(right.kind === "contains"),
  );
  for (const edge of ordered) {
    if (byId.has(edge.from) && byId.has(edge.to)) {
      link(edge.from, edge.to, edge);
      link(edge.to, edge.from, edge);
    }
  }
  // An array with a moving head is a queue without O(n) shifts.
  const queue = [fromId];
  const cameFrom = new Map<string, { previous: string; edge: GraphEdge }>();
  const visited = new Set([fromId]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    if (current === toId) {
      break;
    }
    for (const { next, edge } of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        cameFrom.set(next, { previous: current, edge });
        queue.push(next);
      }
    }
  }
  if (!visited.has(toId)) {
    return undefined;
  }
  const steps: GraphPathStep[] = [];
  for (let current = toId; current !== fromId;) {
    const { previous, edge } = cameFrom.get(current)!;
    const from = byId.get(previous)!;
    const to = byId.get(current)!;
    steps.push({ from, to, edge, reason: stepReason(edge, from, to) });
    current = previous;
  }
  return steps.reverse();
}
