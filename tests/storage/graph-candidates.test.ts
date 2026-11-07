import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphQuery } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. The golden file was produced by the implementation that loaded every Session with
// all columns (before the candidate-window change); regenerate it with UPDATE_GRAPH_GOLDEN=1 only on purpose.
const GOLDEN_PATH = join(import.meta.dirname, "fixtures", "graph-candidates.golden.json");
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-graph-candidates-"));
  tempDirs.push(root);
  const databasePath = join(root, "graph.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const roots = [join(root, "alpha"), join(root, "beta"), join(root, "gamma")];
  for (const projectRoot of roots) mkdirSync(projectRoot);
  const projects = roots.map((projectRoot, index) => {
    const project = store.addProject(["alpha", "beta", "gamma"][index]!, projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    return project;
  });
  const sessions: Array<{ id: string; title: string; projectId: string }> = [];
  for (let index = 0; index < 23; index += 1) {
    const projectIndex = index % 3;
    const title = `Session ${String(index).padStart(2, "0")}`;
    const result = store.finalizeSession({
      projectRoot: roots[projectIndex]!,
      idempotencyKey: `graph-candidates-${index}`,
      title,
      summary: `${title} summary.`,
      // Unique timestamps: ties fall back to the random Session id, which no fixture can pin down.
      completedAt: `2026-09-${String(1 + Math.floor(index / 3)).padStart(2, "0")}T12:${String(index).padStart(2, "0")}:00.000Z`,
      changedFiles:
        index % 5 === 0
          ? []
          : ["src/shared.ts", `src/part-${index % 4}.ts`, ...(index % 6 === 0 ? ["src/shared.ts"] : [])],
      verification: index % 4 === 0 ? { status: "failed" } : index % 4 === 1 ? { status: "passed" } : undefined,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    sessions.push({ id: result.session.id, title, projectId: projects[projectIndex]!.id });
    if (index % 2 === 0) {
      store.attachEvidence({
        sessionId: result.session.id,
        kind: "test",
        reference: `pnpm test --filter part-${index}`,
        summary: `Evidence ${index} passed.`,
      });
    }
    if (index % 7 === 0) {
      store.recordKnowledge({
        projectRoot: roots[projectIndex]!,
        idempotencyKey: `graph-candidates-knowledge-${index}`,
        kind: "pattern",
        title: `Knowledge ${index}`,
        body: `Body ${index}.`,
        ...(index % 14 === 0 ? { sessionId: result.session.id } : {}),
      });
    }
  }
  store.updateProject(projects[2]!.id, { status: "paused" });
  store.close();

  const raw = new DatabaseSync(databasePath);
  const idOf = (title: string) => sessions.find((session) => session.title === title)!.id;
  // A voided Session, legacy malformed changed-files JSON, and links inside and outside the tracked scope.
  raw
    .prepare("UPDATE sessions SET voided_at = '2026-10-01T00:00:00.000Z', void_reason = 'fixture' WHERE id = ?")
    .run(idOf("Session 04"));
  raw.prepare("UPDATE sessions SET changed_files_json = 'not json' WHERE id = ?").run(idOf("Session 06"));
  const insertLink = raw.prepare(
    `INSERT INTO session_links (id, session_id, related_session_id, relation, source, created_at)
     VALUES (?, ?, ?, 'related', 'agent', '2026-10-01T00:00:00.000Z')`,
  );
  [
    ["Session 22", "Session 01"],
    ["Session 10", "Session 07"],
    ["Session 19", "Session 02"],
    ["Session 03", "Session 04"],
    ["Session 05", "Session 02"],
  ].forEach(([later, earlier], index) => insertLink.run(`link-${index}`, idOf(later!), idOf(earlier!)));
  // Distinct timestamps keep Knowledge and Evidence order independent of their random ids.
  raw.exec("UPDATE knowledge SET updated_at = printf('2026-10-01T00:00:%02d.000Z', rowid)");
  raw.exec("UPDATE evidence SET captured_at = printf('2026-10-01T00:01:%02d.000Z', rowid)");
  raw.close();

  const reopened = new WorkIntelligenceStore(databasePath);
  stores.push(reopened);
  return { store: reopened, root, projects, sessions };
}

/** Replaces random ids with stable names so results can be compared across runs. */
function normalize(value: unknown, idNames: Map<string, string>): unknown {
  let text = JSON.stringify(value);
  for (const [id, name] of idNames) text = text.split(id).join(name);
  // Project records carry wall-clock timestamps. The link table is read without ORDER BY, so its edges (always
  // appended last) follow the random link ids; sort them by edge id to compare the rest in order.
  return JSON.parse(text, (key, item) => {
    if (key === "createdAt" || key === "updatedAt" || key === "lastIngestedAt") return "<time>";
    if (key === "edges" && Array.isArray(item)) {
      const links = item.filter((edge) => edge.kind === "session_link");
      links.sort((left, right) => (left.id < right.id ? -1 : 1));
      return [...item.filter((edge) => edge.kind !== "session_link"), ...links];
    }
    return item;
  });
}

describe("graph candidate window", () => {
  it("keeps nodes, edges, totals, truncation and order identical to the full-load implementation", () => {
    const { store, root, projects, sessions } = seed();
    // Stored roots are canonical (on Windows: lower-case, 8.3 short names) and JSON escapes their backslashes,
    // so map each project's stored root as it appears in the serialized result before the raw temp root.
    const jsonText = (value: string) => JSON.stringify(value).slice(1, -1);
    const idNames = new Map<string, string>(
      projects.map((project) => [jsonText(project.rootPath), `<root>/${project.name}`] as [string, string]),
    );
    idNames.set(jsonText(root), "<root>");
    for (const project of projects) idNames.set(project.id, `P:${project.name}`);
    for (const session of sessions) idNames.set(session.id, `S:${session.title}`);
    const everything = store.getGraph({ limit: 200, maxNodes: 500, maxEdges: 1_000 });
    if (everything.outcome !== "graph") throw new Error("Expected a graph");
    for (const item of everything.nodes) {
      if (item.kind === "knowledge") idNames.set(item.id.slice("knowledge:".length), `K:${item.label}`);
      if (item.kind === "evidence") idNames.set(item.id.slice("evidence:".length), `E:${item.metadata.reference}`);
    }
    const queries: Array<[string, GraphQuery]> = [
      ["default", {}],
      ["derived (beta only)", { projectId: projects[1]!.id, includeDerived: true, coChangeMinSessions: 2 }],
      ["limit 2 per project", { limit: 2 }],
      ["limit 5 with tight nodes", { limit: 5, maxNodes: 9, maxEdges: 7 }],
      ["tiny nodes", { maxNodes: 3, maxEdges: 2 }],
      ["alpha project", { projectId: projects[0]!.id, limit: 4 }],
      ["first cursor page", { pageSize: 12, limit: 3 }],
    ];
    const results: Record<string, unknown> = {};
    for (const [name, query] of queries) {
      results[name] = store.getGraph(query);
    }
    // Walk the whole cursor chain, as the Web client does.
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = store.getGraph({ pageSize: 14, limit: 4, maxEdges: 60, ...(cursor ? { cursor } : {}) });
      results[`cursor chain ${page}`] = result;
      cursor = result.outcome === "graph" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    const normalized = Object.fromEntries(
      Object.entries(results).map(([name, result]) => [name, normalize(result, idNames)]),
    );

    if (process.env.UPDATE_GRAPH_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) {
      mkdirSync(join(import.meta.dirname, "fixtures"), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;
    expect(Object.keys(normalized)).toEqual(Object.keys(golden));
    for (const name of Object.keys(golden)) {
      expect(normalized[name], name).toEqual(golden[name]);
    }
  });
});
