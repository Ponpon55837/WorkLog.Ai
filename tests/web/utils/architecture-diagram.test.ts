import { describe, expect, it } from "vitest";
import type { ArchitectureDiagram } from "../../../packages/schema/src/architecture-diagram.js";
import { architectureLabelBox, layoutArchitecture } from "../../../apps/web/src/utils/architecture-diagram";

const diagram: ArchitectureDiagram = {
  version: 1,
  nodes: [
    { id: "web", label: "Web", groupId: "client" },
    { id: "api", label: "API", groupId: "server", position: { x: 360, y: 48 } },
    { id: "db", label: "Database", groupId: "server", position: { x: 360, y: 240 } },
    { id: "worker", label: "Worker" },
  ],
  groups: [
    { id: "client", label: "Client" },
    { id: "server", label: "Server" },
    { id: "empty", label: "Empty" },
  ],
  edges: [
    { id: "request", from: "web", to: "api" },
    { id: "save", from: "api", to: "db" },
    { id: "report", from: "db", to: "worker" },
    { id: "cycle", from: "worker", to: "web" },
    { id: "self", from: "web", to: "web" },
  ],
  paths: [],
};

const flow: ArchitectureDiagram = {
  version: 1,
  groups: [
    { id: "client", label: "Client" },
    { id: "edge", label: "Edge" },
    { id: "core", label: "Core" },
    { id: "data", label: "Data" },
  ],
  nodes: [
    { id: "browser", label: "Browser", groupId: "client" },
    { id: "cli", label: "CLI", groupId: "client" },
    { id: "gateway", label: "Gateway", groupId: "edge" },
    { id: "auth", label: "Auth", groupId: "edge" },
    { id: "orders", label: "Orders", groupId: "core" },
    { id: "billing", label: "Billing", groupId: "core" },
    { id: "notify", label: "Notify", groupId: "core" },
    { id: "sql", label: "SQL", groupId: "data" },
    { id: "cache", label: "Cache", groupId: "data" },
    { id: "queue", label: "Queue" },
  ],
  edges: [
    { id: "e1", from: "browser", to: "gateway", label: "HTTPS" },
    { id: "e2", from: "cli", to: "gateway", label: "HTTPS" },
    { id: "e3", from: "gateway", to: "auth", label: "verify" },
    { id: "e4", from: "gateway", to: "orders" },
    { id: "e5", from: "orders", to: "billing" },
    { id: "e6", from: "orders", to: "sql" },
    { id: "e7", from: "billing", to: "sql" },
    { id: "e8", from: "orders", to: "cache" },
    { id: "e9", from: "billing", to: "queue" },
    { id: "e10", from: "queue", to: "notify" },
    { id: "e11", from: "notify", to: "browser", label: "push" },
    { id: "e12", from: "auth", to: "cache" },
  ],
  paths: [],
};

type Box = { x: number; y: number; width: number; height: number };

function cardOf(layout: ReturnType<typeof layoutArchitecture>, id: string): Box {
  const item = layout.nodes.find((node) => node.node.id === id)!;
  return { x: item.x, y: item.y, width: 200, height: 86 };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether an axis-aligned segment enters a card's interior. */
function crossesCard(a: { x: number; y: number }, b: { x: number; y: number }, card: Box): boolean {
  return (
    Math.max(a.x, b.x) > card.x &&
    Math.min(a.x, b.x) < card.x + card.width &&
    Math.max(a.y, b.y) > card.y &&
    Math.min(a.y, b.y) < card.y + card.height
  );
}

describe("architecture reader layout", () => {
  it("keeps authored positions, bounds grouped and ungrouped cards, and connects vertical, backward and self edges", () => {
    const layout = layoutArchitecture(diagram);
    expect(layout.nodes.find((item) => item.node.id === "api")).toMatchObject({ x: 360, y: 48 });
    expect(layout.groups.map((group) => group.id)).toEqual(["client", "server"]);
    expect(layout.edges).toHaveLength(5);
    expect(layout.edges.find((edge) => edge.id === "save")?.d).toMatch(/360|460/);
    expect(
      layout.nodes.every(
        (node) => node.x >= 0 && node.y >= 0 && node.x + 200 <= layout.width && node.y + 86 <= layout.height,
      ),
    ).toBe(true);
    expect(layout.edges.every((edge) => !/NaN|Infinity/.test(edge.d))).toBe(true);
  });
  it("limits a group to its own nodes and internal edges, and follows direct neighbors across groups", () => {
    const group = layoutArchitecture(diagram, "server");
    expect(group.nodes.map((item) => item.node.id)).toEqual(["api", "db"]);
    expect(group.edges.map((edge) => edge.id)).toEqual(["save"]);
    const local = layoutArchitecture(diagram, "", "api");
    expect(local.nodes.map((item) => item.node.id)).toEqual(["web", "api", "db"]);
    expect(local.edges.map((edge) => edge.id)).toEqual(["request", "save", "self"]);
    expect(layoutArchitecture(diagram, "empty").nodes).toEqual([]);
  });
  it("lays out the supported 200-node bound without overlapping automatic cards or dropping disconnected nodes", () => {
    const data: ArchitectureDiagram = {
      version: 1,
      nodes: Array.from({ length: 200 }, (_, index) => ({ id: `n${index}`, label: `Node ${index}` })),
      edges: [],
      groups: [],
      paths: [],
    };
    const layout = layoutArchitecture(data);
    expect(layout.nodes).toHaveLength(200);
    expect(new Set(layout.nodes.map((item) => `${item.x}:${item.y}`)).size).toBe(200);
    expect(layout.nodes[3]!.y).toBeGreaterThan(layout.nodes[0]!.y);
    expect(layout.groups).toEqual([]);
    expect(layoutArchitecture({ ...data, nodes: [], edges: [{ id: "missing", from: "a", to: "b" }] }).edges).toEqual(
      [],
    );
  });
});

describe("architecture layered placement", () => {
  it("orders group blocks left to right along their links, with a cycle turned back at its declared entry", () => {
    const layout = layoutArchitecture(flow);
    const left = (id: string) => cardOf(layout, id).x;
    expect(left("browser")).toBeLessThan(left("gateway"));
    expect(left("gateway")).toBeLessThan(left("auth"));
    expect(left("gateway")).toBeLessThan(left("orders"));
    expect(left("orders")).toBeLessThan(left("billing"));
    expect(left("billing")).toBeLessThan(left("sql"));
    // notify → browser closes a cycle; the declared entry (browser) still starts the flow.
    expect(left("browser")).toBe(Math.min(...layout.nodes.map((item) => item.x)));
  });
  it("keeps the drawing compact: blocks in one column stack instead of stepping down one band per group", () => {
    const layout = layoutArchitecture(flow);
    expect(layout.height).toBeLessThan(layout.width);
    expect(layout.height).toBeLessThan(700);
    for (const [index, a] of layout.groups.entries())
      for (const b of layout.groups.slice(index + 1)) expect(overlaps(a, b)).toBe(false);
    for (const [index, a] of layout.nodes.entries())
      for (const b of layout.nodes.slice(index + 1))
        expect(overlaps(cardOf(layout, a.node.id), cardOf(layout, b.node.id))).toBe(false);
  });
  it("assigns group tones by declaration order and leaves ungrouped cards neutral", () => {
    const layout = layoutArchitecture(flow);
    expect(layout.groups.map((group) => group.tone)).toEqual([0, 1, 2, 3]);
    expect(layout.nodes.find((item) => item.node.id === "gateway")?.tone).toBe(1);
    expect(layout.nodes.find((item) => item.node.id === "queue")?.tone).toBeUndefined();
    // Filtering keeps a group's tone so colors do not shift between views.
    expect(layoutArchitecture(flow, "data").groups[0]?.tone).toBe(3);
  });
  it("never moves authored positions and places automatic cards clear of them", () => {
    const mixed: ArchitectureDiagram = {
      ...flow,
      nodes: flow.nodes.map((node) => (node.id === "gateway" ? { ...node, position: { x: 700, y: 300 } } : node)),
    };
    const layout = layoutArchitecture(mixed);
    expect(layout.nodes.find((item) => item.node.id === "gateway")).toMatchObject({ x: 700, y: 300 });
    const authored = cardOf(layout, "gateway");
    for (const item of layout.nodes)
      if (item.node.id !== "gateway") expect(overlaps(authored, cardOf(layout, item.node.id))).toBe(false);
  });
});

describe("architecture connection routing", () => {
  it("connects facing sides: sideways between columns, vertically within a column, leftward for back links", () => {
    const placed = layoutArchitecture({
      version: 1,
      nodes: [
        { id: "web", label: "Web", position: { x: 40, y: 40 } },
        { id: "api", label: "API", position: { x: 360, y: 40 } },
        { id: "db", label: "DB", position: { x: 360, y: 240 } },
      ],
      edges: [
        { id: "request", from: "web", to: "api" },
        { id: "save", from: "api", to: "db" },
      ],
      groups: [],
      paths: [],
    });
    const sides = Object.fromEntries(placed.edges.map((edge) => [edge.id, [edge.fromSide, edge.toSide]]));
    expect(sides.request).toEqual(["right", "left"]);
    expect(sides.save).toEqual(["bottom", "top"]);
    const back = layoutArchitecture({
      version: 1,
      nodes: [
        { id: "a", label: "A", position: { x: 40, y: 40 } },
        { id: "b", label: "B", position: { x: 400, y: 40 } },
      ],
      edges: [{ id: "back", from: "b", to: "a" }],
      groups: [],
      paths: [],
    });
    expect([back.edges[0]?.fromSide, back.edges[0]?.toSide]).toEqual(["left", "right"]);
  });
  it("spreads links that share a card side across distinct ports", () => {
    const layout = layoutArchitecture(flow);
    const fromOrders = layout.edges.filter((edge) => edge.from === "orders" && edge.fromSide === "right");
    expect(fromOrders.length).toBeGreaterThan(1);
    expect(new Set(fromOrders.map((edge) => edge.points[0]!.y)).size).toBe(fromOrders.length);
  });
  it("draws orthogonal routes with rounded corners that go around cards in the way", () => {
    const blocked = layoutArchitecture({
      version: 1,
      nodes: [
        { id: "a", label: "A", position: { x: 40, y: 100 } },
        { id: "wall", label: "Wall", position: { x: 340, y: 100 } },
        { id: "b", label: "B", position: { x: 640, y: 100 } },
      ],
      edges: [{ id: "over", from: "a", to: "b" }],
      groups: [],
      paths: [],
    });
    const edge = blocked.edges[0]!;
    expect(edge.d).toMatch(/ Q /);
    for (let index = 1; index < edge.points.length; index++) {
      const [a, b] = [edge.points[index - 1]!, edge.points[index]!];
      expect(a.x === b.x || a.y === b.y).toBe(true);
      expect(crossesCard(a, b, cardOf(blocked, "wall"))).toBe(false);
    }
  });
  it("keeps routes off every card except their own ends and apart from parallel runs", () => {
    const layout = layoutArchitecture(flow);
    for (const edge of layout.edges)
      for (const item of layout.nodes) {
        if (item.node.id === edge.from || item.node.id === edge.to) continue;
        for (let index = 1; index < edge.points.length; index++)
          expect(crossesCard(edge.points[index - 1]!, edge.points[index]!, cardOf(layout, item.node.id))).toBe(false);
      }
    // Interior runs only: port stubs next to a shared card may meet.
    const runs = layout.edges.flatMap((edge) =>
      edge.points.slice(2, -1).map((point, index) => ({ id: edge.id, a: edge.points[index + 1]!, b: point })),
    );
    const span = (p: number, q: number, r: number, s: number) =>
      Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s));
    for (const [index, first] of runs.entries())
      for (const second of runs.slice(index + 1)) {
        if (first.id === second.id) continue;
        if (first.a.x === first.b.x && second.a.x === second.b.x && first.a.x === second.a.x)
          expect(span(first.a.y, first.b.y, second.a.y, second.b.y)).toBeLessThanOrEqual(0);
        if (first.a.y === first.b.y && second.a.y === second.b.y && first.a.y === second.a.y)
          expect(span(first.a.x, first.b.x, second.a.x, second.b.x)).toBeLessThanOrEqual(0);
      }
  });
  it("places a visible label pill on labeled links only, shortening long labels", () => {
    const layout = layoutArchitecture(flow);
    expect(layout.edges.find((edge) => edge.id === "e3")?.labelBox).toMatchObject({ text: "verify" });
    expect(layout.edges.find((edge) => edge.id === "e5")?.labelBox).toBeUndefined();
    const box = architectureLabelBox("x".repeat(80), { x: 10, y: 20 });
    expect([...box.text]).toHaveLength(28);
    expect(box.text.endsWith("…")).toBe(true);
    expect(architectureLabelBox("寫入", { x: 0, y: 0 }).width).toBeGreaterThan(
      architectureLabelBox("ab", { x: 0, y: 0 }).width,
    );
  });
});
