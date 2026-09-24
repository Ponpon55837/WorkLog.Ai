import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, restoreDatabase } from "./backup.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
import { WorkIntelligenceStore } from "./store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(keep?: number) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-"));
  tempDirs.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath, { backup: keep ? { keep } : undefined });
  stores.push(store);
  store.addProject("Apiary", join(root, "apiary"));
  return { root, databasePath, store, directory: join(root, "backups") };
}

describe("database backups", () => {
  it("writes a checked, owner-only snapshot that holds the data", () => {
    const { store, directory } = setup();
    const result = store.createBackup();
    if (result.outcome !== "database_backups") {
      throw new Error("Expected a backup");
    }
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(result.created.fileName).toMatch(/^work-intelligence-\d{8}T\d{6}Z\.sqlite$/);
    const path = join(directory, result.created.fileName);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const copy = new DatabaseSync(path, { readOnly: true });
    expect(copy.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Apiary" }]);
    copy.close();
  });

  it("keeps only the newest copies", () => {
    const { store } = setup(2);
    for (const day of ["01", "02", "03"]) {
      expect(store.backupIfDue(new Date(`2030-01-${day}T00:00:00Z`))).not.toBeNull();
    }
    const list = store.listBackups();
    expect(list).toMatchObject({ outcome: "database_backups", keep: 2 });
    expect(list.outcome === "database_backups" ? list.backups.map((backup) => backup.createdAt) : []).toEqual([
      "2030-01-03T00:00:00Z",
      "2030-01-02T00:00:00Z",
    ]);
  });

  it("orders two backups taken in the same second newest first and prunes the older one", () => {
    const { databasePath, directory } = setup();
    const db = new DatabaseSync(databasePath);
    const now = new Date("2030-01-01T00:00:00Z");
    const first = backupDatabase(db, databasePath, { now, keep: 1 });
    const second = backupDatabase(db, databasePath, { now, keep: 1 });
    db.close();
    expect(second.created.fileName).toBe("work-intelligence-20300101T000000Z-2.sqlite");
    expect(second.backups.map((backup) => backup.fileName)).toEqual([second.created.fileName]);
    expect(() => statSync(join(directory, first.created.fileName))).toThrow();
  });

  it("backs up only when no backup is a day old, and ignores unrelated files", () => {
    const { store, directory } = setup();
    expect(store.backupIfDue(new Date("2030-01-01T00:00:00Z"))).not.toBeNull();
    expect(store.backupIfDue(new Date("2030-01-01T23:59:00Z"))).toBeNull();
    expect(store.backupIfDue(new Date("2030-01-02T00:00:00Z"))).not.toBeNull();
    writeFileSync(join(directory, "notes.txt"), "not a backup");
    writeFileSync(join(directory, "work-intelligence-latest.sqlite"), "not a backup either");
    const list = store.listBackups();
    expect(list).toMatchObject({ outcome: "database_backups" });
    expect(list.outcome === "database_backups" ? list.backups.map((backup) => backup.createdAt) : []).toEqual([
      "2030-01-02T00:00:00Z",
      "2030-01-01T00:00:00Z",
    ]);
  });

  it("reports that an in-memory database cannot be backed up", () => {
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    expect(store.createBackup()).toMatchObject({ outcome: "backup_unavailable" });
    expect(store.listBackups()).toMatchObject({ outcome: "backup_unavailable" });
    expect(store.backupIfDue()).toBeNull();
  });
});

describe("moving the database to another computer", () => {
  function exportFrom(store: WorkIntelligenceStore, root: string): string {
    const target = join(root, "export.sqlite");
    expect(store.exportTo(target).bytes).toBeGreaterThan(0);
    expect(() => store.exportTo(target)).toThrow(/already exists/);
    return target;
  }

  it("restores an export with project roots moved to the new machine and backs up what it replaces", () => {
    const { root, store } = setup();
    store.addProject("Apiary Tools", join(root, "apiary-tools"));
    const exported = exportFrom(store, root);

    const newRoot = mkdtempSync(join(tmpdir(), "work-intelligence-restore-"));
    tempDirs.push(newRoot);
    const target = join(newRoot, "work-intelligence.sqlite");
    new WorkIntelligenceStore(target).close();

    const result = restoreDatabase({
      source: exported,
      databasePath: target,
      remap: [{ from: `${root}/`, to: "/Volumes/New/work" }],
    });
    expect(result).toMatchObject({ schemaVersion: LATEST_SCHEMA_VERSION, projects: 2, sessions: 0 });
    expect(result.remapped.projects).toBe(2);
    expect(result.safetyBackup).toMatch(/^work-intelligence-/);

    const restored = new WorkIntelligenceStore(target);
    stores.push(restored);
    expect(
      restored
        .listProjects()
        .map((project) => project.rootPath)
        .sort(),
    ).toEqual(["/Volumes/New/work/apiary", "/Volumes/New/work/apiary-tools"]);
  });

  it("includes writes still in the source's WAL file", () => {
    const { root, store, databasePath } = setup();
    // The open store keeps its latest write in the WAL, not yet in the main file.
    store.addProject("Late Project", join(root, "late"));
    const target = join(mkdtempSync(join(tmpdir(), "work-intelligence-restore-")), "work-intelligence.sqlite");
    tempDirs.push(join(target, ".."));
    expect(restoreDatabase({ source: databasePath, databasePath: target })).toMatchObject({ projects: 2 });
    const restored = new WorkIntelligenceStore(target);
    stores.push(restored);
    expect(restored.listProjects().map((project) => project.name)).toContain("Late Project");
  });

  it("only moves whole path segments", () => {
    const { root, store } = setup();
    store.addProject("Apiary Tools", join(root, "apiary-tools"));
    const exported = exportFrom(store, root);
    const target = join(mkdtempSync(join(tmpdir(), "work-intelligence-restore-")), "work-intelligence.sqlite");
    tempDirs.push(join(target, ".."));
    const result = restoreDatabase({
      source: exported,
      databasePath: target,
      remap: [{ from: join(root, "apiary"), to: "/Volumes/New/apiary" }],
    });
    expect(result.remapped.projects).toBe(1);
    expect(result.safetyBackup).toBeUndefined();
  });

  it("refuses a database in use, a newer schema, and files that are not Work Intelligence databases", () => {
    const { root, store, databasePath } = setup();
    const exported = exportFrom(store, root);
    // The open store holds the database, so it cannot be replaced underneath it.
    expect(() => restoreDatabase({ source: exported, databasePath })).toThrow(/in use/);

    const newer = join(root, "newer.sqlite");
    store.exportTo(newer);
    const db = new DatabaseSync(newer);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', '2030-01-01')").run(
      LATEST_SCHEMA_VERSION + 1,
    );
    db.close();
    const elsewhere = join(root, "elsewhere.sqlite");
    expect(() => restoreDatabase({ source: newer, databasePath: elsewhere })).toThrow(/newer than this version/);

    const other = join(root, "other.sqlite");
    const foreign = new DatabaseSync(other);
    foreign.exec("CREATE TABLE notes (body TEXT)");
    foreign.close();
    expect(() => restoreDatabase({ source: other, databasePath: elsewhere })).toThrow(/not a Work Intelligence/);
    expect(() => restoreDatabase({ source: join(root, "missing.sqlite"), databasePath: elsewhere })).toThrow(
      /does not exist/,
    );
  });
});
