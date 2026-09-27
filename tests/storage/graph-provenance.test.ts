import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../packages/core/src/index.js";
import { coChangedEdges, shortestPath } from "../../packages/storage/src/graph-derivation.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-graph-provenance-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, changedFiles: string[]) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, root, project, finalize };
}

const node = (id: string, label = id): GraphNode => ({ id, kind: "file", label, metadata: {} });
const edge = (from: string, to: string): GraphEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: "changed_file",
  provenance: "recorded",
});

describe("graph derivation helpers", () => {
  it("counts co-changed pairs once per Session and keeps pairs at or above the threshold", () => {
    const ids = new Set(["file:p:a.ts", "file:p:b.ts", "file:p:c.ts"]);
    const sessions = [
      { projectId: "p", changedFiles: ["a.ts", "b.ts", "b.ts"] },
      { projectId: "p", changedFiles: ["b.ts", "a.ts", "c.ts"] },
      { projectId: "p", changedFiles: ["a.ts", "b.ts", "unloaded.ts"] },
      { projectId: "p", changedFiles: Array.from({ length: 21 }, (_, index) => `n${index}.ts`).concat("a.ts", "c.ts") },
    ];
    expect(coChangedEdges(sessions, ids, 3)).toEqual([
      {
        id: "co-changed:file:p:a.ts:file:p:b.ts",
        from: "file:p:a.ts",
        to: "file:p:b.ts",
        kind: "co_changed",
        provenance: "derived",
        reason: "3 筆 Session 同時修改了這兩個檔案",
      },
    ]);
    expect(coChangedEdges(sessions, ids, 2)).toHaveLength(1);
    expect(coChangedEdges(sessions, ids, 1)).toHaveLength(3);
  });

  it("finds the shortest undirected path breadth-first", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id));
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "e"), edge("d", "e")];
    expect(shortestPath(nodes, edges, "a", "d")?.map((step) => step.to.id)).toEqual(["e", "d"]);
    expect(shortestPath(nodes, edges, "d", "a")?.map((step) => step.edge.id)).toEqual(["d->e", "a->e"]);
    expect(shortestPath(nodes, edges, "a", "a")).toEqual([]);
    expect(shortestPath([...nodes, node("lonely")], edges, "a", "lonely")).toBeUndefined();
    expect(shortestPath(nodes, edges, "a", "missing")).toBeUndefined();
  });
});

describe("graph provenance and paths", () => {
  it("marks recorded edges and adds derived co_changed edges only on request", () => {
    const { store, root, finalize } = setup();
    for (const key of ["one", "two", "three"]) finalize(key, ["src/frames.ts", "src/queen.ts"]);

    const plain = store.getGraph({ projectRoot: root });
    if (plain.outcome !== "graph") throw new Error("Expected graph");
    expect(plain.edges.every((item) => item.provenance === "recorded")).toBe(true);
    expect(plain.edges.some((item) => item.kind === "co_changed")).toBe(false);

    const derived = store.getGraph({ projectRoot: root, includeDerived: true });
    if (derived.outcome !== "graph") throw new Error("Expected graph");
    expect(derived.edges.filter((item) => item.kind === "co_changed")).toEqual([
      expect.objectContaining({ provenance: "derived", reason: "3 筆 Session 同時修改了這兩個檔案" }),
    ]);
    const stricter = store.getGraph({ projectRoot: root, includeDerived: true, coChangeMinSessions: 4 });
    expect(stricter.outcome === "graph" && stricter.edges.some((item) => item.kind === "co_changed")).toBe(false);
  });

  it("explains the path between a Session and a file it did not change, step by step", () => {
    const { store, root, project, finalize } = setup();
    const planning = finalize("planning", ["docs/plan.md"]);
    finalize("building", ["docs/plan.md", "src/frames.ts"]);

    const result = store.getGraphPath({
      projectRoot: root,
      from: `session:${planning}`,
      to: `file:${project.id}:src/frames.ts`,
    });
    expect(result).toMatchObject({ outcome: "graph_path", found: true });
    if (result.outcome !== "graph_path") throw new Error("Expected path");
    expect(result.steps.map((step) => step.reason)).toEqual([
      "Session「Session planning」修改了 docs/plan.md",
      "Session「Session building」修改了 docs/plan.md",
      "Session「Session building」修改了 src/frames.ts",
    ]);

    expect(store.getGraphPath({ projectRoot: root, from: `session:${planning}`, to: "file:none" })).toMatchObject({
      outcome: "graph_path",
      found: false,
      steps: [],
    });
  });
});
