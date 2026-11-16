import { mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { app } from "electron";
import {
  buildDiagnostics,
  buildRepairState,
  databaseStatusFor,
  type BackendSupervisor,
  type LastBackupTracker,
  type RepairFolderTarget,
  type RepairState,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { ShellState } from "./state.js";

export interface RepairInfo {
  /** What the repair page renders: no real path in it. */
  snapshot(): Promise<RepairState>;
  /** The redacted text the user may export. */
  diagnosticsText(): Promise<string>;
  /** The folder a button opens (created when missing), or null when there is none to open. */
  folderFor(target: RepairFolderTarget): Promise<string | null>;
  databaseStatus(): RepairState["database"]["status"];
}

export interface RepairInfoOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly lastBackup: LastBackupTracker;
}

export function createRepairInfo(options: RepairInfoOptions): RepairInfo {
  const { state, paths, supervisor, lastBackup } = options;

  function databaseStatus(): RepairState["database"]["status"] {
    return databaseStatusFor(supervisor.running !== undefined, state.recentErrors.latest()?.code);
  }

  async function snapshot(): Promise<RepairState> {
    return buildRepairState({
      platform: process.platform,
      homeDirectory: homedir(),
      locale: state.locale,
      owner: state.owner,
      backend: supervisor.running ? "running" : state.backend,
      databasePath: state.databasePath(),
      databaseStatus: databaseStatus(),
      candidates: state.candidates.list().map((entry) => ({
        id: entry.id,
        path: entry.path,
        status: entry.preview?.status ?? ("unknown" as const),
        needsMigration: entry.preview?.needsMigration ?? false,
        ...(entry.preview?.errorCode ? { errorCode: entry.preview.errorCode } : {}),
        canConfirm: state.candidates.checkConfirm(entry.id, true).ok,
      })),
      recentErrors: state.recentErrors.list(),
      lastBackup: await lastBackup.current(),
      // The same id while the page polls; it is replaced only when it is used or the state changes.
      retryOperationId: state.retryIds.current(),
      busy: state.busy,
    });
  }

  async function diagnosticsText(): Promise<string> {
    const running = supervisor.running;
    return buildDiagnostics({
      platform: process.platform,
      homeDirectory: homedir(),
      userName: userInfo().username,
      paths: [
        state.databasePath() ?? undefined,
        state.backupDirectory() ?? undefined,
        paths.dataDirectory,
        paths.runtimeRoot,
      ],
      secrets: [running?.runId],
      appVersion: app.getVersion(),
      arch: process.arch,
      locale: app.getLocale(),
      owner: state.owner,
      backend: running ? "running" : state.backend,
      databaseStatus: databaseStatus(),
      recentErrors: state.recentErrors.list(),
      lastBackup: await lastBackup.current(),
      recentOutput: supervisor.recentOutput,
      generatedAt: new Date(),
    });
  }

  async function folderFor(target: RepairFolderTarget): Promise<string | null> {
    if (target === "logs") return paths.logsDirectory;
    const database = state.databasePath();
    const directory = target === "database" ? (database ? dirname(database) : null) : state.backupDirectory();
    if (directory) await mkdir(directory, { recursive: true }).catch(() => undefined);
    return directory;
  }

  return { snapshot, diagnosticsText, folderFor, databaseStatus };
}
