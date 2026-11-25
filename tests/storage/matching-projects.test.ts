import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const BASE = join("/", "fictional", "matching-projects");

function register(
  store: WorkIntelligenceStore,
  name: string,
  folder: string,
  status: "tracked" | "paused" | "ignored",
) {
  const project = store.addProject(name, join(BASE, folder));
  store.updateProject(project.id, { status });
  return project;
}

describe("matchingProjects", () => {
  it("lists tracked and paused projects by name, root and status only, never ignored or unregistered rows", () => {
    const store = new WorkIntelligenceStore(":memory:");
    try {
      const tracked = register(store, "Atlas", join("old", "atlas"), "tracked");
      const paused = register(store, "Atlas docs", join("old", "Atlas"), "paused");
      register(store, "Atlas", join("old", "atlas-ignored"), "ignored");
      store.addProject("Atlas", join(BASE, "old", "atlas-pending"));

      expect(store.matchingProjects(join(BASE, "new", "atlas"))).toEqual([
        { name: "Atlas", rootPath: tracked.rootPath, status: "tracked" },
        { name: "Atlas docs", rootPath: paused.rootPath, status: "paused" },
      ]);
      expect(store.matchingProjects(join(BASE, "new", "unrelated"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("finds the project of a subfolder and never registers the asked root", () => {
    const store = new WorkIntelligenceStore(":memory:");
    try {
      const tracked = register(store, "Mono", "mono", "tracked");
      const subfolder = join(tracked.rootPath, "apps", "web");

      expect(store.matchingProjects(subfolder)).toEqual([
        { name: "Mono", rootPath: tracked.rootPath, status: "tracked" },
      ]);
      expect(store.getProjectByRootPath(subfolder)).toBeUndefined();
      expect(store.countProjects()).toBe(1);
    } finally {
      store.close();
    }
  });
});
