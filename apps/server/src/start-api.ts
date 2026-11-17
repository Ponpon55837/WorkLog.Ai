import { createServer } from "node:http";
import {
  backupOptionsFromEnvironment,
  DatabaseInitializationError,
  LATEST_SCHEMA_VERSION,
  WorkIntelligenceStore,
  type WorkIntelligenceStoreOptions,
} from "@work-intelligence/storage";
import { readFileIdentity, sameFileIdentity } from "@work-intelligence/shared/file-identity";
import { STANDALONE } from "@work-intelligence/shared/database-location";
import { databasePath as configuredDatabasePath, storeOptions as configuredStoreOptions } from "./config.js";
import { BackupWorkerClient } from "./backup-worker-client.js";
import { sweepTransferDirectories, transferRoot } from "./transfer-workspace.js";
import {
  readOpenedIdentity,
  revalidateBeforeCommit,
  type DatabaseIdentity,
  type RevalidationFailureReason,
  type VerifiedDatabaseConfig,
} from "./database-preflight.js";
import { describeListenError } from "./listen-error.js";
import { createApiHandler } from "./server.js";
import { resolveServerPort } from "./server-port.js";
import { registerGracefulShutdown } from "./shutdown.js";
import { resolveWebDirectory } from "./web-directory.js";

export interface StartApiOptions {
  /**
   * A database the desktop shell already verified. It is re-checked right before the store opens (the file may have been
   * swapped since the preflight) and, unlike the env-derived default, a missing file is never created.
   */
  database?: VerifiedDatabaseConfig;
  /** Port to listen on; without it the validated `WORK_INTELLIGENCE_PORT` (default 3210) as the CLI always used. */
  port?: number;
  /** The desktop shell's per-spawn secret; enables the `/api/health` instance proof (see `createApiHandler`). */
  instanceRunId?: string;
  /** Called with the UTC instant (ISO 8601) of every automatic backup that was written successfully. */
  onBackupCompleted?: (at: string) => void;
  /**
   * Called after any API request that can write or delete a backup file has succeeded (every successful non-read request).
   * It carries no data: a listener rereads the backup folder, which is the one place all backup kinds end up.
   */
  onBackupsChanged?: () => void;
}

/** What `startApi` reports once the server accepts connections. */
export interface ApiListening {
  /** The port actually bound (the requested one; the OS-chosen one if 0 was requested). */
  port: number;
  /**
   * The database identity re-read after the store opened (and migrated) it, so an empty file now has its lineage;
   * undefined for the environment-derived database.
   */
  databaseIdentity?: DatabaseIdentity;
  /** How many projects the database holds; omitted when the count could not be read (it never fails a start). */
  projectCount?: number;
}

/** The handle `startApi` returns. The CLI ignores it; the desktop child waits on it. */
export interface StartedApi {
  /** Resolves when listening; rejects with a {@link StartApiError} when the API could not start. */
  listening: Promise<ApiListening>;
  /** Graceful stop (timers, SSE, HTTP drain, worker, SQLite); resolves when SQLite is closed. Safe to call twice. */
  shutdown(): Promise<void>;
}

/** Requests that never write a backup file. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export type StartApiFailureKind = "revalidation" | "store-open" | "file-replaced" | "listen" | "setup";

/** Why the API did not start, as data the desktop child maps to a user-facing error code. */
export class StartApiError extends Error {
  readonly kind: StartApiFailureKind;
  /** Set for `revalidation`. */
  readonly revalidation?: RevalidationFailureReason;
  /** Set for `listen`: the errno code such as EADDRINUSE or EACCES. */
  readonly listenCode?: string;
  /** Set for `store-open`: the database's own diagnosis, when the storage layer gave one. */
  readonly storeError?: DatabaseInitializationError;

  constructor(
    kind: StartApiFailureKind,
    message: string,
    extra: {
      revalidation?: RevalidationFailureReason;
      listenCode?: string;
      storeError?: DatabaseInitializationError;
    } = {},
  ) {
    super(message);
    this.name = "StartApiError";
    this.kind = kind;
    if (extra.revalidation) this.revalidation = extra.revalidation;
    if (extra.listenCode) this.listenCode = extra.listenCode;
    if (extra.storeError) this.storeError = extra.storeError;
  }
}

/** True when the file now at `identity.realPath` is still the revalidated one (a file id mismatch means it was swapped). */
function stillSameFile(identity: DatabaseIdentity): boolean {
  const current = readFileIdentity(identity.realPath);
  if (!current.ok) return false;
  return (
    !identity.fileId || sameFileIdentity({ realPath: identity.realPath, fileId: identity.fileId }, current.identity)
  );
}

/** The project count as an optional field: a failing read is fail-open and leaves the field out. */
export function readProjectCount(store: Pick<WorkIntelligenceStore, "countProjects">): { projectCount?: number } {
  try {
    return { projectCount: store.countProjects() };
  } catch {
    return {};
  }
}

/** A handle for an API that never started: `listening` rejects, there is nothing to shut down. */
function failedStart(error: StartApiError): StartedApi {
  const listening = Promise.reject<ApiListening>(error);
  // The CLI never reads `listening`; mark it handled so a refusal is not also an unhandled rejection.
  listening.catch(() => undefined);
  return { listening, shutdown: () => Promise.resolve() };
}

/**
 * Opens the database, serves the API (and the Web UI when a build is available), and shuts down on SIGINT/SIGTERM.
 * Without options it uses the environment-derived database exactly as the CLI always has. The returned handle lets
 * the desktop child wait for the listener and for a complete shutdown; the CLI ignores it.
 */
export function startApi(options: StartApiOptions = {}): StartedApi {
  let databasePath = configuredDatabasePath;
  let storeOptions: WorkIntelligenceStoreOptions = configuredStoreOptions;
  let committedIdentity: DatabaseIdentity | undefined;
  if (options.database) {
    const verified = options.database;
    const revalidation = revalidateBeforeCommit(verified.path, verified.identity);
    if (!revalidation.ok) {
      console.error(
        `Work Intelligence API 拒絕啟動：資料庫已不是先前確認的那一份（${revalidation.reason}）。${revalidation.detail}`,
      );
      process.exitCode = 1;
      return failedStart(new StartApiError("revalidation", revalidation.detail, { revalidation: revalidation.reason }));
    }
    // Open the resolved file, not the possibly symlinked path, and never create it: a swap after the check must fail.
    committedIdentity = revalidation.identity;
    databasePath = committedIdentity.realPath;
    const backup = backupOptionsFromEnvironment(databasePath);
    storeOptions = {
      backup: verified.backupDirectory ? { ...backup, directory: verified.backupDirectory } : backup,
      requireExistingDatabase: true,
    };
  }

  let store: WorkIntelligenceStore;
  try {
    store = new WorkIntelligenceStore(databasePath, storeOptions);
  } catch (error) {
    console.error(error instanceof DatabaseInitializationError ? error.message : "Work Intelligence API 無法啟動。");
    process.exitCode = 1;
    return failedStart(
      new StartApiError("store-open", "the database could not be opened", {
        ...(error instanceof DatabaseInitializationError ? { storeError: error } : {}),
      }),
    );
  }
  if (committedIdentity && !stillSameFile(committedIdentity)) {
    store.close();
    console.error("Work Intelligence API 拒絕啟動：開啟時資料庫檔案已被替換（file-replaced）。");
    process.exitCode = 1;
    return failedStart(new StartApiError("file-replaced", "the database file was replaced while opening"));
  }

  // The store may have just migrated the file: report the identity as it is now, not as it was before opening.
  const openedIdentity = committedIdentity
    ? (readOpenedIdentity(committedIdentity.realPath) ?? committedIdentity)
    : undefined;

  // Each resource closes at most once, so a shutdown after a failed listen (which already closed them) is a no-op.
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  let workerClosing: Promise<void> | undefined;
  let backupWorker: BackupWorkerClient | undefined;
  const closeWorker = (): Promise<void> => (workerClosing ??= backupWorker?.close() ?? Promise.resolve());

  const port = options.port ?? resolveServerPort();
  const webDirectory = resolveWebDirectory();
  if (STANDALONE && !webDirectory) {
    console.error(
      "找不到 Web 介面檔案（套件內的 web/ 不完整）；只提供 API。請重新安裝，或執行 work-intelligence check。",
    );
  }
  // Uploads and exports a crash left behind in `<data>/tmp`; this never blocks or fails the start.
  sweepTransferDirectories(transferRoot(databasePath));
  let apiHandler: ReturnType<typeof createApiHandler>;
  let server: ReturnType<typeof createServer>;
  try {
    backupWorker =
      databasePath === ":memory:"
        ? undefined
        : new BackupWorkerClient(databasePath, storeOptions.backup, LATEST_SCHEMA_VERSION);
    apiHandler = createApiHandler(store, {
      ...(webDirectory ? { webDirectory } : {}),
      ...(backupWorker ? { backgroundStore: backupWorker } : {}),
      ...(options.instanceRunId ? { instanceRunId: options.instanceRunId } : {}),
    });
    const handler = apiHandler;
    server = createServer((request, response) => {
      if (options.onBackupsChanged && !READ_METHODS.has(request.method ?? "GET")) {
        response.once("finish", () => {
          if (response.statusCode >= 400) return;
          try {
            options.onBackupsChanged?.();
          } catch {
            // A listener that fails must not disturb the response that was already sent.
          }
        });
      }
      return handler(request, response);
    });
  } catch {
    // Whatever was opened so far is closed before the failure is reported; nothing is left holding SQLite.
    void closeWorker().catch(() => undefined);
    closeStore();
    console.error("Work Intelligence API 無法啟動：初始化服務時發生錯誤。");
    process.exitCode = 1;
    return failedStart(new StartApiError("setup", "the API could not be set up"));
  }

  // Daily automatic backup: checked once listening and hourly; a backup is written once the newest is a day old.
  const backupCheckMs = 60 * 60 * 1000;
  const initialBackupDelayMs = 60 * 1000;
  let backupTimer: NodeJS.Timeout | undefined;
  let initialBackupTimer: NodeJS.Timeout | undefined;
  function backupIfDue(): void {
    const backup = backupWorker ? backupWorker.backupIfDue() : Promise.resolve(store.backupIfDue());
    void backup
      .then((created) => {
        if (created) {
          console.error(`Database backup written: ${created.created.fileName}`);
          try {
            options.onBackupCompleted?.(created.created.createdAt);
          } catch {
            // A listener that fails must not turn a written backup into a reported failure.
          }
        }
      })
      .catch((error: unknown) => {
        console.error(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  function pruneHistory(): void {
    try {
      const pruned = store.pruneWorkSummaryUpdateHistory();
      if (pruned > 0) {
        console.error(`Work summary update history pruned: ${pruned} rows`);
      }
    } catch (error) {
      console.error(`History prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function runMaintenance(): void {
    if (process.env.WORK_INTELLIGENCE_BACKUP !== "off") {
      backupIfDue();
    }
    pruneHistory();
  }

  const listening = new Promise<ApiListening>((resolve, reject) => {
    function onListenError(error: Error): void {
      console.error(describeListenError(error, port));
      closeStore();
      void closeWorker().catch(() => undefined);
      process.exitCode = 1;
      const code = (error as NodeJS.ErrnoException).code;
      reject(new StartApiError("listen", `listen failed on port ${port}`, code ? { listenCode: code } : {}));
    }
    server.once("error", onListenError);

    server.listen(port, "127.0.0.1", () => {
      server.off("error", onListenError);
      const address = server.address();
      const boundPort = address && typeof address !== "string" ? address.port : port;
      console.error(`Work Intelligence API listening on http://127.0.0.1:${boundPort}`);
      console.error(`SQLite database: ${databasePath}`);
      backupTimer = setInterval(runMaintenance, backupCheckMs);
      backupTimer.unref();
      pruneHistory();
      if (process.env.WORK_INTELLIGENCE_BACKUP !== "off") {
        initialBackupTimer = setTimeout(() => {
          initialBackupTimer = undefined;
          backupIfDue();
        }, initialBackupDelayMs);
        initialBackupTimer.unref();
      }
      resolve({
        port: boundPort,
        ...(openedIdentity ? { databaseIdentity: openedIdentity } : {}),
        ...readProjectCount(store),
      });
    });
  });
  listening.catch(() => undefined);

  const shutdown = registerGracefulShutdown(
    {
      server,
      stopBackgroundWork: () => {
        clearInterval(backupTimer);
        clearTimeout(initialBackupTimer);
      },
      closeEventStreams: () => apiHandler.closeEventStreams(),
      closeBackgroundWork: () => closeWorker(),
      closeDatabase: closeStore,
      onBackgroundWorkCloseError: (error) => {
        console.error(
          `Work Intelligence background worker could not close cleanly: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      },
      onDatabaseCloseError: () => {
        console.error("Work Intelligence API could not close the database cleanly.");
        process.exitCode = 1;
      },
    },
    process,
  );
  return { listening, shutdown };
}
