import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listBackupProjectRoots, restoreFromBackup } from "../../apps/server/src/backup-restore.js";
import { maintainForApp, readMaintenanceHint } from "../../apps/server/src/database-maintenance-app.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

/** The preview child's work for the App's restore on a new computer and its database maintenance, on synthetic files. */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "wi-server-maintain-"));
  directories.push(made);
  return made;
}

function databaseWithProjects(base: string, name: string, projects: readonly string[]): string {
  const file = join(base, `${name}.sqlite`);
  const store = new WorkIntelligenceStore(file);
  for (const path of projects) store.addProject(basename(path), path);
  store.close();
  return file;
}

describe("listBackupProjectRoots", () => {
  it("lists the project folders a backup records, read-only", () => {
    const base = directory();
    // Native paths: the store resolves a project root against the platform it runs on (a drive letter on Windows).
    const roots = [join(base, "old", "alpha"), join(base, "old", "beta")];
    const file = databaseWithProjects(base, "snapshot", roots);
    const found = listBackupProjectRoots(file);
    expect(found.status).toBe("ok");
    // The store keeps Windows paths in one case, so compare the way Windows does.
    const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
    expect(found.roots.map((root) => fold(root.path)).sort()).toEqual(roots.map(fold).sort());
  });

  it("reports a file that is not a database as a failure with no roots", () => {
    expect(listBackupProjectRoots(join(directory(), "missing.sqlite"))).toEqual({ status: "failed", roots: [] });
  });
});

describe("restoreFromBackup with a remap", () => {
  it("moves the project folder prefix to the new place and says how many projects moved", () => {
    const base = directory();
    const oldRoot = join(base, "old", "alpha");
    const newRoot = join(base, "new", "alpha");
    const snapshot = databaseWithProjects(base, "snapshot", [oldRoot]);
    const target = join(base, "target.sqlite");
    const result = restoreFromBackup({
      source: snapshot,
      databasePath: target,
      remap: [{ from: oldRoot, to: newRoot }],
    });
    expect(result).toMatchObject({ status: "ok", projects: 1, remappedProjects: 1 });
    const database = new DatabaseSync(target, { readOnly: true });
    try {
      expect(database.prepare("SELECT root_path AS path FROM projects").all()).toEqual([{ path: newRoot }]);
    } finally {
      database.close();
    }
  });
});

describe("maintainForApp and readMaintenanceHint", () => {
  it("checks a healthy database without changing it", async () => {
    const file = databaseWithProjects(directory(), "healthy", ["/work/alpha"]);
    expect(await maintainForApp({ mode: "check", databasePath: file })).toEqual({ mode: "check", status: "ok" });
  });

  it("maintains: backs up first, compacts, and records the run the hint then shows", async () => {
    const base = directory();
    const file = databaseWithProjects(base, "work", ["/work/alpha"]);
    const backups = join(base, "backups");
    const result = await maintainForApp({ mode: "maintain", databasePath: file, backupDirectory: backups });
    expect(result).toMatchObject({ mode: "maintain", status: "ok" });
    expect(result.backupFileName).toMatch(/\.sqlite$/);
    const hint = await readMaintenanceHint(file);
    expect(hint.last).toMatchObject({ status: "completed" });
    expect(hint.reclaimableBytes).toBe(0);
  });

  it("answers missing for a database that does not exist, and an empty hint", async () => {
    const file = join(directory(), "none.sqlite");
    expect(await maintainForApp({ mode: "maintain", databasePath: file })).toEqual({
      mode: "maintain",
      status: "missing",
    });
    expect(await maintainForApp({ mode: "check", databasePath: file })).toEqual({ mode: "check", status: "missing" });
    expect(await readMaintenanceHint(file)).toEqual({});
  });

  it("reports the space free pages hold after rows are deleted", async () => {
    const base = directory();
    const file = databaseWithProjects(base, "work", ["/work/alpha"]);
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE filler (value TEXT)");
    const insert = database.prepare("INSERT INTO filler (value) VALUES (?)");
    for (let index = 0; index < 400; index += 1) insert.run("x".repeat(2000));
    database.exec("DELETE FROM filler");
    database.close();
    const hint = await readMaintenanceHint(file);
    expect(hint.reclaimableBytes).toBeGreaterThan(100_000);
  });
});
