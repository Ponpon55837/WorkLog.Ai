import type { ArchitectureDiagram } from "@work-intelligence/schema/architecture-diagram";

export interface ArchitectureLayoutNode {
  node: ArchitectureDiagram["nodes"][number];
  x: number;
  y: number;
}

export interface ArchitectureLayout {
  nodes: ArchitectureLayoutNode[];
  edges: Array<ArchitectureDiagram["edges"][number] & { d: string }>;
  groups: Array<{ id: string; label: string; x: number; y: number; width: number; height: number }>;
  width: number;
  height: number;
}

export const ARCHITECTURE_NODE_WIDTH = 200;
export const ARCHITECTURE_NODE_HEIGHT = 86;

/** A bounded deterministic layout. Explicit positions belong to the author; absent positions use group rows. */
export function layoutArchitecture(diagram: ArchitectureDiagram, groupId = "", focusId = ""): ArchitectureLayout {
  const neighbors = new Set([focusId]);
  if (focusId) {
    for (const edge of diagram.edges) {
      if (edge.from === focusId) neighbors.add(edge.to);
      if (edge.to === focusId) neighbors.add(edge.from);
    }
  }
  const visible = diagram.nodes.filter(
    (node) => (!groupId || node.groupId === groupId) && (!focusId || neighbors.has(node.id)),
  );
  const nodes: ArchitectureLayoutNode[] = [];
  const groups: ArchitectureLayout["groups"] = [];
  let rowY = 48;
  for (const key of [...diagram.groups.map((group) => group.id), ""]) {
    const members = visible.filter((node) => (node.groupId ?? "") === key);
    if (!members.length) continue;
    const positioned = members.map((node, index) => ({
      node,
      x: node.position?.x ?? 40 + (index % 3) * 260,
      y: node.position?.y ?? rowY + Math.floor(index / 3) * 132,
    }));
    nodes.push(...positioned);
    const minX = Math.min(...positioned.map((item) => item.x));
    const minY = Math.min(...positioned.map((item) => item.y));
    const maxX = Math.max(...positioned.map((item) => item.x + ARCHITECTURE_NODE_WIDTH));
    const maxY = Math.max(...positioned.map((item) => item.y + ARCHITECTURE_NODE_HEIGHT));
    if (key)
      groups.push({
        id: key,
        label: diagram.groups.find((group) => group.id === key)!.label,
        x: Math.max(0, minX - 20),
        y: Math.max(0, minY - 36),
        width: maxX - minX + 40,
        height: maxY - minY + 56,
      });
    rowY = Math.max(rowY, maxY) + 72;
  }
  const byId = new Map(nodes.map((item) => [item.node.id, item]));
  const edges = diagram.edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];
    const x1 = from.x + ARCHITECTURE_NODE_WIDTH;
    const y1 = from.y + ARCHITECTURE_NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + ARCHITECTURE_NODE_HEIGHT / 2;
    // Loops/backward connections curve beneath the cards instead of through their labels.
    const d =
      from.x === to.x && to.y > from.y + ARCHITECTURE_NODE_HEIGHT
        ? `M ${from.x + 100} ${from.y + 86} C ${from.x + 100} ${(from.y + 86 + to.y) / 2}, ${to.x + 100} ${(from.y + 86 + to.y) / 2}, ${to.x + 100} ${to.y}`
        : edge.from === edge.to
          ? `M ${from.x + 140} ${from.y + 86} C ${from.x + 260} ${from.y + 144}, ${from.x - 60} ${from.y + 144}, ${from.x + 60} ${from.y + 86}`
          : x2 > x1
            ? `M ${x1} ${y1} C ${x1 + (x2 - x1) / 2} ${y1}, ${x2 - (x2 - x1) / 2} ${y2}, ${x2} ${y2}`
            : `M ${from.x + 100} ${from.y + 86} C ${from.x + 100} ${Math.max(from.y, to.y) + 120}, ${to.x + 100} ${Math.max(from.y, to.y) + 120}, ${to.x + 100} ${to.y + 86}`;
    return [{ ...edge, d }];
  });
  return {
    nodes,
    edges,
    groups,
    width: Math.max(320, ...nodes.map((item) => item.x + 240)),
    height: Math.max(200, ...nodes.map((item) => item.y + 144)),
  };
}
