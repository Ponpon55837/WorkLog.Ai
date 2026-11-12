import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport, ProjectDataImportResult } from "../../packages/core/src/index.js";
import { listDatabaseBackups } from "../../packages/storage/src/backup.js";
import {
  ProjectDataTransferError,
  ValidatedProjectDataImport,
} from "../../packages/storage/src/project-data-transfer.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional data only. An online import writes a checked pre-import snapshot and refuses to run without one, reports
// every row it cannot place instead of dropping it, and holds the write lock only while it writes.

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-import-safety-"));
  tempDirs.push(directory);
  return directory;
}

function track(store: WorkIntelligenceStore): WorkIntelligenceStore {
  stores.push(store);
  return store;
}

/** A tracked project with `sessions` finalized Sessions, exported as one portable bundle. */
function exportedBundle(sessions = 3): ProjectDataExport {
  const source = track(new WorkIntelligenceStore(":memory:"));
  const root = createDirectory();
  const project = source.addProject("Synthetic import safety", root);
  source.updateProject(project.id, { status: "tracked" });
  for (let index = 0; index < sessions; index += 1) {
    const result = source.finalizeSession({
      projectRoot: root,
      idempotencyKey: `safety-${index}`,
      title: `Synthetic Session ${index}`,
      summary: "Synthetic import safety summary.",
      completedAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + index * 60_000).toISOString(),
      events: [{ type: "execution", summary: `Synthetic event ${index}` }],
    });
    if (result.outcome !== "finalized") throw new Error(`Expected a finalized Session, got ${result.outcome}.`);
  }
  return source.exportProjectData({ type: "all" });
}

/** A file database (backups need a file) with its backups in their own directory. */
function fileStore(backupDirectory?: string): {
  store: WorkIntelligenceStore;
  databasePath: string;
  backups: string;
} {
  const directory = createDirectory();
  const databasePath = join(directory, "destination.sqlite");
  const backups = backupDirectory ?? join(directory, "backups");
  return {
    store: track(new WorkIntelligenceStore(databasePath, { backup: { directory: backups } })),
    databasePath,
    backups,
  };
}

function sessionCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function transferFailure(run: () => unknown): ProjectDataTransferError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectDataTransferError) return error;
    throw error;
  }
  throw new Error("Expected a ProjectDataTransferError.");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pre-import backup", () => {
  it("writes a checked snapshot of the database as it was before any imported row, with both strategies", () => {
    for (const strategy of ["merge", "newer-wins"] as const) {
      const { store, databasePath, backups } = fileStore();
      const result = store.importProjectData({ bundle: exportedBundle(), strategy });
      expect(result.additions.sessions).toBe(3);
      const [backup] = listDatabaseBackups(databasePath, backups);
      expect(backup).toMatchObject({ kind: "import", fileName: result.backupFileName });
      // The snapshot holds none of the imported Sessions: it was taken before the import wrote anything.
      expect(sessionCount(join(backups, result.backupFileName!))).toBe(0);
      expect(sessionCount(databasePath)).toBe(3);
    }
  });

  it("writes nothing for a preview, not even a backup", () => {
    const { store, databasePath, backups } = fileStore();
    expect(store.previewProjectDataImport({ bundle: exportedBundle() }).additions.sessions).toBe(3);
    expect(listDatabaseBackups(databasePath, backups)).toEqual([]);
    expect(sessionCount(databasePath)).toBe(0);
  });

  it("refuses to import when the backup cannot be written and leaves the database unchanged", () => {
    const directory = createDirectory();
    const blocked = join(directory, "not-a-directory");
    // A file where the directory should be: running as root ignores permission bits, this cannot be written through.
    writeFileSync(blocked, "synthetic file where the backup directory should be", "utf8");
    const { store, databasePath } = fileStore(blocked);
    const failure = transferFailure(() => store.importProjectData({ bundle: exportedBundle() }));
    expect(failure.code).toBe("project_backup_failed");
    expect(failure.message).not.toContain(directory);
    expect(sessionCount(databasePath)).toBe(0);
    expect(store.listProjects()).toEqual([]);
  });

  it("keeps import snapshots in their own group, so imports never push out manual or deletion backups", () => {
    const { store, databasePath, backups } = fileStore();
    store.createBackup();
    store.createBackup();
    const imported: ProjectDataImportResult[] = [];
    for (let index = 0; index < 5; index += 1) imported.push(store.importProjectData({ bundle: exportedBundle(1) }));
    const kept = listDatabaseBackups(databasePath, backups);
    expect(kept.filter((backup) => backup.kind === "manual")).toHaveLength(2);
    // As many as automatic backups keep (3 by default), the newest ones.
    expect(kept.filter((backup) => backup.kind === "import").map((backup) => backup.fileName)).toEqual(
      imported
        .slice(-3)
        .reverse()
        .map((result) => result.backupFileName),
    );
  });

  it("writes no snapshot for an import that changes nothing and says so", () => {
    const { store, databasePath, backups } = fileStore();
    const bundle = exportedBundle();
    const first = store.importProjectData({ bundle });
    expect(first).toMatchObject({ changed: true, backupFileName: expect.any(String) });
    const again = store.importProjectData({ bundle });
    expect(again.changed).toBe(false);
    expect(again.backupFileName).toBeUndefined();
    expect(again.skipped.sessions).toBe(3);
    expect(listDatabaseBackups(databasePath, backups).map((backup) => backup.fileName)).toEqual([first.backupFileName]);
  });

  it("writes no snapshot when planning fails", () => {
    const { store, databasePath, backups } = fileStore();
    const failure = transferFailure(() =>
      store.importProjectData({ bundle: exportedBundle(), projectId: "synthetic-project-not-in-file" }),
    );
    expect(failure.code).toBe("invalid_bundle");
    expect(listDatabaseBackups(databasePath, backups)).toEqual([]);
  });

  it("keeps the snapshot of an import that changed data through any number of imports that change nothing", () => {
    const { store, databasePath, backups } = fileStore();
    const bundle = exportedBundle();
    const real = store.importProjectData({ bundle });
    for (let index = 0; index < 4; index += 1) {
      expect(store.importProjectData({ bundle }).backupFileName).toBeUndefined();
      transferFailure(() => store.importProjectData({ bundle, projectId: "synthetic-project-not-in-file" }));
    }
    const kept = listDatabaseBackups(databasePath, backups).filter((backup) => backup.kind === "import");
    expect(kept.map((backup) => backup.fileName)).toEqual([real.backupFileName]);
    expect(sessionCount(join(backups, real.backupFileName!))).toBe(0);
  });

  it("keeps the database unchanged and the backup in place when the import fails halfway", () => {
    const { store, databasePath, backups } = fileStore();
    const bundle = exportedBundle();
    const lastEvent = bundle.tables.work_events.at(-1)!;
    // Abort on the last work event: the projects and Sessions before it were already written in the transaction.
    const writer = new DatabaseSync(databasePath);
    writer.exec(`CREATE TRIGGER synthetic_abort BEFORE INSERT ON work_events WHEN NEW.id = '${String(lastEvent.id)}'
      BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END`);
    writer.close();
    expect(() => store.importProjectData({ bundle })).toThrow("synthetic interruption");
    expect(sessionCount(databasePath)).toBe(0);
    expect(store.listProjects()).toEqual([]);
    const [backup] = listDatabaseBackups(databasePath, backups);
    expect(backup?.kind).toBe("import");
    expect(sessionCount(join(backups, backup!.fileName))).toBe(0);
  });
});

describe("write lock", () => {
  it("plans again inside the write transaction when the database changed after planning", () => {
    const { store, databasePath } = fileStore();
    const bundle = exportedBundle();
    const session = bundle.tables.sessions[0]!;
    // Another process stores a different copy of one imported Session between planning and writing. The plan made
    // before it would insert that Session again; planned again under the lock, the copy is a conflict instead.
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !injected) {
        injected = true;
        const other = track(new WorkIntelligenceStore(databasePath));
        other.importProjectData({
          bundle: { ...bundle, tables: { ...bundle.tables, sessions: [{ ...session, title: "Changed elsewhere" }] } },
        });
      }
      return exec.call(this, sql);
    });
    const result = store.importProjectData({ bundle });
    expect(injected).toBe(true);
    expect(result.additions.sessions).toBe(2);
    expect(result.conflicts.sessions).toBe(1);
    expect(store.getSessionById(String(session.id))?.title).toBe("Changed elsewhere");
  });
  it("backs up and tries again when a change after planning turns an import that changed nothing into one that does", () => {
    const { store, databasePath, backups } = fileStore();
    const bundle = exportedBundle();
    store.importProjectData({ bundle });
    const before = listDatabaseBackups(databasePath, backups).map((backup) => backup.fileName);
    const event = bundle.tables.work_events[0]!;
    // Everything is already here, so the plan writes nothing and takes no snapshot. Before the write lock another
    // process deletes one imported work event: planned again under the lock, the import would add it back.
    const exec = DatabaseSync.prototype.exec;
    let locks = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") {
        locks += 1;
        if (locks === 1) {
          const other = new DatabaseSync(databasePath);
          other.prepare("DELETE FROM work_events WHERE id = ?").run(String(event.id));
          other.close();
        }
      }
      return exec.call(this, sql);
    });
    const result = store.importProjectData({ bundle });
    // The first lock was released without writing; the second attempt backed up first.
    expect(result).toMatchObject({ changed: true, additions: { work_events: 1 } });
    const created = listDatabaseBackups(databasePath, backups).filter((backup) => !before.includes(backup.fileName));
    expect(created.map((backup) => backup.fileName)).toEqual([result.backupFileName]);
    // The snapshot is the state the import started from: restoring it removes the event the import added.
    const snapshot = new DatabaseSync(join(backups, result.backupFileName!), { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM work_events WHERE id = ?").get(String(event.id))).toEqual({
        count: 0,
      });
    } finally {
      snapshot.close();
    }
  });
});

describe("rows whose parent is not in the file", () => {
  it("counts them per table with a reason and imports every other row exactly as before", () => {
    const bundle = exportedBundle();
    const orphan = { ...bundle.tables.sessions[0]!, id: "synthetic-orphan", idempotency_key: "synthetic-orphan" };
    const withOrphan = {
      ...bundle,
      tables: { ...bundle.tables, sessions: [...bundle.tables.sessions, { ...orphan, project_id: "not-in-file" }] },
    };
    const { store } = fileStore();
    const preview = store.previewProjectDataImport({ bundle: withOrphan });
    expect(preview.additions.sessions).toBe(3);
    expect(preview.conflicts.sessions).toBe(1);
    expect(preview.conflictGroups).toEqual([
      {
        category: "missing_parent",
        table: "sessions",
        reason: "所屬專案不在匯入檔中。",
        count: 1,
        sampleIds: ["synthetic-orphan"],
      },
    ]);
    const result = store.importProjectData({ bundle: withOrphan });
    expect(result).toMatchObject({ additions: { sessions: 3 }, conflicts: { sessions: 1 } });
    expect(store.getSessionById("synthetic-orphan")).toBeUndefined();
  });

  it("reports a Session child whose Session is missing when one project is picked from an all-project file", () => {
    const bundle = exportedBundle();
    const projectId = String(bundle.tables.projects[0]!.id);
    const event = { ...bundle.tables.work_events[0]!, id: "synthetic-event", session_id: "missing-session" };
    const withOrphan = { ...bundle, tables: { ...bundle.tables, work_events: [...bundle.tables.work_events, event] } };
    const { store } = fileStore();
    const preview = store.previewProjectDataImport({ bundle: withOrphan, projectId });
    expect(preview.conflictGroups).toEqual([
      expect.objectContaining({ category: "missing_parent", table: "work_events", sampleIds: ["synthetic-event"] }),
    ]);
  });

  it("does not report rows of a project in the file that was not selected", () => {
    const first = exportedBundle(2);
    const second = exportedBundle(1);
    const both: ProjectDataExport = {
      ...first,
      tables: Object.fromEntries(
        Object.entries(first.tables).map(([table, rows]) => [
          table,
          [...rows, ...second.tables[table as keyof ProjectDataExport["tables"]]],
        ]),
      ) as ProjectDataExport["tables"],
    };
    const { store } = fileStore();
    const preview = store.previewProjectDataImport({ bundle: both, projectId: String(first.tables.projects[0]!.id) });
    expect(preview.additions.sessions).toBe(2);
    expect(preview.conflictGroups).toEqual([]);
  });

  it("skips such a row when this database already holds the same copy", () => {
    const bundle = exportedBundle();
    const { store } = fileStore();
    store.importProjectData({ bundle });
    // The same Sessions without their project: nothing is lost, so nothing is reported.
    const sessionsOnly = {
      ...bundle,
      tables: { ...bundle.tables, projects: [{ ...bundle.tables.projects[0]!, id: "other-project" }] },
    };
    const preview = store.previewProjectDataImport({ bundle: sessionsOnly });
    expect(preview.skipped.sessions).toBe(3);
    expect(preview.conflictGroups.filter((group) => group.category === "missing_parent")).toEqual([]);
  });
});

describe("validated import", () => {
  it("validates once: an already validated import is passed through and reused for preview and import", () => {
    const validated = ValidatedProjectDataImport.validate({ bundle: exportedBundle() });
    expect(ValidatedProjectDataImport.from(validated)).toBe(validated);
    const { store } = fileStore();
    expect(store.previewProjectDataImport(validated).additions.sessions).toBe(3);
    expect(store.importProjectData(validated).additions.sessions).toBe(3);
    expect(store.importProjectData(validated).skipped.sessions).toBe(3);
  });

  it("validates only the options when they change", () => {
    const validated = ValidatedProjectDataImport.validate({ bundle: exportedBundle() });
    const failure = transferFailure(() => validated.withOptions({ strategy: "overwrite" }));
    expect(failure.code).toBe("invalid_input");
    expect(validated.withOptions({ strategy: "merge" }).input).toMatchObject({ strategy: "merge" });
    expect(validated.withOptions({ strategy: "merge" }).input.bundle).toBe(validated.input.bundle);
  });

  it("keeps the counts of masked text from the file", () => {
    const bundle = exportedBundle(1);
    bundle.tables.sessions[0]!.summary = "Synthetic token=abcdefghijklmnop12345 leaked.";
    const validated = ValidatedProjectDataImport.validate({ bundle });
    expect(validated.redactions.total).toBe(1);
    expect(String(validated.input.bundle.tables.sessions[0]!.summary)).toContain("[REDACTED:environment_secret]");
    // The file's own objects are never changed.
    expect(bundle.tables.sessions[0]!.summary).toContain("abcdefghijklmnop12345");
  });
});
