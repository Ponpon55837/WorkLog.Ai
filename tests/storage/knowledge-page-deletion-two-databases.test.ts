import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataImportStrategy } from "../../packages/core/src/index.js";
import { readProjectDataImportFile } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

const PAGE = { slug: "hive-inspections", title: "Hive inspections", question: "How are hives inspected?" };

interface Machine {
  store: WorkIntelligenceStore;
  directory: string;
  projectRoot: string;
}

function machine(name: string): Machine {
  const directory = mkdtempSync(join(tmpdir(), `work-intelligence-two-db-${name}-`));
  tempDirs.push(directory);
  const projectRoot = join(directory, "apiary");
  mkdirSync(projectRoot);
  const store = new WorkIntelligenceStore(join(directory, "work-intelligence.sqlite"));
  stores.push(store);
  return { store, directory, projectRoot };
}

function writePage(on: Machine, content: string, key: string): string {
  const requested = on.store.requestKnowledgePageUpdate({ projectRoot: on.projectRoot, ...PAGE });
  if (requested.outcome !== "knowledge_page_update_requested") throw new Error("Expected request");
  const read = on.store.getKnowledgePageContext({ projectRoot: on.projectRoot, slug: PAGE.slug });
  if (read.outcome !== "knowledge_page_context") throw new Error("Expected context");
  on.store.saveKnowledgePage({
    projectRoot: on.projectRoot,
    slug: PAGE.slug,
    idempotencyKey: key,
    reviewToken: read.reviewToken,
    sections: [{ heading: "Frames", content, sourceSessionIds: [] }],
  });
  return requested.page.id;
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

function pages(on: Machine): { id: string; slug: string }[] {
  const listed = on.store.listKnowledgePages({ projectRoot: on.projectRoot });
  if (listed.outcome !== "knowledge_pages") throw new Error("Expected pages");
  return listed.items.map((page) => ({ id: page.id, slug: page.slug }));
}

function twoMachines() {
  const a = machine("a");
  const project = a.store.addProject("Apiary", a.projectRoot);
  a.store.updateProject(project.id, { status: "tracked" });
  const pageId = writePage(a, "Check brood frames first.", "save-1");
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
  return { a, b: { ...b, projectRoot: bRoot }, projectId: project.id, pageId };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("importing between two independent databases after a page was deleted on one", () => {
  it.each(["merge", "newer-wins"] as const)(
    "keeps the page deleted when the other database still has it unchanged (%s)",
    (strategy) => {
      const { a, b, projectId, pageId } = twoMachines();
      expect(pages(b).map((page) => page.id)).toEqual([pageId]);
      a.store.deleteKnowledgePage(pageId);

      const { preview, applied } = previewAndApply(a, exportFile(b, projectId, strategy, "from-b"));

      expect(preview.additions.knowledge_pages ?? 0).toBe(0);
      expect(preview.conflicts).toMatchObject({ knowledge_pages: 1, knowledge_page_versions: 1 });
      expect(preview.conflictGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "knowledge_pages", category: "deleted", count: 1, sampleIds: [pageId] }),
        ]),
      );
      expect(applied.additions).toEqual(preview.additions);
      expect(applied.conflicts).toEqual(preview.conflicts);
      expect(applied.conflictGroups).toEqual(preview.conflictGroups);
      expect(pages(a)).toEqual([]);
    },
  );

  it("keeps the page deleted when the other database edited it after the deletion", () => {
    const { a, b, projectId, pageId } = twoMachines();
    a.store.deleteKnowledgePage(pageId);
    writePage(b, "Check brood frames, then honey.", "save-2");

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "newer-wins", "from-b"));

    expect(preview.additions.knowledge_pages ?? 0).toBe(0);
    expect(preview.additions.knowledge_page_versions ?? 0).toBe(0);
    expect(preview.conflictGroups).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "knowledge_pages", category: "deleted" })]),
    );
    expect(applied.additions).toEqual(preview.additions);
    expect(applied.conflicts).toEqual(preview.conflicts);
    expect(pages(a)).toEqual([]);
  });

  it("adds a page the other database recreated under the same slug with a new id", () => {
    const { a, b, projectId, pageId } = twoMachines();
    a.store.deleteKnowledgePage(pageId);
    b.store.deleteKnowledgePage(pageId);
    const recreatedId = writePage(b, "Fresh inspection notes.", "save-fresh");
    expect(recreatedId).not.toBe(pageId);

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "merge", "from-b"));

    expect(preview.additions).toMatchObject({ knowledge_pages: 1, knowledge_page_versions: 1 });
    expect(preview.conflictGroups.filter((group) => group.category === "deleted")).toEqual([]);
    expect(applied.additions).toEqual(preview.additions);
    expect(applied.conflicts).toEqual(preview.conflicts);
    expect(pages(a)).toEqual([{ id: recreatedId, slug: PAGE.slug }]);
  });

  it("adds a page the other database created separately under the same slug", () => {
    const { a, b, projectId, pageId } = twoMachines();
    a.store.deleteKnowledgePage(pageId);
    b.store.deleteKnowledgePage(pageId);
    const separateId = writePage(b, "Separate notes.", "save-sep");

    const { preview, applied } = previewAndApply(a, exportFile(b, projectId, "newer-wins", "from-b"));

    expect(applied.additions).toEqual(preview.additions);
    expect(applied.conflicts).toEqual(preview.conflicts);
    expect(pages(a).map((page) => page.id)).toEqual([separateId]);
  });
});
