import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectLocationError } from "../../packages/storage/src/project-location-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupProject(): {
  directory: string;
  databasePath: string;
  oldRoot: string;
  newRoot: string;
  store: WorkIntelligenceStore;
  projectId: string;
  handoffPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-project-location-"));
  directories.push(directory);
  const oldRoot = join(directory, "old-project");
  const newRoot = join(directory, "new-project");
  mkdirSync(oldRoot);
  mkdirSync(newRoot);
  const databasePath = join(directory, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Location fixture", oldRoot);
  store.updateProject(project.id, { status: "tracked" });
  const handoffPath = join(oldRoot, "handoff.md");
  const result = store.finalizeSession({
    projectRoot: oldRoot,
    idempotencyKey: "location-fixture-session",
    title: "位置變更測試記錄",
    summary: "驗證專案位置與 handoff 路徑可以一起更新。",
    handoffPath,
    handoffContent: "Synthetic handoff content.",
    completedAt: "2026-09-27T01:00:00.000Z",
  });
  if (result.outcome !== "finalized") throw new Error("The tracked fixture should accept a Session.");
  return { directory, databasePath, oldRoot, newRoot, store, projectId: project.id, handoffPath };
}

describe("project location updates", () => {
  it("requires tracked-scope consent and atomically remaps handoff paths with a content-free audit", () => {
    const fixture = setupProject();
    expect(() => fixture.store.updateProjectLocation(fixture.projectId, fixture.newRoot)).toThrow(ProjectLocationError);
    try {
      fixture.store.updateProjectLocation(fixture.projectId, fixture.newRoot);
    } catch (error) {
      expect(error).toMatchObject({ code: "project_location_confirmation_required" });
    }
    expect(fixture.store.getProjectById(fixture.projectId)?.rootPath).toBe(fixture.oldRoot);

    const updated = fixture.store.updateProjectLocation(fixture.projectId, fixture.newRoot, true);
    expect(updated.rootPath).toBe(fixture.newRoot);

    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(db.prepare("SELECT source_path FROM raw_snapshots WHERE project_id = ?").get(fixture.projectId)).toEqual({
        source_path: join(fixture.newRoot, "handoff.md"),
      });
      const audit = db
        .prepare("SELECT changed_at, project_id, paths_changed FROM project_location_audit WHERE project_id = ?")
        .get(fixture.projectId);
      expect(audit).toMatchObject({ project_id: fixture.projectId, paths_changed: 1 });
      expect(audit).not.toHaveProperty("old_path");
      expect(audit).not.toHaveProperty("new_path");
      expect(JSON.stringify(audit)).not.toContain(fixture.oldRoot);
      expect(JSON.stringify(audit)).not.toContain(fixture.newRoot);
    } finally {
      db.close();
    }
  });

  it("rejects another project's equal or nested root without changing the saved location", () => {
    const fixture = setupProject();
    const nestedRoot = join(fixture.directory, "future-project", "nested");
    const other = fixture.store.addProject("Other fixture", nestedRoot);

    expect(() =>
      fixture.store.updateProjectLocation(fixture.projectId, join(fixture.directory, "future-project"), true),
    ).toThrow(ProjectLocationError);
    expect(() => fixture.store.updateProjectLocation(fixture.projectId, other.rootPath, true)).toThrow(
      expect.objectContaining({ code: "project_location_conflict" }),
    );
    expect(fixture.store.getProjectById(fixture.projectId)?.rootPath).toBe(fixture.oldRoot);
  });

  it("allows an untracked project to move without a tracking-scope confirmation", () => {
    const fixture = setupProject();
    const paused = fixture.store.addProject("Paused fixture", join(fixture.directory, "paused"));
    const moved = fixture.store.updateProjectLocation(paused.id, fixture.newRoot);
    expect(moved.rootPath).toBe(fixture.newRoot);
  });
});
