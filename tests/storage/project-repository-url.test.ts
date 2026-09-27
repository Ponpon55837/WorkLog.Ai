import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeRepositoryUrl } from "../../packages/core/src/index.js";
import { updateProjectInputSchema } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-repository-url-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, project };
}

describe("project repository URL", () => {
  it("accepts only https URLs without credentials", () => {
    expect(isSafeRepositoryUrl("https://github.com/owner/repo")).toBe(true);
    expect(isSafeRepositoryUrl("http://github.com/owner/repo")).toBe(false);
    expect(isSafeRepositoryUrl("https://token@github.com/owner/repo")).toBe(false);
    expect(isSafeRepositoryUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRepositoryUrl("not a url")).toBe(false);
    expect(updateProjectInputSchema.safeParse({ repositoryUrl: "https://github.com/owner/repo" }).success).toBe(true);
    expect(updateProjectInputSchema.safeParse({ repositoryUrl: "" }).success).toBe(true);
    expect(updateProjectInputSchema.safeParse({ repositoryUrl: null }).success).toBe(true);
    expect(updateProjectInputSchema.safeParse({ repositoryUrl: "ftp://host/repo" }).success).toBe(false);
  });

  it("is saved, kept across other updates, and cleared with null or an empty string", () => {
    const { store, project } = setup();
    expect(store.updateProject(project.id, { repositoryUrl: "https://github.com/owner/apiary" })).toMatchObject({
      repositoryUrl: "https://github.com/owner/apiary",
    });
    expect(store.updateProject(project.id, { name: "Apiary 2" })).toMatchObject({
      repositoryUrl: "https://github.com/owner/apiary",
    });
    expect(store.updateProject(project.id, { repositoryUrl: "" })?.repositoryUrl).toBeUndefined();
    store.updateProject(project.id, { repositoryUrl: "https://github.com/owner/apiary" });
    expect(store.updateProject(project.id, { repositoryUrl: null })?.repositoryUrl).toBeUndefined();
    expect(store.getProjectById(project.id)?.repositoryUrl).toBeUndefined();
  });

  it("travels with portable exports, and an unsafe imported URL is dropped", () => {
    const { store, project } = setup();
    store.updateProject(project.id, { repositoryUrl: "https://github.com/owner/apiary" });
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(bundle.tables.projects[0]?.repository_url).toBe("https://github.com/owner/apiary");

    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    destination.importProjectData({ bundle, remap: [] });
    expect(destination.getProjectById(project.id)?.repositoryUrl).toBe("https://github.com/owner/apiary");

    const tampered = structuredClone(bundle);
    tampered.tables.projects[0]!.repository_url = "https://user:pass@github.com/owner/apiary";
    const other = new WorkIntelligenceStore(":memory:");
    stores.push(other);
    other.importProjectData({ bundle: tampered, remap: [] });
    expect(other.getProjectById(project.id)?.repositoryUrl).toBeUndefined();
  });
});
