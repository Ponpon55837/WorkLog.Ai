import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChangedFiles } from "../../packages/storage/src/session-record-codecs.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. The column has no CHECK constraint, so legacy rows can hold values that are not a string array.
const LEGACY_VALUES = [
  { label: "null", value: "null", files: [] as string[] },
  { label: "not json", value: "not json", files: [] as string[] },
  { label: "object", value: '{"a":1}', files: [] as string[] },
  { label: "mixed entries", value: '[1,"a.ts",null]', files: ["a.ts"] },
];

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup(value: string) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-legacy-files-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Kiln", root);
  store.updateProject(project.id, { status: "tracked" });
  const ids: string[] = [];
  for (const [index, files] of [
    ["src/kiln/glaze.ts", "src/kiln/fire.ts"],
    ["src/kiln/glaze.ts", "src/kiln/fire.ts"],
    ["src/kiln/glaze.ts", "src/kiln/fire.ts"],
  ].entries()) {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `legacy-${index}`,
      title: `Glaze session ${index}`,
      summary: "Tuned the fictional glaze schedule.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: files,
      verification: { status: "passed" },
      completedAt: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
    });
    if (result.outcome !== "finalized") throw new Error("Expected fixture Session");
    ids.push(result.session.id);
  }
  const db = (
    store as unknown as {
      db: { prepare(sql: string): { run(...values: unknown[]): unknown }; exec(sql: string): void };
    }
  ).db;
  db.prepare("UPDATE sessions SET changed_files_json = ? WHERE id = ?").run(value, ids[0]);
  db.exec("INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions");
  return { store, root, project, ids };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parseChangedFiles", () => {
  it("returns a string array as is and drops other values", () => {
    const list = '["a.ts","b.ts"]';
    expect(parseChangedFiles(list)).toEqual(["a.ts", "b.ts"]);
    for (const empty of [null, undefined, "", "null", "not json", "{}", '"a.ts"', "7"]) {
      expect(parseChangedFiles(empty)).toEqual([]);
    }
    expect(parseChangedFiles('[1,"a.ts",null,["b.ts"]]')).toEqual(["a.ts"]);
  });
});

describe.each(LEGACY_VALUES)("changed_files_json holding $label", ({ value, files }) => {
  it("reads the Session through get and list", () => {
    const { store, ids, project } = setup(value);
    expect(store.getSessionById(ids[0]!)?.changedFiles).toEqual(files);
    expect(store.getSessionDetail(ids[0]!)).toBeDefined();
    const listed = store.listSessions({ projectId: project.id });
    expect(listed.find((session) => session.id === ids[0])?.changedFiles).toEqual(files);
    expect(store.listSessionsPage({ projectId: project.id, query: "a.ts" }).items.length).toBeGreaterThanOrEqual(0);
  });

  it("builds the graph with derived edges", () => {
    const { store, root } = setup(value);
    const graph = store.getGraph({ projectRoot: root, includeDerived: true });
    expect(graph.outcome).toBe("graph");
    expect(() => store.getGraph({ projectRoot: root, includeDerived: true, coChangeMinSessions: 2 })).not.toThrow();
  });

  it("answers getContext, recall and index sync", () => {
    const { store, root } = setup(value);
    expect(() => store.syncSearchIndex()).not.toThrow();
    expect(() => store.getContext(root, { paths: ["src/kiln/glaze.ts"] })).not.toThrow();
    expect(() => store.getContext(root)).not.toThrow();
    expect(() => store.recall({ projectRoot: root, q: "glaze" })).not.toThrow();
    expect(() => store.recall({ projectRoot: root, paths: ["src/kiln/glaze.ts"] })).not.toThrow();
  });

  it("answers related work for the corrupt Session and for its neighbours", () => {
    const { store, ids } = setup(value);
    for (const id of ids) expect(() => store.getRelatedWork(id)).not.toThrow();
    const neighbour = store.getRelatedWork(ids[1]!);
    expect(neighbour.outcome).toBe("related_work");
  });

  it("answers file history, hotspots, reports and exports", () => {
    const { store, root, project } = setup(value);
    expect(() => store.getFileHistory({ projectRoot: root, paths: ["src/kiln/glaze.ts"] })).not.toThrow();
    expect(() => store.getHotspots({ projectRoot: root })).not.toThrow();
    expect(() => store.getHotspots({ projectRoot: root, groupBy: "directory" })).not.toThrow();
    const report = store.getReport({ period: "year", date: "2026-01-15", projectId: project.id });
    expect(report.outcome).toBe("report");
    expect(() =>
      store.exportReport({ period: "year", date: "2026-01-15", projectId: project.id, format: "markdown" }),
    ).not.toThrow();
    expect(() => store.exportProjectData({ type: "project", projectId: project.id })).not.toThrow();
    expect(() => store.getSessionDetailForAgent({ sessionId: setupFirstId(store, project.id) })).not.toThrow();
  });
});

function setupFirstId(store: WorkIntelligenceStore, projectId: string): string {
  return store.listSessions({ projectId })[0]!.id;
}
