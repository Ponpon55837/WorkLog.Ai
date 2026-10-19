import type { ArchitectureDiagram } from "@work-intelligence/schema/architecture-diagram";

type DiagramNode = ArchitectureDiagram["nodes"][number];
type DiagramEdge = ArchitectureDiagram["edges"][number];

export type ArchitectureSide = "top" | "right" | "bottom" | "left";

export interface ArchitecturePoint {
  x: number;
  y: number;
}

export interface ArchitectureLayoutNode {
  node: DiagramNode;
  x: number;
  y: number;
  /** Index into the diagram tone tokens; absent for ungrouped nodes. */
  tone?: number;
}

export interface ArchitectureEdgeLabel {
  x: number;
  y: number;
  width: number;
  text: string;
}

export interface ArchitectureLayoutEdge extends DiagramEdge {
  d: string;
  points: ArchitecturePoint[];
  fromSide: ArchitectureSide;
  toSide: ArchitectureSide;
  labelBox?: ArchitectureEdgeLabel;
}

export interface ArchitectureLayoutGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: number;
}

export interface ArchitectureLayout {
  nodes: ArchitectureLayoutNode[];
  edges: ArchitectureLayoutEdge[];
  groups: ArchitectureLayoutGroup[];
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Segment = [ArchitecturePoint, ArchitecturePoint];

interface Link {
  from: string;
  to: string;
}

interface Block {
  key: string;
  grouped: boolean;
  members: string[];
  columns: string[][];
  width: number;
  height: number;
  x: number;
  y: number;
}

interface Port {
  edgeIndex: number;
  end: "from" | "to";
  other: number;
}

export const ARCHITECTURE_NODE_WIDTH = 200;
export const ARCHITECTURE_NODE_HEIGHT = 86;
/** Number of `--diagram-tone-N` tokens in styles/tokens.css. */
export const ARCHITECTURE_TONE_COUNT = 6;

const MARGIN = 40;
// Wide column gaps leave a vertical channel for routes and room for an edge label between layers.
const COLUMN_GAP = 140;
const ROW_GAP = 40;
// Sub-columns inside a group still need a routing channel between them.
const INNER_GAP = 80;
const BLOCK_GAP = 48;
const MAX_STACK = 6;
const GROUP_PADDING = 20;
const GROUP_HEADER = 36;
const STUB = 16;
const CLEARANCE = 12;
const CORNER_RADIUS = 8;
const MIN_HORIZONTAL_CHANNEL = 32;
const LANE_SPACING = 16;
const MAX_CANDIDATES = 32;
const CROSSING_COST = 600;
const BEND_COST = 40;
const LABEL_MAX_CHARS = 28;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function rectOf(item: ArchitectureLayoutNode): Rect {
  return { x: item.x, y: item.y, width: ARCHITECTURE_NODE_WIDTH, height: ARCHITECTURE_NODE_HEIGHT };
}

/**
 * Longest-path layering with cycles broken by DFS back edges, so every kept link points to a later layer.
 * Sources are pulled next to their first successor to keep entry points close to what they call.
 */
function assignLayers(ids: string[], links: Link[]): Map<string, number> {
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const link of links) {
    if (link.from === link.to || !outgoing.has(link.from) || !outgoing.has(link.to)) continue;
    outgoing.get(link.from)!.push(link.to);
  }
  const state = new Map<string, "open" | "done">();
  const forward = new Map(ids.map((id) => [id, [] as string[]]));
  const postorder: string[] = [];
  const visit = (id: string): void => {
    state.set(id, "open");
    for (const to of outgoing.get(id)!) {
      if (state.get(to) === "open") continue;
      forward.get(id)!.push(to);
      if (!state.has(to)) visit(to);
    }
    state.set(id, "done");
    postorder.push(id);
  };
  // Declaration order decides which link of a cycle turns backward: authors list entry points first.
  for (const id of ids) if (!state.has(id)) visit(id);
  const layers = new Map(ids.map((id) => [id, 0]));
  const order = postorder.reverse();
  for (const id of order)
    for (const to of forward.get(id)!) layers.set(to, Math.max(layers.get(to)!, layers.get(id)! + 1));
  const hasIncoming = new Set([...forward.values()].flat());
  for (const id of order) {
    const next = forward.get(id)!;
    if (hasIncoming.has(id) || !next.length) continue;
    layers.set(id, Math.max(0, Math.min(...next.map((to) => layers.get(to)!)) - 1));
  }
  return layers;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** Split a group's members into sub-columns by their internal layers, wrapping tall stacks. */
function blockColumns(members: string[], links: Link[], stackLimit: number): string[][] {
  const inside = new Set(members);
  const layers = assignLayers(
    members,
    links.filter((link) => inside.has(link.from) && inside.has(link.to)),
  );
  const columns: string[][] = [];
  for (const layer of [...new Set(layers.values())].sort((a, b) => a - b)) {
    const stack = members.filter((id) => layers.get(id) === layer);
    for (let start = 0; start < stack.length; start += stackLimit) columns.push(stack.slice(start, start + stackLimit));
  }
  return columns;
}

/**
 * Groups become blocks laid out left to right along the links between them, with blocks in the same column
 * stacked and centered; inside a block, members sit in sub-columns by their own links. This keeps related
 * cards together and the drawing compact instead of a staircase of one card per row.
 */
function placeAutomatic(auto: DiagramNode[], links: Link[], top: number): Map<string, ArchitecturePoint> {
  const placed = new Map<string, ArchitecturePoint>();
  if (!auto.length) return placed;
  const autoIds = new Set(auto.map((node) => node.id));
  const autoLinks = links.filter((link) => link.from !== link.to && autoIds.has(link.from) && autoIds.has(link.to));
  const connected = new Set(autoLinks.flatMap((link) => [link.from, link.to]));
  const blockOf = new Map(
    auto.map((node) => [
      node.id,
      node.groupId ? `g:${node.groupId}` : connected.has(node.id) ? `n:${node.id}` : "loose",
    ]),
  );
  const blocks: Block[] = [];
  for (const node of auto) {
    const key = blockOf.get(node.id)!;
    const block = blocks.find((item) => item.key === key);
    if (block) block.members.push(node.id);
    else
      blocks.push({
        key,
        grouped: key.startsWith("g:"),
        members: [node.id],
        columns: [],
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      });
  }
  for (const block of blocks) {
    // Unconnected cards form a near-square grid instead of one very tall column.
    const limit = block.key === "loose" ? Math.ceil(Math.sqrt(block.members.length)) : MAX_STACK;
    block.columns = blockColumns(block.members, autoLinks, limit);
    const rows = Math.max(...block.columns.map((column) => column.length));
    const inset = block.grouped ? GROUP_PADDING : 0;
    block.width = block.columns.length * ARCHITECTURE_NODE_WIDTH + (block.columns.length - 1) * INNER_GAP + inset * 2;
    block.height =
      rows * ARCHITECTURE_NODE_HEIGHT + (rows - 1) * ROW_GAP + (block.grouped ? GROUP_HEADER + GROUP_PADDING : 0);
  }
  const blockLinks = autoLinks
    .map((link) => ({ from: blockOf.get(link.from)!, to: blockOf.get(link.to)! }))
    .filter((link) => link.from !== link.to);
  const blockLayers = assignLayers(
    blocks.map((block) => block.key),
    blockLinks,
  );
  const columnCount = Math.max(...blockLayers.values()) + 1;
  const columns: Block[][] = Array.from({ length: columnCount }, () => []);
  for (const block of blocks) columns[blockLayers.get(block.key)!]!.push(block);
  // Order stacked blocks by the average slot of the blocks they link to, sweeping left then right.
  const slot = new Map<string, number>();
  const refreshSlots = (): void =>
    columns.forEach((column) => column.forEach((block, index) => slot.set(block.key, index)));
  refreshSlots();
  for (const pass of [0, 1, 2, 3]) {
    const sequence = pass % 2 === 0 ? columns : [...columns].reverse();
    for (const column of sequence) {
      const weight = new Map(
        column.map((block, index) => {
          const linked = blockLinks
            .flatMap((link) => (link.from === block.key ? [link.to] : link.to === block.key ? [link.from] : []))
            .map((key) => slot.get(key)!);
          return [block.key, (mean(linked) ?? index) + index * 1e-6];
        }),
      );
      column.sort((a, b) => weight.get(a.key)! - weight.get(b.key)!);
      refreshSlots();
    }
  }
  const columnHeights = columns.map(
    (column) => column.reduce((sum, block) => sum + block.height, 0) + Math.max(0, column.length - 1) * BLOCK_GAP,
  );
  const tallest = Math.max(...columnHeights);
  let x = MARGIN;
  columns.forEach((column, index) => {
    const width = Math.max(0, ...column.map((block) => block.width));
    let y = top + (tallest - columnHeights[index]!) / 2;
    for (const block of column) {
      block.x = x + (width - block.width) / 2;
      block.y = y;
      y += block.height + BLOCK_GAP;
    }
    if (column.length) x += width + COLUMN_GAP;
  });
  const pitchX = ARCHITECTURE_NODE_WIDTH + INNER_GAP;
  const pitchY = ARCHITECTURE_NODE_HEIGHT + ROW_GAP;
  const position = (): void => {
    for (const block of blocks) {
      const inset = block.grouped ? GROUP_PADDING : 0;
      const rows = Math.max(...block.columns.map((column) => column.length));
      block.columns.forEach((column, index) => {
        // Short sub-columns are centered so links to neighbors in the next column stay level.
        const offset = ((rows - column.length) * pitchY) / 2;
        column.forEach((id, row) =>
          placed.set(id, {
            x: block.x + inset + index * pitchX,
            y: block.y + (block.grouped ? GROUP_HEADER : 0) + offset + row * pitchY,
          }),
        );
      });
    }
  };
  position();
  // Within each sub-column, order cards by the height of what they link to so links run level and cross less.
  for (let pass = 0; pass < 3; pass++) {
    for (const block of blocks)
      for (const column of block.columns) {
        const own = new Set(column);
        const weight = new Map(
          column.map((id, index) => {
            const linked = autoLinks
              .flatMap((link) => (link.from === id ? [link.to] : link.to === id ? [link.from] : []))
              .filter((other) => !own.has(other))
              .map((other) => placed.get(other)!.y);
            return [id, (mean(linked) ?? placed.get(id)!.y) + index * 1e-6];
          }),
        );
        column.sort((a, b) => weight.get(a)! - weight.get(b)!);
      }
    position();
  }
  return placed;
}

/** Leave sideways when there is a usable gap between the cards, otherwise vertically. */
function chooseSides(from: Rect, to: Rect): [ArchitectureSide, ArchitectureSide] {
  const gapX = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
  const gapY = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
  if (gapX >= MIN_HORIZONTAL_CHANNEL || gapY <= 0)
    return to.x + to.width / 2 >= from.x + from.width / 2 ? ["right", "left"] : ["left", "right"];
  return to.y + to.height / 2 >= from.y + from.height / 2 ? ["bottom", "top"] : ["top", "bottom"];
}

function portPoint(rect: Rect, side: ArchitectureSide, index: number, count: number): ArchitecturePoint {
  const t = (index + 1) / (count + 1);
  if (side === "left") return { x: rect.x, y: rect.y + rect.height * t };
  if (side === "right") return { x: rect.x + rect.width, y: rect.y + rect.height * t };
  if (side === "top") return { x: rect.x + rect.width * t, y: rect.y };
  return { x: rect.x + rect.width * t, y: rect.y + rect.height };
}

function segmentHits(a: ArchitecturePoint, b: ArchitecturePoint, rect: Rect): boolean {
  const pad = CLEARANCE / 2;
  return (
    Math.max(a.x, b.x) > rect.x - pad &&
    Math.min(a.x, b.x) < rect.x + rect.width + pad &&
    Math.max(a.y, b.y) > rect.y - pad &&
    Math.min(a.y, b.y) < rect.y + rect.height + pad
  );
}

function rangeOverlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
}

/** Whether a run lies on top of an already drawn run, which would make two connections read as one. */
function overlapsRoute(a: ArchitecturePoint, b: ArchitecturePoint, used: Segment[]): boolean {
  return used.some(([c, d]) => {
    if (a.x === b.x && c.x === d.x) return Math.abs(a.x - c.x) < LANE_SPACING && rangeOverlap(a.y, b.y, c.y, d.y) > 0;
    if (a.y === b.y && c.y === d.y) return Math.abs(a.y - c.y) < LANE_SPACING && rangeOverlap(a.x, b.x, c.x, d.x) > 0;
    return false;
  });
}

function routeClear(points: ArchitecturePoint[], obstacles: Rect[], used: Segment[]): boolean {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (obstacles.some((rect) => segmentHits(a, b, rect))) return false;
    // Port stubs may share a lane near a card; only the runs between them must keep apart.
    if (index > 1 && index < points.length - 1 && overlapsRoute(a, b, used)) return false;
  }
  return true;
}

function crossings(points: ArchitecturePoint[], used: Segment[]): number {
  let count = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    for (const [c, d] of used) {
      const vertical = a.x === b.x ? [a, b] : c.x === d.x ? [c, d] : undefined;
      const horizontal = a.y === b.y ? [a, b] : c.y === d.y ? [c, d] : undefined;
      if (!vertical || !horizontal || vertical[0] === horizontal[0]) continue;
      const [v1, v2] = vertical as [ArchitecturePoint, ArchitecturePoint];
      const [h1, h2] = horizontal as [ArchitecturePoint, ArchitecturePoint];
      if (
        v1.x > Math.min(h1.x, h2.x) &&
        v1.x < Math.max(h1.x, h2.x) &&
        h1.y > Math.min(v1.y, v2.y) &&
        h1.y < Math.max(v1.y, v2.y)
      )
        count++;
    }
  }
  return count;
}

/** Crossings dominate, then bends, then length: the reading cost of following a connection. */
function routeCost(points: ArchitecturePoint[], used: Segment[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++)
    length += Math.abs(points[index]!.x - points[index - 1]!.x) + Math.abs(points[index]!.y - points[index - 1]!.y);
  return crossings(points, used) * CROSSING_COST + (points.length - 2) * BEND_COST + length;
}

function lanes(center: number, low: number, high: number): number[] {
  const values = [center];
  for (let step = 1; step <= 6; step++) values.push(center + step * LANE_SPACING, center - step * LANE_SPACING);
  return values.filter((value) => value > low && value < high);
}

function transpose(point: ArchitecturePoint): ArchitecturePoint {
  return { x: point.y, y: point.x };
}

/**
 * Orthogonal route between two ports whose stubs face each other along x (callers transpose vertical routes).
 * Tries one vertical channel first, then a detour along a horizontal channel. A channel must clear every card
 * and, on the first pass, keep a lane apart from routes already drawn; when nothing is clear the middle channel
 * wins so the route stays predictable.
 */
function routeAlongX(
  start: ArchitecturePoint,
  end: ArchitecturePoint,
  obstacles: Rect[],
  used: Segment[],
): ArchitecturePoint[] {
  const direction = Math.sign(end.x - start.x || 1);
  const a = { x: start.x + direction * STUB, y: start.y };
  const b = { x: end.x - direction * STUB, y: end.y };
  const middle = (a.x + b.x) / 2;
  const low = Math.min(a.x, b.x);
  const high = Math.max(a.x, b.x);
  const byDistance =
    (target: number) =>
    (p: number, q: number): number =>
      Math.abs(p - target) - Math.abs(q - target);
  const channelsX = [
    ...lanes(middle, low, high),
    ...obstacles
      .flatMap((rect) => [rect.x - CLEARANCE, rect.x + rect.width + CLEARANCE])
      .filter((x) => x > low && x < high),
  ].sort(byDistance(middle));
  const centerY = (start.y + end.y) / 2;
  const channelsY = [
    ...lanes(centerY, -Infinity, Infinity),
    ...obstacles.flatMap((rect) => [rect.y - CLEARANCE, rect.y + rect.height + CLEARANCE]),
  ]
    .flatMap((y) => [y, y - LANE_SPACING, y + LANE_SPACING])
    .sort(byDistance(centerY));
  const candidates = [
    ...channelsX.map((x) => [start, { x, y: start.y }, { x, y: end.y }, end]),
    ...channelsY.map((y) => [start, a, { x: a.x, y }, { x: b.x, y }, b, end]),
  ];
  for (const lanesInUse of [used, []]) {
    const clear = candidates.filter((points) => routeClear(points, obstacles, lanesInUse)).slice(0, MAX_CANDIDATES);
    if (clear.length)
      return clear.reduce((best, points) => (routeCost(points, used) < routeCost(best, used) ? points : best));
  }
  return [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
}

function routeEdge(
  start: ArchitecturePoint,
  fromSide: ArchitectureSide,
  end: ArchitecturePoint,
  obstacles: Rect[],
  used: Segment[],
): ArchitecturePoint[] {
  if (fromSide === "left" || fromSide === "right") return routeAlongX(start, end, obstacles, used);
  const flipped = obstacles.map((rect) => ({ x: rect.y, y: rect.x, width: rect.height, height: rect.width }));
  const flippedUsed = used.map(([c, d]): Segment => [transpose(c), transpose(d)]);
  return routeAlongX(transpose(start), transpose(end), flipped, flippedUsed).map(transpose);
}

function selfLoop(rect: Rect): ArchitecturePoint[] {
  const startY = rect.y + rect.height * 0.3;
  const endX = rect.x + rect.width * 0.75;
  return [
    { x: rect.x + rect.width, y: startY },
    { x: rect.x + rect.width + 24, y: startY },
    { x: rect.x + rect.width + 24, y: rect.y - 24 },
    { x: endX, y: rect.y - 24 },
    { x: endX, y: rect.y },
  ];
}

function simplify(points: ArchitecturePoint[]): ArchitecturePoint[] {
  const unique = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y,
  );
  return unique.filter((point, index) => {
    const previous = unique[index - 1];
    const next = unique[index + 1];
    if (!previous || !next) return true;
    return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
  });
}

function roundedPath(points: ArchitecturePoint[]): string {
  const [first, ...rest] = points;
  let d = `M ${round(first!.x)} ${round(first!.y)}`;
  rest.forEach((point, offset) => {
    const previous = points[offset]!;
    const next = rest[offset + 1];
    if (!next) {
      d += ` L ${round(point.x)} ${round(point.y)}`;
      return;
    }
    const before = Math.hypot(point.x - previous.x, point.y - previous.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    const radius = Math.min(CORNER_RADIUS, before / 2, after / 2);
    const enter = {
      x: point.x - ((point.x - previous.x) / before) * radius,
      y: point.y - ((point.y - previous.y) / before) * radius,
    };
    const exit = {
      x: point.x + ((next.x - point.x) / after) * radius,
      y: point.y + ((next.y - point.y) / after) * radius,
    };
    d += ` L ${round(enter.x)} ${round(enter.y)} Q ${round(point.x)} ${round(point.y)} ${round(exit.x)} ${round(exit.y)}`;
  });
  return d;
}

/** Center of the longest segment: in a layered flow that is the open run between two columns. */
function labelAnchor(points: ArchitecturePoint[]): ArchitecturePoint {
  let best = { x: points[0]!.x, y: points[0]!.y };
  let length = -1;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const current = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (current > length) {
      length = current;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

/** Display text and estimated pill width for a 12px label; full text stays available in the SVG title. */
export function architectureLabelBox(label: string, anchor: ArchitecturePoint): ArchitectureEdgeLabel {
  const chars = [...label];
  const text = chars.length > LABEL_MAX_CHARS ? `${chars.slice(0, LABEL_MAX_CHARS - 1).join("")}…` : label;
  const width = [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 12 : 7), 16);
  return { x: round(anchor.x), y: round(anchor.y), width, text };
}

/**
 * A bounded deterministic layout. Explicit positions belong to the author and never move; the rest is layered
 * along connection direction inside group bands, and every edge gets an orthogonal route between facing sides.
 */
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
  const visibleIds = new Set(visible.map((node) => node.id));
  const visibleEdges = diagram.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const tones = new Map(diagram.groups.map((group, index) => [group.id, index % ARCHITECTURE_TONE_COUNT]));
  const authored = visible.filter((node) => node.position);
  // Automatic cards start below authored ones so the two never overlap.
  const authoredBottom = Math.max(0, ...authored.map((node) => node.position!.y + ARCHITECTURE_NODE_HEIGHT));
  const top = authored.length ? authoredBottom + BLOCK_GAP + GROUP_HEADER : MARGIN + 8;
  const automatic = placeAutomatic(
    visible.filter((node) => !node.position),
    visibleEdges,
    top,
  );
  const nodes: ArchitectureLayoutNode[] = visible.map((node) => {
    const point = node.position ?? automatic.get(node.id)!;
    const tone = node.groupId === undefined ? undefined : tones.get(node.groupId);
    return tone === undefined ? { node, x: point.x, y: point.y } : { node, x: point.x, y: point.y, tone };
  });
  const groups: ArchitectureLayoutGroup[] = diagram.groups.flatMap((group) => {
    const members = nodes.filter((item) => item.node.groupId === group.id);
    if (!members.length) return [];
    const minX = Math.min(...members.map((item) => item.x));
    const minY = Math.min(...members.map((item) => item.y));
    const maxX = Math.max(...members.map((item) => item.x + ARCHITECTURE_NODE_WIDTH));
    const maxY = Math.max(...members.map((item) => item.y + ARCHITECTURE_NODE_HEIGHT));
    const x = Math.max(0, minX - GROUP_PADDING);
    const y = Math.max(0, minY - GROUP_HEADER);
    return [
      {
        id: group.id,
        label: group.label,
        x,
        y,
        width: maxX + GROUP_PADDING - x,
        height: maxY + GROUP_PADDING - y,
        tone: tones.get(group.id)!,
      },
    ];
  });

  const byId = new Map(nodes.map((item) => [item.node.id, item]));
  const sides = visibleEdges.map((edge) =>
    edge.from === edge.to ? undefined : chooseSides(rectOf(byId.get(edge.from)!), rectOf(byId.get(edge.to)!)),
  );
  // Edges sharing a side get spread ports, ordered by where the other end sits so they do not cross at the card.
  const ports = new Map<string, Port[]>();
  const center = (id: string, side: ArchitectureSide): number => {
    const item = byId.get(id)!;
    return side === "left" || side === "right"
      ? item.y + ARCHITECTURE_NODE_HEIGHT / 2
      : item.x + ARCHITECTURE_NODE_WIDTH / 2;
  };
  visibleEdges.forEach((edge, edgeIndex) => {
    const pair = sides[edgeIndex];
    if (!pair) return;
    const fromKey = `${edge.from}:${pair[0]}`;
    const toKey = `${edge.to}:${pair[1]}`;
    ports.set(fromKey, [...(ports.get(fromKey) ?? []), { edgeIndex, end: "from", other: center(edge.to, pair[0]) }]);
    ports.set(toKey, [...(ports.get(toKey) ?? []), { edgeIndex, end: "to", other: center(edge.from, pair[1]) }]);
  });
  const anchors = new Map<string, ArchitecturePoint>();
  for (const [key, list] of ports) {
    const [id, side] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1) as ArchitectureSide];
    list.sort((p, q) => p.other - q.other || p.edgeIndex - q.edgeIndex);
    list.forEach((port, index) =>
      anchors.set(`${port.edgeIndex}:${port.end}`, portPoint(rectOf(byId.get(id)!), side, index, list.length)),
    );
  }
  const rects = nodes.map((item) => ({ id: item.node.id, rect: rectOf(item) }));
  const used: Segment[] = [];
  const edges: ArchitectureLayoutEdge[] = visibleEdges.map((edge, edgeIndex) => {
    const pair = sides[edgeIndex];
    const raw = pair
      ? routeEdge(
          anchors.get(`${edgeIndex}:from`)!,
          pair[0],
          anchors.get(`${edgeIndex}:to`)!,
          rects.filter((item) => item.id !== edge.from && item.id !== edge.to).map((item) => item.rect),
          used,
        )
      : selfLoop(rectOf(byId.get(edge.from)!));
    const points = simplify(raw).map((point) => ({ x: round(point.x), y: round(point.y) }));
    for (let index = 1; index < points.length; index++) used.push([points[index - 1]!, points[index]!]);
    const routed: ArchitectureLayoutEdge = {
      ...edge,
      d: roundedPath(points),
      points,
      fromSide: pair?.[0] ?? "right",
      toSide: pair?.[1] ?? "top",
    };
    if (edge.label) routed.labelBox = architectureLabelBox(edge.label, labelAnchor(points));
    return routed;
  });
  const extentX = [
    ...nodes.map((item) => item.x + ARCHITECTURE_NODE_WIDTH),
    ...groups.map((group) => group.x + group.width),
    ...edges.flatMap((edge) => edge.points.map((point) => point.x)),
  ];
  const extentY = [
    ...nodes.map((item) => item.y + ARCHITECTURE_NODE_HEIGHT),
    ...groups.map((group) => group.y + group.height),
    ...edges.flatMap((edge) => edge.points.map((point) => point.y)),
  ];
  return {
    nodes,
    edges,
    groups,
    width: Math.max(320, ...extentX.map((x) => x + MARGIN)),
    height: Math.max(200, ...extentY.map((y) => y + MARGIN)),
  };
}
