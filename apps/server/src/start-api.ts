import { createServer } from "node:http";
import {
  backupOptionsFromEnvironment,
  DatabaseInitializationError,
  LATEST_SCHEMA_VERSION,
  WorkIntelligenceStore,
  type WorkIntelligenceStoreOptions,
} from "@work-intelligence/storage";
import { STANDALONE } from "@work-intelligence/shared/database-location";
import { databasePath as configuredDatabasePath, storeOptions as configuredStoreOptions } from "./config.js";
import { BackupWorkerClient } from "./backup-worker-client.js";
import { revalidateBeforeCommit, type VerifiedDatabaseConfig } from "./database-preflight.js";
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
}

/**
 * Opens the database, serves the API (and the Web UI when a build is available), and shuts down on SIGINT/SIGTERM.
 * Without options it uses the environment-derived database exactly as the CLI always has.
 */
export function startApi(options: StartApiOptions = {}): void {
  let databasePath = configuredDatabasePath;
  let storeOptions: WorkIntelligenceStoreOptions = configuredStoreOptions;
  if (options.database) {
    const verified = options.database;
    const revalidation = revalidateBeforeCommit(verified.path, verified.identity);
    if (!revalidation.ok) {
      console.error(
        `Work Intelligence API 拒絕啟動：資料庫已不是先前確認的那一份（${revalidation.reason}）。${revalidation.detail}`,
      );
      process.exitCode = 1;
      return;
    }
    databasePath = verified.path;
    const backup = backupOptionsFromEnvironment(databasePath);
    storeOptions = {
      backup: verified.backupDirectory ? { ...backup, directory: verified.backupDirectory } : backup,
    };
  }

  let store: WorkIntelligenceStore;
  try {
    store = new WorkIntelligenceStore(databasePath, storeOptions);
  } catch (error) {
    console.error(error instanceof DatabaseInitializationError ? error.message : "Work Intelligence API 無法啟動。");
    process.exitCode = 1;
    return;
  }

  const port = resolveServerPort();
  const webDirectory = resolveWebDirectory();
  if (STANDALONE && !webDirectory) {
    console.error(
      "找不到 Web 介面檔案（套件內的 web/ 不完整）；只提供 API。請重新安裝，或執行 work-intelligence check。",
    );
  }
  const backupWorker =
    databasePath === ":memory:"
      ? undefined
      : new BackupWorkerClient(databasePath, storeOptions.backup, LATEST_SCHEMA_VERSION);
  const apiHandler = createApiHandler(store, {
    ...(webDirectory ? { webDirectory } : {}),
    ...(backupWorker ? { backgroundStore: backupWorker } : {}),
  });
  const server = createServer(apiHandler);

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

  function onListenError(error: Error): void {
    console.error(describeListenError(error, port));
    store.close();
    process.exitCode = 1;
  }
  server.once("error", onListenError);

  server.listen(port, "127.0.0.1", () => {
    server.off("error", onListenError);
    console.error(`Work Intelligence API listening on http://127.0.0.1:${port}`);
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
  });

  registerGracefulShutdown(
    {
      server,
      stopBackgroundWork: () => {
        clearInterval(backupTimer);
        clearTimeout(initialBackupTimer);
      },
      closeEventStreams: () => apiHandler.closeEventStreams(),
      closeBackgroundWork: () => backupWorker?.close() ?? Promise.resolve(),
      closeDatabase: () => store.close(),
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
}
