import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRestoreFailure, inspectBackups, restoreFromBackup } from "../../apps/server/src/backup-restore.js";

/** What the preview child answers for 「從備份還原」, on synthetic files: the classification and the never-throws contract. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-server-restore-"));
  roots.push(directory);
  return directory;
}

function snapshotOf(directory: string, name: string): string {
  const store = new WorkIntelligenceStore(join(directory, `${name}-source.sqlite`));
  store.addProject("Apiary", join(directory, "apiary"));
  const snapshot = join(directory, `${name}.sqlite`);
  store.exportTo(snapshot);
  store.close();
  return snapshot;
}

describe("classifyRestoreFailure", () => {
  it.each(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])("maps the file error %s to locked", (code) => {
    expect(classifyRestoreFailure(Object.assign(new Error("synthetic"), { code }))).toBe("locked");
  });

  it("maps a full disk to no-space, and anything else to failed", () => {
    expect(classifyRestoreFailure(Object.assign(new Error("synthetic"), { code: "ENOSPC" }))).toBe("no-space");
    expect(classifyRestoreFailure(new Error("database or disk is full"))).toBe("no-space");
    expect(classifyRestoreFailure(new Error("something else"))).toBe("failed");
    expect(classifyRestoreFailure("not an error")).toBe("failed");
  });
});

describe("inspectBackups and restoreFromBackup on synthetic files", () => {
  it("looks at exactly the files it is given, read-only, and refuses a foreign one", () => {
    const directory = root();
    const good = snapshotOf(directory, "good");
    const foreign = join(directory, "foreign.txt");
    writeFileSync(foreign, "just synthetic text, not a database ".repeat(30));
    const { items } = inspectBackups({
      databasePath: join(directory, "db.sqlite"),
      files: [good, foreign, join(directory, "gone")],
    });
    expect(items.map((item) => item.status)).toEqual(["ok", "not-database", "missing"]);
    expect(items[0]).toMatchObject({ projects: 1, sessions: 0 });
  });

  it("restores a good snapshot over a missing database", () => {
    const directory = root();
    const good = snapshotOf(directory, "good");
    const databasePath = join(directory, "restored.sqlite");
    expect(restoreFromBackup({ source: good, databasePath })).toMatchObject({ status: "ok", projects: 1 });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 1 });
    database.close();
  });

  it("classifies a database in use, a source that is the database itself, and a newer schema from real failures", () => {
    const directory = root();
    const databasePath = join(directory, "current.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const good = snapshotOf(directory, "good");
    // The store still holds the database open: the same refusal an Agent holding it would cause.
    expect(restoreFromBackup({ source: good, databasePath }).status).toBe("in-use");
    expect(restoreFromBackup({ source: databasePath, databasePath }).status).toMatch(/same-file|in-use/);
    store.close();
    const newer = join(directory, "newer.sqlite");
    copyFileSync(good, newer);
    const database = new DatabaseSync(newer);
    database.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', '2030-01-01')");
    database.close();
    expect(restoreFromBackup({ source: newer, databasePath }).status).toBe("newer-schema");
  });

  it("never throws, and a refused file leaves the existing database as it was", () => {
    const directory = root();
    const databasePath = join(directory, "current.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    store.addProject("Current", join(directory, "current"));
    store.close();
    const foreign = join(directory, "foreign.txt");
    writeFileSync(foreign, "just synthetic text, not a database ".repeat(30));
    expect(restoreFromBackup({ source: foreign, databasePath }).status).toBe("not-database");
    expect(restoreFromBackup({ source: join(directory, "gone"), databasePath }).status).toBe("missing");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Current" }]);
    database.close();
  });
});
