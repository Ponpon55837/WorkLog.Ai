import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataExport, ProjectDataImportInput } from "@work-intelligence/core";
import { ProjectDataTransferError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";

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

describe("backup worker", () => {
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
      expect(exported.bytes).toBe(Buffer.byteLength(exported.content));
      const bundle = JSON.parse(exported.content) as ProjectDataExport;
      expect(bundle.tables.sessions).toHaveLength(1);

      const preview = await worker.previewProjectDataImport({ bundle });
      expect(preview.outcome).toBe("project_data_import_preview");
      expect(preview.skipped.sessions).toBe(1);
      expect(preview.selectedProjects[0]?.folderStatus).toBe("found");

      const invalidInput = { bundle: {} as ProjectDataExport } as ProjectDataImportInput;
      await expect(worker.previewProjectDataImport(invalidInput)).rejects.toBeInstanceOf(ProjectDataTransferError);

      const exportPath = join(root, "whole-database.sqlite");
      const wholeDatabase = await worker.exportTo(exportPath);
      expect(wholeDatabase.bytes).toBe(statSync(exportPath).size);
      assertHealthy(exportPath);

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
