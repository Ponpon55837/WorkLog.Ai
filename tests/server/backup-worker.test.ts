import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport } from "@work-intelligence/core";
import {
  isDatabaseBusyError,
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { BackupWorkerOutOfMemoryError, BackupWorkerTimeoutError } from "../../apps/server/src/backup-worker-errors.js";
import {
  BackupWorkerClient,
  BACKUP_WORKER_HEAP_MB,
  DEFAULT_IDLE_TIMEOUT_MS,
  HEAVY_IDLE_TIMEOUT_MS,
} from "../../apps/server/src/backup-worker-client.js";
import type { ProjectDataImportUpload } from "../../apps/server/src/routes/router.js";
import { writeImportRequest, writeSyntheticProjectExport } from "../helpers/synthetic-project-export.js";
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

/** An import request body in its own transfer directory, as the REST route hands it to the worker. */
function upload(root: string, content: string): ProjectDataImportUpload {
  const directory = mkdtempSync(join(root, "import-"));
  const path = join(directory, "import.json");
  writeFileSync(path, content);
  return { path, directory };
}

/** The portable export of every project, written by the worker to a fresh file and read back. */
async function exportedText(worker: BackupWorkerClient, root: string): Promise<{ text: string; bytes: number }> {
  const directory = mkdtempSync(join(root, "export-"));
  const target = join(directory, "export.json");
  const { bytes } = await worker.exportProjectData({ type: "all" }, target);
  return { text: readFileSync(target, "utf8"), bytes };
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
      expect(current.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
        version: LATEST_SCHEMA_VERSION - 1,
      });
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
      const exportedData = await exportedText(worker, root);
      expect(exportedData.bytes).toBe(Buffer.byteLength(exportedData.text));
      expect((JSON.parse(exportedData.text) as ProjectDataExport).tables.sessions).toHaveLength(1);
      const again = await exportedText(worker, root);
      const withoutStamp = (text: string) => {
        const { exportedAt: _exportedAt, ...rest } = JSON.parse(text) as ProjectDataExport;
        return rest;
      };
      expect(withoutStamp(again.text)).toEqual(withoutStamp(exportedData.text));
      expect((await worker.createBackup()).outcome).toBe("database_backups");
      // A size limit is enforced while writing, and the refusal keeps its type across the worker boundary (L-23).
      const limited = join(mkdtempSync(join(root, "export-")), "limited.json");
      await expect(worker.exportProjectData({ type: "all" }, limited, 10)).rejects.toMatchObject({
        name: "ProjectDataTransferError",
        code: "export_too_large",
      });
      expect(existsSync(limited)).toBe(false);
      const staging = await worker.exportTo(join(root, "staging.sqlite"), { durable: false });
      expect(staging.bytes).toBe(statSync(join(root, "staging.sqlite")).size);
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
      await exportedText(worker, root);
      lock.exec("BEGIN EXCLUSIVE");
      const failure = await exportedText(worker, root).then(
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

      const exported = await exportedText(worker, root);
      const bundle = JSON.parse(exported.text) as ProjectDataExport;
      expect(bundle.tables.sessions).toHaveLength(1);

      const request = JSON.stringify({ bundle });
      const preview = await worker.previewProjectDataImport(upload(root, request));
      expect(preview.outcome).toBe("project_data_import_preview");
      expect(preview.skipped.sessions).toBe(1);
      expect(preview.selectedProjects[0]?.folderStatus).toBe("found");
      await expect(worker.previewProjectDataImport(upload(root, "{"))).rejects.toMatchObject({
        name: "RequestBodyError",
        statusCode: 400,
        message: "Invalid JSON request body.",
      });
      await expect(worker.previewProjectDataImport(upload(root, '{"bundle":{}}'))).rejects.toBeInstanceOf(
        ProjectDataTransferError,
      );

      const exportDirectory = join(root, "user-selected-export");
      mkdirSync(exportDirectory);
      const wholeDatabasePath = join(exportDirectory, "whole-database.sqlite");
      const wholeDatabase = await worker.exportTo(wholeDatabasePath);
      expect(wholeDatabase.bytes).toBe(statSync(wholeDatabasePath).size);
      expect(readdirSync(exportDirectory)).toEqual(["whole-database.sqlite"]);
      assertHealthy(wholeDatabasePath);

      const activePreview = worker.previewProjectDataImport(upload(root, request));
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
      await exportedText(worker, root);
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
    const workerState = worker as unknown as { lifetime?: { child: { pid?: number } } };

    try {
      await exportedText(worker, root);
      const firstPid = workerState.lifetime?.child.pid;
      expect(firstPid).toBeDefined();
      // The idle timer fires after 25 ms, but the worker then closes its database and exits; wait for that exit (it is
      // what clears the lifetime) instead of a fixed time, which a slow runner can exceed. No operation runs meanwhile.
      await vi.waitFor(() => expect(workerState.lifetime).toBeUndefined(), { timeout: 10_000, interval: 25 });

      await exportedText(worker, root);
      expect(workerState.lifetime?.child.pid).not.toBe(firstPid);
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

interface IdleWorkerState {
  lifetime?: { child: { pid?: number }; heavy: boolean; retiring: boolean };
}

function createIdleFixture(options?: { idleTimeoutMs?: number }) {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-idle-policy-"));
  roots.push(root);
  const databasePath = join(root, "work-intelligence.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION, options);
  const state = worker as unknown as IdleWorkerState;
  return { root, store, worker, state };
}

/** Waits on real I/O (not the faked timers) until the worker process has exited. */
async function waitForWorkerExit(state: IdleWorkerState): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (state.lifetime && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  expect(state.lifetime).toBeUndefined();
}

describe("backup worker idle policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits one heavy-idle period after a heavy operation and not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture();
    try {
      await exportedText(worker, root);
      const pid = state.lifetime?.child.pid;
      expect(pid).toBeDefined();

      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);
      expect(state.lifetime?.child.pid).toBe(pid);

      await vi.advanceTimersByTimeAsync(1);
      await waitForWorkerExit(state);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("keeps the worker for the longer idle period after a light operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, worker, state } = createIdleFixture();
    try {
      await worker.createBackup();
      expect(state.lifetime?.heavy).toBe(false);

      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS * 2);
      expect(state.lifetime).toBeDefined();
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - HEAVY_IDLE_TIMEOUT_MS * 2 - 1);
      expect(state.lifetime).toBeDefined();

      await vi.advanceTimersByTimeAsync(1);
      await waitForWorkerExit(state);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("re-arms the idle timer from the end of the latest operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture();
    try {
      await exportedText(worker, root);
      const pid = state.lifetime?.child.pid;
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 100);

      // A request that lands just before the timer would fire cancels it and keeps the same worker.
      await worker.exportTo(join(root, "second.sqlite"));
      expect(state.lifetime?.child.pid).toBe(pid);
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);
      expect(state.lifetime?.child.pid).toBe(pid);

      await vi.advanceTimersByTimeAsync(1);
      await waitForWorkerExit(state);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("does not cut an in-flight request when the idle period elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture();
    try {
      await exportedText(worker, root);
      const pid = state.lifetime?.child.pid;
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);

      const inFlight = exportedText(worker, root);
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS * 2);

      expect((await inFlight).bytes).toBeGreaterThan(0);
      expect(state.lifetime?.child.pid).toBe(pid);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("does not keep a heavy worker's short timeout for the next worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture();
    try {
      await exportedText(worker, root);
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS);
      await waitForWorkerExit(state);

      await worker.createBackup();
      expect(state.lifetime?.heavy).toBe(false);
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS * 2);
      expect(state.lifetime).toBeDefined();
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("starts a fresh worker for a request that arrives while the idle worker is terminating", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture();
    try {
      await exportedText(worker, root);
      const firstThreadId = state.lifetime?.child.pid;

      // The idle timer fires and the old worker starts retiring; the next request arrives before it has exited.
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS);
      expect(state.lifetime?.retiring).toBe(true);
      const next = exportedText(worker, root);

      expect((await next).bytes).toBeGreaterThan(0);
      expect(state.lifetime?.child.pid).toBeDefined();
      expect(state.lifetime?.child.pid).not.toBe(firstThreadId);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("lets an explicit idle timeout override both defaults", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, store, worker, state } = createIdleFixture({ idleTimeoutMs: 40_000 });
    try {
      await exportedText(worker, root);
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS + 1);
      expect(state.lifetime).toBeDefined();

      await vi.advanceTimersByTimeAsync(40_000 - DEFAULT_IDLE_TIMEOUT_MS - 1);
      await waitForWorkerExit(state);
    } finally {
      await worker.close();
      store.close();
    }
  });
});

describe("backup worker watchdog", () => {
  it("stops a process that does not answer in time and serves the next request with a new one (L-26)", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-watchdog-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    syntheticProject(store, join(root, "project"));
    // Starting the process alone takes far longer than 1 ms, so the first request always outlives its watchdog.
    const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION, { operationTimeoutMs: 1 });
    const state = worker as unknown as { lifetime?: { child: { pid?: number; exitCode: number | null } } };
    try {
      const target = join(mkdtempSync(join(root, "export-")), "export.json");
      const failure = await worker.exportProjectData({ type: "all" }, target).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BackupWorkerTimeoutError);
      expect((failure as Error).message).not.toContain(root);
      const stopped = state.lifetime?.child;
      await vi.waitFor(() => expect(state.lifetime?.child === stopped).toBe(false));

      (worker as unknown as { options: { operationTimeoutMs?: number } }).options.operationTimeoutMs = undefined;
      expect((await exportedText(worker, root)).bytes).toBeGreaterThan(0);
      assertHealthy(databasePath);
    } finally {
      await worker.close();
      store.close();
    }
  });
});

/**
 * A heap large enough to start the worker (through tsx, as in these tests) and answer a small request, and too small
 * for the planner's rows of {@link OUT_OF_MEMORY_SESSIONS} Sessions; measured on Linux with Node 22: a 17.5 MiB request
 * needs 48 MiB and fails at 32, an empty one passes at 20.
 */
const OUT_OF_MEMORY_HEAP_MB = 32;
const OUT_OF_MEMORY_SESSIONS = 4_000;

describe("backup worker memory limits", () => {
  it("bounds the worker's heap by default like the desktop backend", () => {
    expect(BACKUP_WORKER_HEAP_MB).toBe(1024);
  });

  it("refuses a heap too small to start, before starting anything", async () => {
    const worker = new BackupWorkerClient(":memory:", {}, LATEST_SCHEMA_VERSION, { heapMb: 8 });
    await expect(worker.createBackup()).rejects.toBeInstanceOf(RangeError);
    await worker.close();
  });

  it("survives a real out-of-memory exit, rejects every queued request, and serves the next one on a new process", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-oom-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const projectRoot = join(root, "project");
    const store = new WorkIntelligenceStore(databasePath);
    syntheticProject(store, projectRoot);
    const bundleFile = join(root, "large-export.json");
    writeSyntheticProjectExport(bundleFile, OUT_OF_MEMORY_SESSIONS);
    const large = (): ProjectDataImportUpload => {
      const directory = mkdtempSync(join(root, "import-"));
      const path = join(directory, "import.json");
      writeImportRequest(bundleFile, path);
      return { path, directory };
    };
    const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION, { heapMb: OUT_OF_MEMORY_HEAP_MB });
    const pids = new Set<number>();
    const state = worker as unknown as { lifetime?: { child: { pid?: number } } };

    try {
      const small = JSON.stringify({
        bundle: JSON.parse((await exportedText(worker, root)).text) as ProjectDataExport,
      });
      pids.add(state.lifetime?.child.pid ?? -1);

      // The import exhausts the heap for real; the preview queued behind it is rejected with the same error, not left
      // waiting. The test process is a different process, so it is not affected.
      const settled = await Promise.allSettled([
        worker.importProjectData(large()),
        worker.previewProjectDataImport(upload(root, small)),
      ]);
      for (const failure of settled) {
        expect(failure.status).toBe("rejected");
        const reason = (failure as PromiseRejectedResult).reason as BackupWorkerOutOfMemoryError;
        expect(reason).toBeInstanceOf(BackupWorkerOutOfMemoryError);
        expect(reason.code).toBe("backup_worker_out_of_memory");
        expect(reason.message).not.toContain(root);
      }
      expect(store.listProjects()).toHaveLength(1);
      assertHealthy(databasePath);

      // The next request gets a fresh process that works.
      expect((await worker.previewProjectDataImport(upload(root, small))).outcome).toBe("project_data_import_preview");
      pids.add(state.lifetime?.child.pid ?? -1);
      expect(pids.size).toBe(2);
    } finally {
      await worker.close();
      store.close();
    }
  }, 120_000);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
