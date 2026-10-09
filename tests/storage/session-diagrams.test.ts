import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DiagramContentInput } from "../../packages/core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only; the fake token is built at runtime so no complete token sits in the source.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const fakeToken = `ghp_${"C".repeat(36)}`;
const flow = "flowchart LR\n  Hive --> Honey";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(onDisk = false) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-diagrams-"));
  tempDirs.push(root);
  // Deleting a project backs up the database first, which needs a file.
  const store = new WorkIntelligenceStore(onDisk ? join(root, "diagrams.sqlite") : ":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, diagrams?: DiagramContentInput[]) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      changedFiles: [],
      verification: { status: "passed" },
      ...(diagrams ? { diagrams } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result;
  };
  return { store, root, project, finalize };
}

describe("Session diagrams", () => {
  it("saves architecture snapshots, masks JSON values, checks kind identity and transfers/voids/deletes", () => {
    const { store, project, finalize } = setup(true);
    const source = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: "api",
          label: "API",
          description: `deploy ${fakeToken}`,
          source: { path: "apps/server/src/server.ts", line: 1 },
        },
      ],
    });
    const sessionId = finalize("architecture", [{ title: "API", kind: "architecture", formatVersion: 1, source }])
      .session.id;
    const diagram = store.getSessionDetail(sessionId)!.diagrams[0]!;
    expect(diagram).toMatchObject({ kind: "architecture", formatVersion: 1 });
    expect(JSON.parse(diagram.source).nodes[0].description).not.toContain(fakeToken);
    expect(
      store.attachDiagram({ sessionId, idempotencyKey: "extra", title: "API", kind: "architecture", source }),
    ).toMatchObject({ outcome: "diagram_attached", duplicate: false });
    expect(
      store.attachDiagram({
        sessionId,
        idempotencyKey: "extra",
        title: "API",
        kind: "architecture",
        source: JSON.stringify(JSON.parse(source), null, 2),
      }),
    ).toMatchObject({ outcome: "diagram_attached", duplicate: true });
    expect(
      store.attachDiagram({ sessionId, idempotencyKey: "extra", title: "API", source: diagram.source }),
    ).toMatchObject({ outcome: "idempotency_conflict" });
    expect(store.setDiagramVoid({ diagramId: diagram.id, voided: true, reason: "Old snapshot" })).toMatchObject({
      outcome: "diagram_void_updated",
    });
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.session_diagrams[0]?.format_version).toBe(1);
    const sourceRow = bundle.tables.session_diagrams[0]!;
    sourceRow.source = JSON.stringify({
      ...JSON.parse(String(sourceRow.source)),
      nodes: [{ id: "api", label: "API", description: `deploy ${fakeToken}` }],
    });
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    expect(destination.importProjectData({ bundle, remap: [] }).additions.session_diagrams).toBe(2);
    destination.updateProject(destination.listProjects()[0]!.id, { status: "tracked" });
    expect(destination.getSessionDetail(sessionId)?.diagrams[0]).toMatchObject({
      kind: "architecture",
      formatVersion: 1,
      voided: { reason: "Old snapshot" },
    });
    expect(destination.getSessionDetail(sessionId)?.diagrams[0]?.source).not.toContain(fakeToken);
    store.setSessionVoid({ sessionId, voided: true, reason: "Old snapshot" });
    expect(store.deleteSession(sessionId).deletedCounts.sessionDiagrams).toBe(2);
    expect(store.deleteProject(project.id, "Apiary").deletedCounts).toMatchObject({ sessionDiagrams: 0 });
  });

  it("omits masked source locations and bounds growing redaction markers", () => {
    const { store, finalize } = setup();
    const source = JSON.stringify({
      version: 1,
      nodes: [{ id: "api", label: "token=abcdefghi ".repeat(12), source: { path: `src/${fakeToken}.ts` } }],
    });
    const id = finalize("locations", [{ title: "API", kind: "architecture", source }]).session.id;
    const saved = JSON.parse(store.getSessionDetail(id)!.diagrams[0]!.source);
    expect(saved.nodes[0].source).toBeUndefined();
    expect(saved.nodes[0].label.length).toBeLessThanOrEqual(200);
    expect(saved.nodes[0].label).not.toContain("abcdefghi");
  });

  it("imports older Mermaid bundles without a version column", () => {
    const { store, project, finalize } = setup();
    const sessionId = finalize("old", [{ title: "Flow", source: flow }]).session.id;
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    for (const row of bundle.tables.session_diagrams) {
      delete row.format_version;
      // Legacy masking/imports can have produced sources beyond the new-write input limit.
      row.source = `${flow}\n%% ${"legacy ".repeat(3_000)}`;
    }
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    expect(destination.importProjectData({ bundle, remap: [] }).additions.session_diagrams).toBe(1);
    destination.updateProject(destination.listProjects()[0]!.id, { status: "tracked" });
    expect(destination.getSessionDetail(sessionId)?.diagrams[0]?.formatVersion).toBe(1);
  });

  it("attaches a masked diagram idempotently and refuses a different diagram under the same key", () => {
    const { store, finalize } = setup();
    const sessionId = finalize("one").session.id;
    const attached = store.attachDiagram({
      sessionId,
      idempotencyKey: "flow-1",
      title: "Honey flow",
      source: `${flow}\n  %% deploy with ${fakeToken}`,
    });
    expect(attached).toMatchObject({ outcome: "diagram_attached", duplicate: false, redactions: { total: 1 } });
    if (attached.outcome !== "diagram_attached") throw new Error("Expected diagram");
    expect(attached.diagram.source).not.toContain(fakeToken);
    expect(attached.diagram.kind).toBe("mermaid");

    const retried = store.attachDiagram({
      sessionId,
      idempotencyKey: "flow-1",
      title: "Honey flow",
      source: `${flow}\n  %% deploy with ${fakeToken}`,
    });
    expect(retried).toMatchObject({
      outcome: "diagram_attached",
      duplicate: true,
      diagram: { id: attached.diagram.id },
    });
    expect(store.attachDiagram({ sessionId, idempotencyKey: "flow-1", title: "Other", source: flow })).toMatchObject({
      outcome: "idempotency_conflict",
    });
    expect(store.attachDiagram({ sessionId: "missing", idempotencyKey: "x", title: "X", source: flow })).toMatchObject({
      outcome: "not_found",
    });
  });

  it("stores diagrams sent with finalize and lists them in the Session detail", () => {
    const { store, finalize } = setup();
    const result = finalize("with-diagrams", [
      { title: "First", source: flow },
      { title: "Second", source: "sequenceDiagram\n  A->>B: hi" },
    ]);
    const detail = store.getSessionDetail(result.session.id);
    expect(detail?.diagrams.map((diagram) => diagram.title)).toEqual(["First", "Second"]);
    // Retrying the finalize does not add them again.
    finalize("with-diagrams", [{ title: "First", source: flow }]);
    expect(store.getSessionDetail(result.session.id)?.diagrams).toHaveLength(2);
  });

  it("voids and restores a diagram without deleting it, and skips paused projects", () => {
    const { store, project, finalize } = setup();
    const sessionId = finalize("one", [{ title: "Flow", source: flow }]).session.id;
    const [diagram] = store.getSessionDetail(sessionId)!.diagrams;
    expect(store.setDiagramVoid({ diagramId: diagram!.id, voided: true, reason: "Wrong flow." })).toMatchObject({
      outcome: "diagram_void_updated",
      diagram: { voided: { reason: "Wrong flow." } },
    });
    expect(store.getSessionDetail(sessionId)?.diagrams[0]?.voided?.reason).toBe("Wrong flow.");
    const restored = store.setDiagramVoid({ diagramId: diagram!.id, voided: false });
    expect(restored.outcome === "diagram_void_updated" && restored.diagram.voided).toBeUndefined();
    expect(store.setDiagramVoid({ diagramId: "missing", voided: true, reason: "x" })).toMatchObject({
      outcome: "not_found",
    });

    store.updateProject(project.id, { status: "paused" });
    expect(store.attachDiagram({ sessionId, idempotencyKey: "later", title: "Later", source: flow })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("travels with portable exports and is removed with its project", () => {
    const { store, project, finalize } = setup(true);
    finalize("one", [{ title: "Flow", source: flow }]);
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.session_diagrams).toHaveLength(1);
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    expect(destination.importProjectData({ bundle, remap: [] }).additions.session_diagrams).toBe(1);
    expect(store.deleteProject(project.id, "Apiary").deletedCounts).toMatchObject({ sessionDiagrams: 1 });
  });
});
