import { describe, expect, it } from "vitest";
import {
  architectureDiagramSchema,
  attachDiagramInputSchema,
  finalizeSessionInputSchema,
  parseArchitectureDiagram,
} from "../../packages/schema/src/index.js";

const data = {
  version: 1,
  nodes: [
    { id: "web", label: "Web", groupId: "client" },
    { id: "api", label: "API" },
  ],
  groups: [{ id: "client", label: "Client" }],
  edges: [{ id: "request", from: "web", to: "api" }],
  paths: [{ id: "save", label: "Save", edgeIds: ["request"] }],
};
const base = { sessionId: "session", idempotencyKey: "diagram", title: "Flow" };

describe("architecture diagram input", () => {
  it("accepts bounded versioned data and rejects legacy or implicit new writes", () => {
    expect(
      attachDiagramInputSchema.parse({ ...base, kind: "architecture", formatVersion: 1, source: JSON.stringify(data) })
        .kind,
    ).toBe("architecture");
    for (const input of [
      { ...base, source: "flowchart LR; A --> B" },
      { ...base, kind: "mermaid", formatVersion: 1, source: "flowchart LR; A --> B" },
      { ...base, kind: "architecture", source: JSON.stringify(data) },
      { ...base, formatVersion: 1, source: JSON.stringify(data) },
    ])
      expect(attachDiagramInputSchema.safeParse(input).success).toBe(false);
    expect(attachDiagramInputSchema.safeParse({ ...base, source: "x".repeat(20_001) }).success).toBe(false);
    expect(parseArchitectureDiagram(JSON.stringify({ version: 1, nodes: [{ id: "a", label: "A" }] }))?.edges).toEqual(
      [],
    );
    expect(parseArchitectureDiagram("{broken")).toBeUndefined();
    expect(parseArchitectureDiagram("x".repeat(100_001))).toBeUndefined();
  });
  it.each([
    { ...data, version: 2 },
    { version: 1, nodes: [{ id: `sk-${"a".repeat(20)}`, label: "A" }] },
    { ...data, script: "alert(1)" },
    { ...data, nodes: [...data.nodes, data.nodes[0]] },
    { ...data, groups: [] },
    { ...data, edges: [{ id: "request", from: "web", to: "missing" }] },
    { ...data, paths: [{ id: "save", label: "Save", edgeIds: ["missing"] }] },
    { ...data, paths: [{ id: "save", label: "Save", edgeIds: ["request", "request"] }] },
    { version: 1, nodes: [{ id: "a", label: "A", source: { path: "../secret" } }] },
    { version: 1, nodes: [{ id: "a", label: "A", source: { path: "https://example.com" } }] },
    { version: 1, nodes: [{ id: "a", label: "A", source: { path: "/tmp/secret" } }] },
    { version: 1, nodes: [{ id: "a", label: "A", position: { x: Infinity, y: 0 } }] },
    { version: 1, nodes: Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, label: "N" })) },
  ])("rejects malformed, unsafe or inconsistent data %#", (invalid) => {
    expect(architectureDiagramSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects unsupported envelope versions and architecture JSON in finalize", () => {
    expect(
      attachDiagramInputSchema.safeParse({
        ...base,
        kind: "architecture",
        formatVersion: 2,
        source: JSON.stringify(data),
      }).success,
    ).toBe(false);
    expect(
      finalizeSessionInputSchema.safeParse({
        projectRoot: "/fictional",
        idempotencyKey: "session",
        title: "Flow",
        summary: "Result",
        changedFiles: [],
        verification: { status: "passed" },
        diagrams: [{ title: "Flow", kind: "architecture", source: "{}" }],
      }).success,
    ).toBe(false);
  });
});
