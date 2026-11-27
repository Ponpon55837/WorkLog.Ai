import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport } from "../../packages/core/src/index.js";
import { projectDataExportSchema } from "../../packages/schema/src/index.js";
import { readProjectDataImportBytes } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function createStore(name: string, directory: string): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(join(directory, name));
  stores.push(store);
  return store;
}

function createSource(count: number) {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-conventions-transfer-"));
  tempDirs.push(directory);
  const store = createStore("source.sqlite", directory);
  const project = store.addProject("Yard", directory);
  store.updateProject(project.id, { status: "tracked" });
  const ids = Array.from({ length: count }, (_, index) => {
    const result = store.recordKnowledge({
      projectRoot: directory,
      idempotencyKey: `yard-${index}`,
      kind: "pattern",
      title: `Yard rule ${index}`,
      body: `Yard rule body ${index}.`,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge.id;
  });
  return { directory, store, project, ids };
}

function flagDirectly(store: WorkIntelligenceStore, ids: readonly string[]): void {
  const db = new DatabaseSync(store.databasePath);
  try {
    ids.forEach((id, index) =>
      db
        .prepare("UPDATE knowledge SET convention_confirmed_at = ? WHERE id = ?")
        .run(`2030-01-01T00:00:0${index}.000Z`, id),
    );
  } finally {
    db.close();
  }
}

function flagged(store: WorkIntelligenceStore): Array<{ id: string; withdrawal: string | null }> {
  const db = new DatabaseSync(store.databasePath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT id, convention_withdrawal_json AS withdrawal FROM knowledge WHERE convention_confirmed_at IS NOT NULL ORDER BY id",
        )
        .all() as Array<{ id: string; withdrawal: string | null }>
    ).map((row) => ({ id: row.id, withdrawal: row.withdrawal }));
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project conventions in export and import", () => {
  it("round-trips the flag into a fresh database", () => {
    const { directory, store, project, ids } = createSource(3);
    store.setKnowledgeConvention({ projectRoot: directory, knowledgeId: ids[0]!, confirmed: true });
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.tables.knowledge.find((row) => row.id === ids[0])?.convention_confirmed_at).toEqual(
      expect.any(String),
    );

    const destination = createStore("destination.sqlite", directory);
    const preview = destination.previewProjectDataImport({ bundle, remap: [] });
    expect(preview.conventionsWithdrawn).toBeUndefined();
    destination.importProjectData({ bundle, remap: [] });
    expect(flagged(destination).map((row) => row.id)).toEqual([ids[0]]);
  });

  it("imports an export made before the columns existed", () => {
    const { directory, store, project, ids } = createSource(1);
    const bundle = structuredClone(store.exportProjectData({ type: "project", projectId: project.id }));
    for (const row of bundle.tables.knowledge) {
      delete row.convention_confirmed_at;
      delete row.convention_withdrawal_json;
    }
    expect(projectDataExportSchema.safeParse(bundle).success).toBe(true);
    const destination = createStore("legacy.sqlite", directory);
    destination.importProjectData({ bundle, remap: [] });
    expect(flagged(destination)).toEqual([]);
    const db = new DatabaseSync(destination.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM knowledge").all()).toEqual([{ id: ids[0] }]);
    } finally {
      db.close();
    }
  });

  it("withdraws copies beyond the limit of 5 and counts them in the preview", () => {
    const { directory, store, project, ids } = createSource(7);
    flagDirectly(store, ids);
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });

    const destination = createStore("capped.sqlite", directory);
    const preview = destination.previewProjectDataImport({ bundle, remap: [] });
    expect(preview.conventionsWithdrawn).toBe(2);
    destination.importProjectData({ bundle, remap: [] });

    const rows = flagged(destination);
    expect(rows).toHaveLength(5);
    const db = new DatabaseSync(destination.databasePath, { readOnly: true });
    try {
      const withdrawn = db
        .prepare("SELECT convention_withdrawal_json AS withdrawal FROM knowledge WHERE convention_confirmed_at IS NULL")
        .all() as Array<{ withdrawal: string }>;
      expect(withdrawn).toHaveLength(2);
      for (const row of withdrawn) {
        expect(JSON.parse(row.withdrawal)).toMatchObject({ by: "system", reason: "import_cap" });
      }
    } finally {
      db.close();
    }
  });

  it("keeps this machine's choice for rows that already exist, with no conflict", () => {
    const { directory, store, project, ids } = createSource(2);
    const first = store.exportProjectData({ type: "project", projectId: project.id });
    const other = createStore("other.sqlite", directory);
    other.importProjectData({ bundle: first, remap: [] });
    other.updateProject(project.id, { status: "tracked" });

    store.setKnowledgeConvention({ projectRoot: directory, knowledgeId: ids[0]!, confirmed: true });
    other.setKnowledgeConvention({ projectRoot: directory, knowledgeId: ids[1]!, confirmed: true });

    const preview = other.previewProjectDataImport({
      bundle: store.exportProjectData({ type: "project", projectId: project.id }),
      remap: [],
    });
    expect(Object.values(preview.conflicts).reduce((sum, count) => sum + (count ?? 0), 0)).toBe(0);
    other.importProjectData({
      bundle: store.exportProjectData({ type: "project", projectId: project.id }),
      remap: [],
      strategy: "newer-wins",
    });
    expect(flagged(other).map((row) => row.id)).toEqual([ids[1]]);
  });
});

describe("project conventions when an import updates an existing row", () => {
  function importedPair() {
    const { directory, store, project, ids } = createSource(2);
    vi.useFakeTimers({ toFake: ["Date"] });
    const other = createStore("local.sqlite", directory);
    other.importProjectData({ bundle: store.exportProjectData({ type: "project", projectId: project.id }), remap: [] });
    other.updateProject(project.id, { status: "tracked" });
    other.setKnowledgeConvention({ projectRoot: directory, knowledgeId: ids[0]!, confirmed: true });
    vi.setSystemTime(Date.now() + 60_000);
    const newerImport = () =>
      other.importProjectData({
        bundle: store.exportProjectData({ type: "project", projectId: project.id }),
        remap: [],
        strategy: "newer-wins",
      });
    const preview = () =>
      other.previewProjectDataImport({
        bundle: store.exportProjectData({ type: "project", projectId: project.id }),
        remap: [],
        strategy: "newer-wins",
      });
    return { directory, store, other, ids, newerImport, preview };
  }

  function localRow(store: WorkIntelligenceStore, id: string) {
    const db = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT title, body, status, convention_confirmed_at AS flag, convention_withdrawal_json AS withdrawal FROM knowledge WHERE id = ?",
        )
        .get(id) as { title: string; body: string; status: string; flag: string | null; withdrawal: string | null };
    } finally {
      db.close();
    }
  }

  it("withdraws the flag when the newer imported row has another body", () => {
    const { directory, store, other, ids, newerImport, preview } = importedPair();
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, body: "Agent rewrote the yard rule." });
    expect(preview().conventionsWithdrawn).toBe(1);
    newerImport();
    const row = localRow(other, ids[0]!);
    expect(row.body).toBe("Agent rewrote the yard rule.");
    expect(row.flag).toBeNull();
    expect(JSON.parse(row.withdrawal!)).toMatchObject({ by: "system", reason: "import_changed" });
  });

  it("withdraws the flag when the newer imported row is archived", () => {
    const { directory, store, other, ids, newerImport } = importedPair();
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, status: "archived" }, "user");
    newerImport();
    const row = localRow(other, ids[0]!);
    expect(row.status).toBe("archived");
    expect(row.flag).toBeNull();
    expect(JSON.parse(row.withdrawal!)).toMatchObject({ reason: "archived" });
  });

  it("keeps the flag when the newer imported row only changes tags", () => {
    const { directory, store, other, ids, newerImport, preview } = importedPair();
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, tags: ["yard"] });
    expect(preview().conventionsWithdrawn).toBeUndefined();
    newerImport();
    expect(localRow(other, ids[0]!).flag).toEqual(expect.any(String));
  });

  it("does not let an archived or doubted imported copy take a slot or keep a flag", () => {
    const { directory, store, project, ids } = createSource(2);
    flagDirectly(store, ids);
    const db = new DatabaseSync(store.databasePath);
    try {
      db.prepare("UPDATE knowledge SET status = 'archived' WHERE id = ?").run(ids[0]!);
      db.prepare("UPDATE knowledge SET review_json = ? WHERE id = ?").run(
        JSON.stringify({ reason: "contradicted", at: "2030-01-01T00:00:00.000Z" }),
        ids[1]!,
      );
    } finally {
      db.close();
    }
    const destination = createStore("ineligible.sqlite", directory);
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(destination.previewProjectDataImport({ bundle, remap: [] }).conventionsWithdrawn).toBe(2);
    destination.importProjectData({ bundle, remap: [] });
    expect(flagged(destination)).toEqual([]);
  });

  it("clears an empty flag without counting it", () => {
    const { directory, store, project, ids } = createSource(1);
    const bundle = structuredClone(store.exportProjectData({ type: "project", projectId: project.id }));
    bundle.tables.knowledge[0]!.convention_confirmed_at = "";
    const destination = createStore("empty.sqlite", directory);
    expect(destination.previewProjectDataImport({ bundle, remap: [] }).conventionsWithdrawn).toBeUndefined();
    destination.importProjectData({ bundle, remap: [] });
    expect(localRow(destination, ids[0]!).flag).toBeNull();
  });
});

describe("project conventions when the import is a streamed file", () => {
  const reads = [
    [
      "a parsed bundle",
      (bundle: ProjectDataExport, _root: string) => ({ bundle, remap: [], strategy: "newer-wins" as const }),
    ],
    [
      "a streamed file",
      (bundle: ProjectDataExport, root: string) =>
        readProjectDataImportBytes(Buffer.from(JSON.stringify({ bundle, remap: [], strategy: "newer-wins" })), {
          envelope: "request",
          spillPath: join(root, `import-${Math.random().toString(36).slice(2)}.spill`),
        }),
    ],
  ] as const;

  function pair() {
    const { directory, store, project, ids } = createSource(2);
    vi.useFakeTimers({ toFake: ["Date"] });
    const other = createStore("streamed-local.sqlite", directory);
    other.importProjectData({ bundle: store.exportProjectData({ type: "project", projectId: project.id }), remap: [] });
    other.updateProject(project.id, { status: "tracked" });
    other.setKnowledgeConvention({ projectRoot: directory, knowledgeId: ids[0]!, confirmed: true });
    vi.setSystemTime(Date.now() + 60_000);
    const bundle = () => store.exportProjectData({ type: "project", projectId: project.id });
    return { directory, store, other, ids, bundle };
  }

  function row(store: WorkIntelligenceStore, id: string) {
    const db = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT convention_confirmed_at AS flag, convention_withdrawal_json AS withdrawal FROM knowledge WHERE id = ?",
        )
        .get(id) as { flag: string | null; withdrawal: string | null };
    } finally {
      db.close();
    }
  }

  it.each(reads)("keeps the flag when the newer row has the same title and body, from %s", (_, read) => {
    const { directory, store, other, ids, bundle } = pair();
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, tags: ["yard"] });
    const input = read(bundle(), directory);
    expect(other.previewProjectDataImport(input).conventionsWithdrawn).toBeUndefined();
    other.importProjectData(read(bundle(), directory));
    expect(row(other, ids[0]!).flag).toEqual(expect.any(String));
  });

  it.each(reads)("withdraws the flag when the newer row has another body, from %s", (_, read) => {
    const { directory, store, other, ids, bundle } = pair();
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, body: "Agent rewrote it." });
    expect(other.previewProjectDataImport(read(bundle(), directory)).conventionsWithdrawn).toBe(1);
    other.importProjectData(read(bundle(), directory));
    const result = row(other, ids[0]!);
    expect(result.flag).toBeNull();
    expect(JSON.parse(result.withdrawal!)).toMatchObject({ reason: "import_changed" });
  });

  it.each(reads)("withdraws the flag when the newer row needs review, from %s", (_, read) => {
    const { directory, store, other, ids, bundle } = pair();
    const db = new DatabaseSync(store.databasePath);
    try {
      db.prepare("UPDATE knowledge SET review_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ reason: "contradicted", at: "2030-01-01T00:00:00.000Z" }),
        new Date(Date.now() + 1000).toISOString(),
        ids[0]!,
      );
    } finally {
      db.close();
    }
    other.importProjectData(read(bundle(), directory));
    expect(JSON.parse(row(other, ids[0]!).withdrawal!)).toMatchObject({ reason: "needs_review" });
    expect(row(other, ids[0]!).flag).toBeNull();
  });

  it.each(reads)("does not keep or count a doubted row on the add path, from %s", (_, read) => {
    const { directory, store, project, ids } = createSource(6);
    flagDirectly(store, ids);
    const db = new DatabaseSync(store.databasePath);
    try {
      db.prepare("UPDATE knowledge SET review_json = ? WHERE id = ?").run(
        JSON.stringify({ reason: "contradicted", at: "2030-01-01T00:00:00.000Z" }),
        ids[0]!,
      );
    } finally {
      db.close();
    }
    const destination = createStore("streamed-add.sqlite", directory);
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    expect(destination.previewProjectDataImport(read(bundle, directory)).conventionsWithdrawn).toBe(1);
    destination.importProjectData(read(bundle, directory));
    expect(flagged(destination)).toHaveLength(5);
    expect(row(destination, ids[0]!).flag).toBeNull();
    expect(JSON.parse(row(destination, ids[0]!).withdrawal!)).toMatchObject({ reason: "needs_review" });
  });

  it("frees a slot for later adds when an update withdraws a convention", () => {
    const { directory, store, project, ids } = createSource(5);
    vi.useFakeTimers({ toFake: ["Date"] });
    flagDirectly(store, ids);
    const other = createStore("slots.sqlite", directory);
    other.importProjectData({ bundle: store.exportProjectData({ type: "project", projectId: project.id }), remap: [] });
    other.updateProject(project.id, { status: "tracked" });
    vi.setSystemTime(Date.now() + 60_000);
    store.updateKnowledge({ projectRoot: directory, knowledgeId: ids[0]!, body: "Changed body." });
    const added = store.recordKnowledge({
      projectRoot: directory,
      idempotencyKey: "extra",
      kind: "pattern",
      title: "Extra rule",
      body: "Extra body.",
    });
    if (added.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    flagDirectly(store, [added.knowledge.id]);
    other.importProjectData({
      bundle: store.exportProjectData({ type: "project", projectId: project.id }),
      remap: [],
      strategy: "newer-wins",
    });
    expect(row(other, ids[0]!).flag).toBeNull();
    expect(row(other, added.knowledge.id).flag).toEqual(expect.any(String));
  });
});
