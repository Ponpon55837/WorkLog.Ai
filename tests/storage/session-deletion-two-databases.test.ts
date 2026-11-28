import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataImportStrategy } from "../../packages/core/src/index.js";
import { readProjectDataImportFile } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

interface Machine {
  store: WorkIntelligenceStore;
  directory: string;
  projectRoot: string;
}

function machine(name: string): Machine {
  const directory = mkdtempSync(join(tmpdir(), `work-intelligence-session-two-db-${name}-`));
  tempDirs.push(directory);
  const projectRoot = join(directory, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(join(directory, "work-intelligence.sqlite"));
  stores.push(store);
  return { store, directory, projectRoot };
}

function finalize(on: Machine, key: string): string {
  const result = on.store.finalizeSession({
    projectRoot: on.projectRoot,
    idempotencyKey: key,
    title: `Synthetic ${key}`,
    summary: `Synthetic summary for ${key}.`,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [`Follow up on ${key}.`] },
    handoffContent: `Synthetic handoff for ${key}.`,
    changedFiles: ["src/fixture.ts"],
    verification: { status: "passed" },
    events: [{ type: "execution", summary: `Synthetic event for ${key}.` }],
  });
  if (result.outcome !== "finalized") throw new Error("Expected the synthetic Session to be finalized");
  return result.session.id;
}

function exportFile(from: Machine, projectId: string, strategy: ProjectDataImportStrategy, name: string) {
  const path = join(from.directory, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({ bundle: from.store.exportProjectData({ type: "project", projectId }), strategy }),
  );
  return path;
}

function previewAndApply(into: Machine, path: string) {
  const input = readProjectDataImportFile(path, { envelope: "request", spillPath: join(into.directory, "spill") });
  try {
    const preview = into.store.previewProjectDataImport(input);
    const applied = into.store.importProjectData(input);
    return { preview, applied };
  } finally {
    input.dispose();
  }
}

function sessionIds(on: Machine): string[] {
  return on.store
    .listSessions({ limit: 50 })
    .map((session) => session.id)
    .sort();
}

function twoMachines() {
  const a = machine("a");
  const project = a.store.addProject("Apiary", a.projectRoot);
  a.store.updateProject(project.id, { status: "tracked" });
  const sessionId = finalize(a, "hive-inspection");
  const b = machine("b");
  const seeded = readProjectDataImportFile(exportFile(a, project.id, "merge", "seed"), {
    envelope: "request",
    spillPath: join(b.directory, "seed-spill"),
  });
  try {
    b.store.importProjectData(seeded);
  } finally {
    seeded.dispose();
  }
  b.store.updateProject(project.id, { status: "tracked" });
  const bRoot = b.store.listProjects().find((item) => item.id === project.id)?.rootPath;
  if (!bRoot) throw new Error("Expected the project on B");
  return { a, b: { ...b, projectRoot: bRoot }, projectId: project.id, sessionId };
}

function deleteOnA(a: Machine, sessionId: string): void {
  a.store.setSessionVoid({ sessionId, voided: true, reason: "Recorded as a test." });
  a.store.deleteSession(sessionId);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("importing between two independent databases after a Session was permanently deleted on one", () => {
  it.each(["merge", "newer-wins"] as const)(
    "does not bring the Session back from an unchanged copy (%s)",
    (strategy) => {
      const { a, b, projectId, sessionId } = twoMachines();
      expect(sessionIds(b)).toEqual([sessionId]);
      deleteOnA(a, sessionId);

      const { preview, applied } = previewAndApply(a, exportFile(b, projectId, strategy, "from-b"));

      expect(preview.additions.sessions ?? 0).toBe(0);
      expect(preview.additions.outstanding_items ?? 0).toBe(0);
      expect(preview.conflicts.sessions).toBe(1);
      expect(preview.conflictGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "sessions", category: "deleted", count: 1, sampleIds: [sessionId] }),
          expect.objectContaining({ table: "outstanding_items", category: "dependency" }),
        ]),
      );
      expect(applied.additions).toEqual(preview.additions);
      expect(applied.conflicts).toEqual(preview.conflicts);
      expect(applied.conflictGroups).toEqual(preview.conflictGroups);
      expect(sessionIds(a)).toEqual([]);
    },
  );

  it("does not bring the Session back when the other database changed it after the deletion", () => {
    const { a, b, projectId, sessionId } = twoMachines();
    deleteOnA(a, sessionId);
    b.store.updateSessionSummary({
      sessionId,
      idempotencyKey: "later-edit",
      mode: "append",
      summary: "Added after the other computer deleted it.",
    });

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "newer-wins", "from-b"));

    expect(preview.additions.sessions ?? 0).toBe(0);
    expect(preview.conflictGroups).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "sessions", category: "deleted" })]),
    );
    expect(applied.additions).toEqual(preview.additions);
    expect(applied.conflicts).toEqual(preview.conflicts);
    expect(sessionIds(a)).toEqual([]);
  });

  it("adds a different Session from the same file normally", () => {
    const { a, b, projectId, sessionId } = twoMachines();
    const otherId = finalize(b, "honey-harvest");
    deleteOnA(a, sessionId);

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(preview.additions.sessions).toBe(1);
    expect(preview.conflicts.sessions).toBe(1);
    expect(applied.additions).toEqual(preview.additions);
    expect(applied.conflicts).toEqual(preview.conflicts);
    expect(sessionIds(a)).toEqual([otherId]);
  });

  it("imports normally when nothing was deleted", () => {
    const { a, b, projectId, sessionId } = twoMachines();
    const otherId = finalize(b, "honey-harvest");

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(preview.additions.sessions).toBe(1);
    expect(preview.conflictGroups.filter((group) => group.category === "deleted")).toEqual([]);
    expect(applied.additions).toEqual(preview.additions);
    expect(sessionIds(a)).toEqual([sessionId, otherId].sort());
  });
});
