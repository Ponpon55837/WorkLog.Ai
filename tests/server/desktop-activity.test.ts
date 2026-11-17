import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";
import { createApiHandler } from "../../apps/server/src/server.js";

// What the desktop child reports as the backend's long jobs (the port change refuses while any runs). Synthetic data only.
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-activity-"));
  roots.push(root);
  return root;
}

describe("backup worker activity", () => {
  it("names a backup and an export while they run, and nothing once they ended", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "work-intelligence.sqlite");
    new WorkIntelligenceStore(databasePath).close();
    const worker = new BackupWorkerClient(databasePath);
    try {
      expect(worker.activity()).toEqual([]);
      const backup = worker.createBackup();
      expect(worker.activity()).toEqual(["backup"]);
      await backup;
      const exported = worker.exportTo(join(root, "export.sqlite"));
      expect(worker.activity()).toEqual(["export"]);
      await exported;
      expect(worker.activity()).toEqual([]);
    } finally {
      await worker.close();
    }
  });
});

describe("API handler activity", () => {
  it("is empty when nothing runs, and lists the background jobs once each", () => {
    const store = new WorkIntelligenceStore(":memory:");
    try {
      expect(createApiHandler(store).activity()).toEqual([]);
      expect(createApiHandler(store, { backgroundActivity: () => ["backup", "backup", "export"] }).activity()).toEqual([
        "backup",
        "export",
      ]);
    } finally {
      store.close();
    }
  });
});
