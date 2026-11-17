import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport, ProjectDataImportInput } from "@work-intelligence/core";
import {
  isDatabaseBusyError,
  LATEST_SCHEMA_VERSION,
  ProjectDataTransferError,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { BackupWorkerOutOfMemoryError } from "../../apps/server/src/backup-worker-errors.js";
import {
  BackupWorkerClient,
  BACKUP_WORKER_RESOURCE_LIMITS,
  DEFAULT_IDLE_TIMEOUT_MS,
  HEAVY_IDLE_TIMEOUT_MS,
} from "../../apps/server/src/backup-worker-client.js";
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

// A heap far below the production limit. The document is millions of small objects, which grow the worker's heap
// gradually until it hits the limit (one huge string would be a single allocation that aborts the whole process).
const TINY_WORKER_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 6 };

function oversizedImportBytes(objects: number): Uint8Array {
  return new TextEncoder().encode(`{"bundle":{"padding":[${'{"a":1},'.repeat(objects)}0]}}`);
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
      const exportedData = await worker.exportProjectData({ type: "all" });
      if (!(exportedData.content instanceof Uint8Array)) throw new Error("Expected transferred UTF-8 export bytes.");
      expect(exportedData.bytes).toBe(exportedData.content.byteLength);
      expect(
        (JSON.parse(decodeProjectDataExport(exportedData.content)) as ProjectDataExport).tables.sessions,
      ).toHaveLength(1);
      // A small export is a slice of Node's buffer pool: it is copied onto its own block before the transfer, so the
      // worker's pool survives, a second export is whole, and no other bytes of the pool come along.
      const again = await worker.exportProjectData({ type: "all" });
      expect(again.bytes).toBeLessThan(Buffer.poolSize / 2);
      if (!(again.content instanceof Uint8Array)) throw new Error("Expected transferred UTF-8 export bytes.");
      expect({ offset: again.content.byteOffset, block: again.content.buffer.byteLength }).toEqual({
        offset: 0,
        block: again.bytes,
      });
      const withoutStamp = (content: Uint8Array) => {
        const { exportedAt: _exportedAt, ...rest } = JSON.parse(decodeProjectDataExport(content)) as ProjectDataExport;
        return rest;
      };
      expect(withoutStamp(again.content)).toEqual(withoutStamp(exportedData.content));
      expect((await worker.createBackup()).outcome).toBe("database_backups");
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

interface IdleWorkerState {
  lifetime?: { worker: { threadId: number }; heavy: boolean; retiring: boolean };
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

/** Waits on real I/O (not the faked timers) until the worker thread has exited. */
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
    const { store, worker, state } = createIdleFixture();
    try {
      await worker.exportProjectData({ type: "all" });
      const threadId = state.lifetime?.worker.threadId;
      expect(threadId).toBeDefined();

      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);
      expect(state.lifetime?.worker.threadId).toBe(threadId);

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
      await worker.exportProjectData({ type: "all" });
      const threadId = state.lifetime?.worker.threadId;
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 100);

      // A request that lands just before the timer would fire cancels it and keeps the same worker.
      await worker.exportTo(join(root, "second.sqlite"));
      expect(state.lifetime?.worker.threadId).toBe(threadId);
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);
      expect(state.lifetime?.worker.threadId).toBe(threadId);

      await vi.advanceTimersByTimeAsync(1);
      await waitForWorkerExit(state);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("does not cut an in-flight request when the idle period elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, worker, state } = createIdleFixture();
    try {
      await worker.exportProjectData({ type: "all" });
      const threadId = state.lifetime?.worker.threadId;
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS - 1);

      const inFlight = worker.exportProjectData({ type: "all" });
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS * 2);

      expect((await inFlight).bytes).toBeGreaterThan(0);
      expect(state.lifetime?.worker.threadId).toBe(threadId);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("does not keep a heavy worker's short timeout for the next worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, worker, state } = createIdleFixture();
    try {
      await worker.exportProjectData({ type: "all" });
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
    const { store, worker, state } = createIdleFixture();
    try {
      await worker.exportProjectData({ type: "all" });
      const firstThreadId = state.lifetime?.worker.threadId;

      // The idle timer fires and the old worker starts retiring; the next request arrives before it has exited.
      await vi.advanceTimersByTimeAsync(HEAVY_IDLE_TIMEOUT_MS);
      expect(state.lifetime?.retiring).toBe(true);
      const next = worker.exportProjectData({ type: "all" });

      expect((await next).bytes).toBeGreaterThan(0);
      expect(state.lifetime?.worker.threadId).toBeDefined();
      expect(state.lifetime?.worker.threadId).not.toBe(firstThreadId);
    } finally {
      await worker.close();
      store.close();
    }
  });

  it("lets an explicit idle timeout override both defaults", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, worker, state } = createIdleFixture({ idleTimeoutMs: 40_000 });
    try {
      await worker.exportProjectData({ type: "all" });
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

describe("backup worker memory limits", () => {
  it("bounds the worker's heap by default to the measured need with headroom", () => {
    expect(BACKUP_WORKER_RESOURCE_LIMITS).toEqual({ maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 6 });
  });

  it("rejects with a recognizable error when the worker runs out of memory and serves the next request on a new worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-backup-worker-oom-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const projectRoot = join(root, "project");
    const store = new WorkIntelligenceStore(databasePath);
    syntheticProject(store, projectRoot);
    const worker = new BackupWorkerClient(databasePath, {}, LATEST_SCHEMA_VERSION, {
      resourceLimits: TINY_WORKER_LIMITS,
    });
    const threadIds = new Set<number>();
    const state = worker as unknown as { lifetime?: { worker: { threadId: number } } };

    try {
      expect((await worker.exportProjectData({ type: "all" })).bytes).toBeGreaterThan(0);
      threadIds.add(state.lifetime?.worker.threadId ?? -1);

      // Two requests are queued in the doomed worker: both reject, not only the one that ran out of memory.
      const failures = await Promise.allSettled([
        worker.previewProjectDataImport(oversizedImportBytes(6_000_000)),
        worker.importProjectData(oversizedImportBytes(10)),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe("rejected");
        const reason = (failure as PromiseRejectedResult).reason as BackupWorkerOutOfMemoryError;
        expect(reason).toBeInstanceOf(BackupWorkerOutOfMemoryError);
        expect(reason.code).toBe("backup_worker_out_of_memory");
        expect(reason.message).not.toContain(root);
      }

      // The test process survived, and the next request gets a fresh worker that works.
      const exported = await worker.exportProjectData({ type: "all" });
      expect(exported.bytes).toBeGreaterThan(0);
      threadIds.add(state.lifetime?.worker.threadId ?? -1);
      expect(threadIds.size).toBe(2);
      const bundle = JSON.parse(decodeProjectDataExport(exported.content)) as ProjectDataExport;
      expect((await worker.previewProjectDataImport({ bundle })).outcome).toBe("project_data_import_preview");
      assertHealthy(databasePath);
    } finally {
      await worker.close();
      store.close();
    }
  }, 60_000);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
