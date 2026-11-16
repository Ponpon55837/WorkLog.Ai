import { parseArchitectureDiagram } from "../../packages/schema/src/index.js";
import { describe, expect, it } from "vitest";
import {
  redactArchitectureDiagramSource,
  redactDiagramSource,
} from "../../packages/storage/src/diagram-source-redaction.js";

// Fictional fixtures only; the fake token is built at runtime so no complete token sits in the source.
const fakeToken = `ghp_${"D".repeat(36)}`;

function diagram(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    nodes: [
      { id: "hive", label: "Hive" },
      { id: "honey", label: "Honey" },
    ],
    edges: [{ id: "collect", from: "hive", to: "honey" }],
    ...overrides,
  });
}

describe("redactDiagramSource", () => {
  it("masks plain text for non-architecture kinds without parsing it as JSON", () => {
    const result = redactDiagramSource(`flowchart LR\n  Hive --> ${fakeToken}`, "flowchart");
    expect(result.value).not.toContain(fakeToken);
    expect(result.redactions.total).toBeGreaterThan(0);
  });

  it("routes architecture kinds through the structured redactor", () => {
    const result = redactDiagramSource(diagram(), "architecture");
    expect(parseArchitectureDiagram(result.value)).toBeDefined();
    expect(result.redactions.total).toBe(0);
  });
});

describe("redactArchitectureDiagramSource", () => {
  it("rejects invalid architecture sources", () => {
    expect(() => redactArchitectureDiagramSource("not json")).toThrow("Invalid architecture diagram.");
    expect(() => redactArchitectureDiagramSource(JSON.stringify({ version: 2, nodes: [] }))).toThrow(
      "Invalid architecture diagram.",
    );
  });

  it("keeps clean descriptions, labels and source paths, and handles their absence", () => {
    const source = diagram({
      nodes: [
        { id: "hive", label: "Hive", description: "Collects honey", groupId: "farm", source: { path: "src/hive.ts" } },
        { id: "honey", label: "Honey" },
      ],
      groups: [
        { id: "farm", label: "Farm", description: "All farm parts" },
        { id: "bare", label: "Bare" },
      ],
      edges: [
        { id: "collect", from: "hive", to: "honey", label: "flows" },
        { id: "plain", from: "honey", to: "hive" },
      ],
      paths: [{ id: "trip", label: "Trip", edgeIds: ["collect", "plain"] }],
    });
    const result = redactArchitectureDiagramSource(source);
    const parsed = parseArchitectureDiagram(result.value)!;
    expect(result.redactions.total).toBe(0);
    expect(parsed.nodes[0]).toMatchObject({ description: "Collects honey", source: { path: "src/hive.ts" } });
    expect(parsed.nodes[1]!.description).toBeUndefined();
    expect(parsed.groups[0]!.description).toBe("All farm parts");
    expect(parsed.groups[1]!.description).toBeUndefined();
    expect(parsed.edges[0]!.label).toBe("flows");
    expect(parsed.edges[1]!.label).toBeUndefined();
    expect(parsed.paths[0]!.label).toBe("Trip");
  });

  it("keeps maximum-length labels and descriptions within bounds", () => {
    const longLabel = "L".repeat(200);
    const longDescription = "D".repeat(1_000);
    const result = redactArchitectureDiagramSource(
      diagram({
        nodes: [
          { id: "hive", label: longLabel, description: longDescription },
          { id: "honey", label: "Honey" },
        ],
        groups: [{ id: "farm", label: longLabel, description: longDescription }],
        edges: [{ id: "collect", from: "hive", to: "honey", label: longLabel }],
      }),
    );
    const parsed = parseArchitectureDiagram(result.value)!;
    expect(parsed.nodes[0]).toMatchObject({ label: longLabel, description: longDescription });
    expect(parsed.groups[0]).toMatchObject({ label: longLabel, description: longDescription });
    expect(parsed.edges[0]!.label).toBe(longLabel);
  });

  it("masks secrets in text and drops a source path that contains one", () => {
    const result = redactArchitectureDiagramSource(
      diagram({
        nodes: [
          {
            id: "hive",
            label: "Hive",
            description: `deploy ${fakeToken}`,
            source: { path: `src/${fakeToken}.ts`, line: 3 },
          },
          { id: "honey", label: "Honey", source: { path: "src/honey.ts", line: 9 } },
        ],
      }),
    );
    const parsed = parseArchitectureDiagram(result.value)!;
    expect(result.value).not.toContain(fakeToken);
    expect(result.redactions.total).toBeGreaterThan(0);
    expect(parsed.nodes[0]!.description).not.toContain(fakeToken);
    expect(parsed.nodes[0]!.source).toBeUndefined();
    expect(parsed.nodes[1]!.source).toEqual({ path: "src/honey.ts", line: 9 });
  });
});
