import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDatabaseBusyError, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { BackupWorkerClient } from "../../apps/server/src/backup-worker-client.js";
import type { ProjectDataImportUpload } from "../../apps/server/src/routes/router.js";
import { writeImportRequest, writeSyntheticProjectExport } from "../helpers/synthetic-project-export.js";

// Fictional data only. A large import runs in a child process; killing that process in the middle of the write must
// leave the database whole and unchanged (the import is one transaction), and the next worker must import the same
// file. The write is detected from another connection: while the import's transaction holds the write lock, a probe
// that does not wait sees SQLITE_BUSY.

// The export holds the 2,000 generated Sessions and the one template Session they are made from.
const IMPORTED_SESSIONS = 2_001;
const roots: string[] = [];

interface WorkerState {
  lifetime?: { child: { pid?: number; kill(signal?: NodeJS.Signals): boolean } };
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-worker-kill-"));
  roots.push(root);
  return root;
}

function sessionCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number((database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function integrity(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("PRAGMA integrity_check").get();
  } finally {
    database.close();
  }
}

/** True while another connection holds the database's write lock; never waits for it and never keeps it. */
function writeLockProbe(databasePath: string): { held(): boolean; close(): void } {
  const probe = new DatabaseSync(databasePath);
  probe.exec("PRAGMA busy_timeout = 0");
  return {
    held() {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
        return false;
      } catch (error) {
        if (isDatabaseBusyError(error)) return true;
        throw error;
      }
    },
    close() {
      probe.close();
    },
  };
}

async function untilWriteLockHeld(
  probe: { held(): boolean },
  settled: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe.held()) {
    if (settled()) throw new Error("The import finished before its write lock was seen.");
    if (Date.now() > deadline) throw new Error("Timed out waiting for the import to take the write lock.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fixture(): {
  databasePath: string;
  store: WorkIntelligenceStore;
  largeUpload: () => ProjectDataImportUpload;
  root: string;
} {
  const root = createRoot();
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const project = store.addProject("Kill test destination", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  store.finalizeSession({
    projectRoot,
    idempotencyKey: "kill-test-session",
    title: "Synthetic destination Session",
    summary: "Already in the database before the import.",
    completedAt: "2026-04-01T00:00:00.000Z",
  });
  const bundleFile = join(root, "export.json");
  writeSyntheticProjectExport(bundleFile, IMPORTED_SESSIONS - 1);
  const largeUpload = (): ProjectDataImportUpload => {
    const directory = mkdtempSync(join(root, "import-"));
    const path = join(directory, "import.json");
    writeImportRequest(bundleFile, path);
    return { path, directory };
  };
  return { databasePath, store, largeUpload, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a background worker killed in the middle of an import", () => {
  it("rejects clearly, leaves the database whole and unchanged, and lets a new worker import the same file", async () => {
    const { databasePath, store, largeUpload } = fixture();
    const worker = new BackupWorkerClient(databasePath);
    const probe = writeLockProbe(databasePath);
    const state = worker as unknown as WorkerState;
    try {
      const before = sessionCount(databasePath);
      expect(before).toBe(1);

      let settled = false;
      const failing = worker.importProjectData(largeUpload()).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await untilWriteLockHeld(probe, () => settled);
      const child = state.lifetime?.child;
      expect(child?.pid).toBeGreaterThan(0);
      // SIGKILL cannot be handled by the child; on Windows Node ends the process whatever the signal.
      child?.kill("SIGKILL");

      const failure = await failing;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/background worker exited unexpectedly/);

      // The database opens, is intact, and nothing of the import is in it.
      expect(integrity(databasePath)).toEqual({ integrity_check: "ok" });
      expect(sessionCount(databasePath)).toBe(before);
      expect(store.listProjects()).toHaveLength(1);
      expect(probe.held()).toBe(false);

      // A new process serves the same import, and it lands completely.
      const imported = await worker.importProjectData(largeUpload());
      expect(imported).toMatchObject({ outcome: "project_data_imported", changed: true });
      expect(state.lifetime?.child.pid).not.toBe(child?.pid);
      expect(sessionCount(databasePath)).toBe(before + IMPORTED_SESSIONS);
      expect(integrity(databasePath)).toEqual({ integrity_check: "ok" });
      expect(store.listProjects()).toHaveLength(2);
    } finally {
      probe.close();
      await worker.close();
      store.close();
    }
  }, 60_000);

  it("lets the API store read the database while the import holds the write lock", async () => {
    const { databasePath, store, largeUpload } = fixture();
    const worker = new BackupWorkerClient(databasePath);
    const probe = writeLockProbe(databasePath);
    try {
      let settled = false;
      const importing = worker.importProjectData(largeUpload()).finally(() => {
        settled = true;
      });
      await untilWriteLockHeld(probe, () => settled);

      // WAL readers are not blocked by the writer: they see the database as it was before the import began.
      const started = Date.now();
      expect(store.listProjects()).toHaveLength(1);
      expect(store.getChangeToken().dataRevision).toBeGreaterThan(0);
      expect(sessionCount(databasePath)).toBe(1);
      expect(Date.now() - started).toBeLessThan(2_000);

      await importing;
      expect(store.listProjects()).toHaveLength(2);
      expect(sessionCount(databasePath)).toBe(1 + IMPORTED_SESSIONS);
    } finally {
      probe.close();
      await worker.close();
      store.close();
    }
  }, 60_000);
});
