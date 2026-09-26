import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDatabase,
  backupDatabaseBeforeMaintenance,
  backupDatabaseBeforeMigration,
  backupDatabaseBeforeProjectDeletion,
  isBackupDue,
  listDatabaseBackups,
  restoreDatabase,
} from "../../packages/storage/src/backup.js";
import { LATEST_SCHEMA_VERSION } from "../../packages/storage/src/schema-migrations.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

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

function setup(backup?: { keep?: number; automaticKeep?: number }) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-"));
  tempDirs.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath, { backup });
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
    expect(result.created).toMatchObject({ kind: "manual" });
    expect(result.created.fileName).toMatch(/^work-intelligence-manual-\d{8}T\d{6}Z\.sqlite$/);
    const path = join(directory, result.created.fileName);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const copy = new DatabaseSync(path, { readOnly: true });
    expect(copy.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Apiary" }]);
    copy.close();
  });

  it("keeps only the newest copies", () => {
    const { store } = setup({ automaticKeep: 2 });
    for (const day of ["01", "02", "03"]) {
      expect(store.backupIfDue(new Date(`2030-01-${day}T00:00:00Z`))).not.toBeNull();
    }
    const list = store.listBackups();
    expect(list).toMatchObject({ outcome: "database_backups", automaticKeep: 2 });
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
    expect(second.created.fileName).toBe("work-intelligence-manual-20300101T000000Z-2.sqlite");
    expect(second.backups.map((backup) => backup.fileName)).toEqual([second.created.fileName]);
    expect(() => statSync(join(directory, first.created.fileName))).toThrow();
  });

  it("creates one automatic backup per local calendar day and ignores unrelated files", () => {
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
    expect(list.outcome === "database_backups" ? list.backups.map((backup) => backup.kind) : []).toEqual([
      "automatic",
      "automatic",
    ]);
  });

  it("uses the server time zone when UTC and local dates differ", () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "Asia/Taipei";
    try {
      const { store } = setup();
      expect(store.backupIfDue(new Date("2030-01-01T16:30:00Z"))).not.toBeNull();
      // The first backup was made at 00:30 in Taipei; 08:30 is still the same local day.
      expect(store.backupIfDue(new Date("2030-01-02T00:30:00Z"))).toBeNull();
      expect(store.backupIfDue(new Date("2030-01-02T15:59:00Z"))).toBeNull();
      // Taipei reaches the next calendar day at 16:00 UTC.
      expect(store.backupIfDue(new Date("2030-01-02T16:00:00Z"))).not.toBeNull();
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimeZone;
      }
    }
  });

  it("keeps manual and automatic backups separately and manual copies do not delay the daily backup", () => {
    const { databasePath, directory } = setup({ keep: 1, automaticKeep: 2 });
    const db = new DatabaseSync(databasePath);
    const dayOne = new Date("2030-01-01T00:00:00Z");
    const dayTwo = new Date("2030-01-02T00:00:00Z");
    const dayThree = new Date("2030-01-03T00:00:00Z");

    backupDatabase(db, databasePath, { now: dayOne, kind: "manual", keep: 1, automaticKeep: 2 });
    expect(isBackupDue(databasePath, directory, dayOne)).toBe(true);
    backupDatabase(db, databasePath, { now: dayOne, kind: "automatic", keep: 1, automaticKeep: 2 });
    expect(isBackupDue(databasePath, directory, new Date("2030-01-01T23:59:00Z"))).toBe(false);
    backupDatabase(db, databasePath, { now: dayTwo, kind: "manual", keep: 1, automaticKeep: 2 });
    expect(isBackupDue(databasePath, directory, dayTwo)).toBe(true);
    backupDatabase(db, databasePath, { now: dayTwo, kind: "automatic", keep: 1, automaticKeep: 2 });
    backupDatabase(db, databasePath, { now: dayThree, kind: "manual", keep: 1, automaticKeep: 2 });
    db.close();

    const backups = listDatabaseBackups(databasePath, directory);
    expect(backups.filter((backup) => backup.kind === "manual")).toHaveLength(1);
    expect(backups.filter((backup) => backup.kind === "automatic")).toHaveLength(2);
    expect(backups.filter((backup) => backup.kind === "automatic").map((backup) => backup.createdAt)).toEqual([
      "2030-01-02T00:00:00Z",
      "2030-01-01T00:00:00Z",
    ]);
    expect(isBackupDue(databasePath, directory, new Date("2030-01-03T00:00:00Z"))).toBe(true);
  });

  it("reads legacy untagged backup names as manual copies", () => {
    const { databasePath, directory } = setup();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "work-intelligence-20300101T000000Z.sqlite"), "legacy backup");

    expect(listDatabaseBackups(databasePath, directory)).toMatchObject([
      { kind: "manual", fileName: "work-intelligence-20300101T000000Z.sqlite" },
    ]);
  });

  it("classifies migration, deletion, and maintenance snapshots by purpose", () => {
    const { databasePath } = setup({ keep: 10 });
    const db = new DatabaseSync(databasePath);
    backupDatabaseBeforeMigration(db, databasePath, LATEST_SCHEMA_VERSION, { keep: 10 });
    backupDatabaseBeforeProjectDeletion(db, databasePath, { keep: 10 });
    backupDatabaseBeforeMaintenance(db, databasePath, { keep: 10 });
    db.close();

    expect(
      listDatabaseBackups(databasePath)
        .map((backup) => backup.kind)
        .sort(),
    ).toEqual(["deletion", "maintenance", "migration"]);
  });

  it("keeps safety snapshots in the non-automatic retention group", () => {
    const { databasePath, directory } = setup({ keep: 1 });
    const db = new DatabaseSync(databasePath);
    const safety = backupDatabaseBeforeProjectDeletion(db, databasePath, { keep: 1 });
    const manual = backupDatabase(db, databasePath, {
      now: new Date(Date.now() + 2_000),
      kind: "manual",
      keep: 1,
    });
    db.close();

    expect(listDatabaseBackups(databasePath, directory).map((backup) => backup.fileName)).toEqual([
      manual.created.fileName,
    ]);
    expect(existsSync(join(directory, safety.created.fileName))).toBe(false);
  });

  it("deletes only one recognized backup and rejects traversal names", () => {
    const { root, directory, store } = setup();
    const first = store.createBackup();
    const second = store.createBackup();
    if (first.outcome !== "database_backups" || second.outcome !== "database_backups") {
      throw new Error("Expected disk backups");
    }

    const deleted = store.deleteBackup(first.created.fileName);
    expect(deleted).toMatchObject({ outcome: "backup_deleted", deleted: first.created });
    expect(existsSync(join(directory, first.created.fileName))).toBe(false);
    expect(existsSync(join(directory, second.created.fileName))).toBe(true);
    expect(store.deleteBackup(first.created.fileName)).toEqual({ outcome: "backup_not_found" });

    for (const fileName of [
      `../${second.created.fileName}`,
      `/tmp/${second.created.fileName}`,
      `%2e%2e%2f${second.created.fileName}`,
      second.created.fileName.replace(".sqlite", "..sqlite"),
    ]) {
      expect(store.deleteBackup(fileName)).toEqual({ outcome: "invalid_backup_file_name" });
    }
    expect(existsSync(join(root, "work-intelligence.sqlite"))).toBe(true);
  });

  it("does not list or delete a symlink that points outside the backup directory", () => {
    const { root, databasePath, directory, store } = setup();
    const backup = store.createBackup();
    if (backup.outcome !== "database_backups") {
      throw new Error("Expected a disk backup");
    }
    const outsidePath = join(root, "outside.sqlite");
    const symlinkName = "work-intelligence-manual-20300101T000000Z.sqlite";
    const linkedDirectory = join(root, "linked-backups");
    writeFileSync(outsidePath, "keep this file");
    symlinkSync(outsidePath, join(directory, symlinkName));
    symlinkSync(directory, linkedDirectory, "dir");

    expect(listDatabaseBackups(databasePath, directory).map((entry) => entry.fileName)).not.toContain(symlinkName);
    expect(listDatabaseBackups(databasePath, linkedDirectory)).toEqual([]);
    expect(store.deleteBackup(symlinkName)).toEqual({ outcome: "backup_not_found" });
    expect(readFileSync(outsidePath, "utf8")).toBe("keep this file");
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

    // Project roots are stored as real paths (e.g. long names instead of Windows 8.3 short names).
    const storedParent = dirname(store.listProjects()[0]?.rootPath ?? root);
    const result = restoreDatabase({
      source: exported,
      databasePath: target,
      remap: [{ from: `${storedParent}/`, to: "/Volumes/New/work" }],
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
      remap: [
        {
          from: store.listProjects().find((project) => project.name === "Apiary")?.rootPath ?? "",
          to: "/Volumes/New/apiary",
        },
      ],
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

  it("matches Windows paths case-insensitively and switches separators for the new machine", () => {
    const { root, store } = setup();
    const exported = exportFrom(store, root);
    const db = new DatabaseSync(exported);
    db.prepare("UPDATE projects SET root_path = ?").run("C:\\Users\\Me\\Code\\apiary");
    db.close();
    const target = join(mkdtempSync(join(tmpdir(), "work-intelligence-restore-")), "work-intelligence.sqlite");
    tempDirs.push(join(target, ".."));
    const result = restoreDatabase({
      source: exported,
      databasePath: target,
      remap: [{ from: "c:\\users\\me\\code", to: "/Users/me/code" }],
    });
    expect(result.remapped.projects).toBe(1);
    const restored = new WorkIntelligenceStore(target);
    stores.push(restored);
    expect(restored.listProjects()[0]?.rootPath).toBe("/Users/me/code/apiary");
  });
});
