import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataExport, ProjectDataImportInput } from "@work-intelligence/core";
import {
  isDatabaseBusyError,
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";
import { undoMigrationsAfter } from "../helpers/schema-migration-fixture.js";

const roots: string[] = [];

function syntheticProject(store: WorkIntelligenceStore, projectRoot: string): void {
  mkdirSync(projectRoot);
  const project = store.addProject("Backup worker fixture", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  const result = store.finalizeSession({
    projectRoot,
    idempotencyKey: "backup-worker-session",
    title: "Synthetic worker Session",
    summary: "Used to verify project-data worker operations.",
    changedFiles: ["src/worker.ts"],
    verification: { status: "passed" },
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
  });
  if (result.outcome !== "finalized") throw new Error("Could not create the synthetic worker Session.");
}

function assertHealthy(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    database.close();
  }
}

function decodeProjectDataExport(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

describe("backup worker", () => {
  it("refuses an older schema without changing the database or backup directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-old-schema-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const initialStore = new WorkIntelligenceStore(databasePath);
    initialStore.close();
    const oldDatabase = new DatabaseSync(databasePath);
    undoMigrationsAfter(oldDatabase, LATEST_SCHEMA_VERSION - 1);
    oldDatabase.close();

    const backupDirectory = join(root, "backups");
    const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
    const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION);

    await expect(worker.createBackup()).rejects.toThrow(/資料庫 schema 版本 .* 與背景工作要求的版本 .* 不符/i);
    await expect(worker.createBackup()).rejects.toThrow(/資料庫 schema 版本 .* 與背景工作要求的版本 .* 不符/i);
    await worker.close();

    const current = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(current.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 30 });
    } finally {
      current.close();
    }
    expect(createHash("sha256").update(readFileSync(databasePath)).digest("hex")).toBe(before);
    expect(existsSync(backupDirectory)).toBe(false);
  });

  it("backs up and exports while another connection holds a write reservation", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-write-lock-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const projectRoot = join(root, "project");
    const store = new WorkIntelligenceStore(databasePath);
    syntheticProject(store, projectRoot);
    const lock = new DatabaseSync(databasePath);
    lock.exec("BEGIN IMMEDIATE");
    const worker = new BackupWorkerClient(databasePath);

    try {
      const backup = await worker.createBackup();
      expect(backup.outcome).toBe("database_backups");
      const exportedDatabase = await worker.exportTo(join(root, "export.sqlite"));
      expect(exportedDatabase.bytes).toBeGreaterThan(0);
      const exportedData = await worker.exportProjectData({ type: "all" });
      if (!(exportedData.content instanceof Uint8Array)) throw new Error("Expected transferred UTF-8 export bytes.");
      expect(exportedData.bytes).toBe(exportedData.content.byteLength);
      expect(
        (JSON.parse(decodeProjectDataExport(exportedData.content)) as ProjectDataExport).tables.sessions,
      ).toHaveLength(1);
    } finally {
      await worker.close();
      lock.exec("ROLLBACK");
      lock.close();
      store.close();
    }
  });

  it("preserves SQLite busy identity when a worker read meets an exclusive lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-busy-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const projectRoot = join(root, "project");
    const store = new WorkIntelligenceStore(databasePath);
    syntheticProject(store, projectRoot);
    store.close();
    const configureJournal = new DatabaseSync(databasePath);
    configureJournal.exec("PRAGMA journal_mode = DELETE");
    configureJournal.close();

    const worker = new BackupWorkerClient(databasePath);
    const lock = new DatabaseSync(databasePath);
    try {
      await worker.exportProjectData({ type: "all" });
      lock.exec("BEGIN EXCLUSIVE");
      const failure = await worker.exportProjectData({ type: "all" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(isDatabaseBusyError(failure)).toBe(true);
    } finally {
      try {
        lock.exec("ROLLBACK");
      } catch {
        // The lock may not have been acquired when setup fails.
      }
      lock.close();
      await worker.close();
    }
  });

  it("runs snapshots and portable project operations on a separate connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-test-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const worker = new BackupWorkerClient(databasePath);

    try {
      syntheticProject(store, projectRoot);

      const backup = await worker.createBackup();
      expect(backup.outcome).toBe("database_backups");
      if (backup.outcome !== "database_backups") throw new Error("The file database should be backed up.");
      expect(existsSync(join(root, "backups", backup.created.fileName))).toBe(true);

      const exported = await worker.exportProjectData({ type: "all" });
      const exportedContent = decodeProjectDataExport(exported.content);
      expect(exported.content).toBeInstanceOf(Uint8Array);
      expect(exported.bytes).toBe(Buffer.byteLength(exportedContent));
      const bundle = JSON.parse(exportedContent) as ProjectDataExport;
      expect(bundle.tables.sessions).toHaveLength(1);

      const preview = await worker.previewProjectDataImport({ bundle });
      expect(preview.outcome).toBe("project_data_import_preview");
      expect(preview.skipped.sessions).toBe(1);
      expect(preview.selectedProjects[0]?.folderStatus).toBe("found");

      const transferredPreview = await worker.previewProjectDataImport(
        new TextEncoder().encode(JSON.stringify({ bundle })),
      );
      expect(transferredPreview.outcome).toBe("project_data_import_preview");
      expect(transferredPreview.skipped.sessions).toBe(1);
      await expect(worker.previewProjectDataImport(new TextEncoder().encode("{"))).rejects.toMatchObject({
        name: "RequestBodyError",
        statusCode: 400,
        message: "Invalid JSON request body.",
      });

      const invalidInput = { bundle: {} as ProjectDataExport } as ProjectDataImportInput;
      await expect(worker.previewProjectDataImport(invalidInput)).rejects.toBeInstanceOf(ProjectDataTransferError);

      const exportDirectory = join(root, "user-selected-export");
      mkdirSync(exportDirectory);
      const wholeDatabasePath = join(exportDirectory, "whole-database.sqlite");
      const wholeDatabase = await worker.exportTo(wholeDatabasePath);
      expect(wholeDatabase.bytes).toBe(statSync(wholeDatabasePath).size);
      expect(readdirSync(exportDirectory)).toEqual(["whole-database.sqlite"]);
      assertHealthy(wholeDatabasePath);

      const activePreview = worker.previewProjectDataImport({ bundle });
      const workerClosing = worker.close();
      expect((await activePreview).outcome).toBe("project_data_import_preview");
      await workerClosing;
      await expect(worker.createBackup()).rejects.toThrow("The backup worker is closing.");
    } finally {
      await worker.close();
      store.close();
    }

    assertHealthy(databasePath);
  });

  it("does not reject a replacement worker's requests when an older lifetime exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-lifetime-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const worker = new BackupWorkerClient(databasePath);
    const workerState = worker as unknown as {
      lifetime?: object;
      pending: Map<number, { lifetime: object; resolve(value: unknown): void; reject(error: unknown): void }>;
      rejectPending(error: unknown, lifetime: object): void;
    };

    try {
      await worker.exportProjectData({ type: "all" });
      const previousLifetime = workerState.lifetime;
      if (!previousLifetime) throw new Error("Expected a live backup worker lifetime.");

      const replacementLifetime = {};
      let replacementFailure: unknown;
      workerState.pending.set(-1, {
        lifetime: replacementLifetime,
        resolve() {},
        reject(error) {
          replacementFailure = error;
        },
      });

      workerState.rejectPending(new Error("The previous worker exited."), previousLifetime);

      expect(workerState.pending.has(-1)).toBe(true);
      expect(replacementFailure).toBeUndefined();
      workerState.pending.delete(-1);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("stops an idle worker and starts a fresh one for the next operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-idle-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION, { idleTimeoutMs: 25 });
    const workerState = worker as unknown as { lifetime?: { worker: { threadId: number } } };

    try {
      await worker.exportProjectData({ type: "all" });
      const firstThreadId = workerState.lifetime?.worker.threadId;
      expect(firstThreadId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(workerState.lifetime).toBeUndefined();

      await worker.exportProjectData({ type: "all" });
      expect(workerState.lifetime?.worker.threadId).not.toBe(firstThreadId);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("does not leave a partial snapshot under a recognized backup filename", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-files-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const worker = new BackupWorkerClient(databasePath);

    try {
      const backup = await worker.createBackup();
      expect(backup.outcome).toBe("database_backups");
      const files = readdirSync(join(root, "backups"));
      expect(files.every((file) => file.endsWith(".sqlite"))).toBe(true);
    } finally {
      await worker.close();
      store.close();
    }
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
