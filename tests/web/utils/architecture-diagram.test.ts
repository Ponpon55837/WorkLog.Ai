import { describe, expect, it } from "vitest";
import type { ArchitectureDiagram } from "../../../packages/schema/src/architecture-diagram.js";
import { layoutArchitecture } from "../../../apps/web/src/utils/architecture-diagram";

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
