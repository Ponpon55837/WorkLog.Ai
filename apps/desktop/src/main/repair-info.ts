import { mkdir, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { app } from "electron";
import { configDirectory } from "@work-intelligence/shared/database-location";
import {
  buildDiagnostics,
  buildRepairState,
  buildStorageRiskView,
  databaseStatusFor,
  legacyServiceRelevance,
  readMcpLeaseInput,
  storagePolicy,
  type AppTabInputs,
  type BackendSupervisor,
  type BuiltDiagnostics,
  type OperationCoordinator,
  type OperationJournal,
  type RepairPortSection,
  type RepairLoginItemSection,
  type RepairBackupDirectorySection,
  type RepairMaintenanceSection,
  type RepairUpdateSection,
  type LastBackupTracker,
  type RepairFolderTarget,
  type RepairState,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { LegacyGuard } from "./legacy.js";
import type { StorageRiskService } from "./storage-risk.js";
import type { ShellState } from "./state.js";

export interface RepairInfo {
  /** What the repair page renders: no real path in it. */
  snapshot(): Promise<RepairState>;
  /** The redacted text the user may export, and what was masked; nothing is written. Throws `DiagnosticsError` when the last check refuses it. */
  diagnosticsPreview(): Promise<BuiltDiagnostics>;
  /** The folder a button opens (created when missing), or null when there is none to open. */
  folderFor(target: RepairFolderTarget): Promise<string | null>;
  databaseStatus(): RepairState["database"]["status"];
  /** What decides the window's tab list and its blocking tab right now. */
  tabInputs(): AppTabInputs;
}

export interface RepairInfoOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly lastBackup: LastBackupTracker;
  readonly legacy: LegacyGuard;
  /** Its running operation (if any) puts a busy mark on the tab it belongs to. */
  readonly coordinator?: Pick<OperationCoordinator, "current">;
  /** Where the recovery notices of interrupted operations are kept (the Status tab's banner). */
  readonly journal: Pick<OperationJournal, "pendingNotices">;
  /** The storage verdicts this run reached (DT-08). */
  readonly storage: StorageRiskService;
  /** What the 「連接埠」 section shows. */
  readonly port?: () => RepairPortSection;
  /** What the 「更新」 card shows. */
  readonly update?: () => RepairUpdateSection;
  /** What the 「登入時自動啟動」 switch shows. */
  readonly loginItem?: () => RepairLoginItemSection;
  /** What the 「備份位置」 card shows. */
  readonly backupDirectory?: () => RepairBackupDirectorySection | undefined;
  /** What the 「整理資料庫」 card shows. */
  readonly maintenance?: () => RepairMaintenanceSection;
}

export function createRepairInfo(options: RepairInfoOptions): RepairInfo {
  const { state, paths, supervisor, lastBackup, legacy, storage } = options;

  function databaseStatus(): RepairState["database"]["status"] {
    return databaseStatusFor(supervisor.running !== undefined, state.recentErrors.latest()?.code);
  }

  /** The old login service holds the database: a login start was held back, or the last start was refused for it. */
  function legacyHeld(): boolean {
    return (
      legacy.heldAtLogin() ||
      (supervisor.running === undefined && state.recentErrors.latest()?.code === "LEGACY_SERVICE_ACTIVE")
    );
  }

  function tabInputs(): AppTabInputs {
    return { needsSetup: state.needsSetup, owner: state.owner, legacyHeld: legacyHeld() };
  }

  async function snapshot(): Promise<RepairState> {
    const latestCode = state.recentErrors.latest()?.code;
    const relevance = legacyServiceRelevance({
      detection: legacy.latest(),
      databasePath: state.databasePath(),
      port: state.settings?.desired.port ?? null,
      latestErrorCode: latestCode,
      platform: process.platform,
    });
    const running = supervisor.running !== undefined;
    const ownPath = state.databasePath();
    const ownStorage = ownPath === null ? undefined : storage.last(ownPath)?.risk;
    const ownRisk =
      ownPath === null
        ? undefined
        : buildStorageRiskView({
            risk: ownStorage,
            locale: state.locale,
            chosenByUser: true,
            needsMigration: latestCode === "SCHEMA_MIGRATION_BLOCKED",
          });
    // Served from the journal's in-memory copy; an unreadable journal simply shows no banner.
    const pending = await options.journal.pendingNotices().catch(() => []);
    return buildRepairState({
      platform: process.platform,
      homeDirectory: homedir(),
      locale: state.locale,
      owner: state.owner,
      backend: supervisor.running ? "running" : state.backend,
      databasePath: state.databasePath(),
      databaseStatus: databaseStatus(),
      ...(ownRisk ? { databaseStorageRisk: ownRisk } : {}),
      // An update the storage refuses is not offered in place; the storage note offers the copy instead (DT-08).
      databaseMigrationBlocked: storagePolicy(ownStorage).migrationBlocked,
      candidates: state.candidates.list().map((entry) => {
        const needsMigration = entry.preview?.needsMigration ?? false;
        const storageRisk = buildStorageRiskView({
          risk: entry.storageRisk,
          locale: state.locale,
          chosenByUser: true,
          needsMigration,
        });
        return {
          id: entry.id,
          path: entry.path,
          status: entry.preview?.status ?? ("unknown" as const),
          needsMigration,
          ...(entry.preview?.errorCode ? { errorCode: entry.preview.errorCode } : {}),
          // The consent boxes are the page's to ask for: this says whether confirming can ever work for the file.
          canConfirm: state.candidates.checkConfirm(entry.id, true, true).ok,
          ...(storageRisk ? { storageRisk } : {}),
        };
      }),
      recentErrors: state.recentErrors.list(),
      lastBackup: await lastBackup.current(),
      // The same id while the page polls; it is replaced only when it is used or the state changes.
      retryOperationId: state.retryIds.current(),
      busy: state.busy,
      recovered: state.recovered,
      recoveryNotices: pending.flatMap((record) =>
        record.recoveryNotice ? [{ id: record.operationId, notice: record.recoveryNotice }] : [],
      ),
      ...(options.port ? { port: options.port() } : {}),
      ...(options.update ? { update: options.update() } : {}),
      ...(options.loginItem ? { loginItem: options.loginItem() } : {}),
      ...(options.maintenance ? { maintenance: options.maintenance() } : {}),
      ...(options.backupDirectory?.() ? { backupDirectory: options.backupDirectory() } : {}),
      fallback: state.startupFallback,
      // Shown only where it matters: the old service may serve this database, or it holds the port.
      legacyService: relevance.conflict || relevance.portInUse ? legacy.latest() : null,
      legacyBlocked: !running && latestCode === "LEGACY_SERVICE_ACTIVE",
      legacyPortInUse: relevance.portInUse,
      needsSetup: state.needsSetup,
      legacyHeld: legacyHeld(),
      operation: options.coordinator?.current()?.kind ?? null,
    });
  }

  /** The lease facts for the summary; left out when the registry or the observation file cannot be read at all. */
  function mcpLeaseInput(): { mcpLease: ReturnType<typeof readMcpLeaseInput> } | Record<string, never> {
    try {
      return { mcpLease: readMcpLeaseInput(paths.runtimeRoot, configDirectory()) };
    } catch {
      return {};
    }
  }

  async function diagnosticsPreview(): Promise<BuiltDiagnostics> {
    const running = supervisor.running;
    // A database reached through a link or a mapped drive shows up under its real path in an error text (L-01).
    const database = state.databasePath();
    const realDatabase = database ? await realpath(database).catch(() => undefined) : undefined;
    return buildDiagnostics({
      platform: process.platform,
      homeDirectory: homedir(),
      userName: userInfo().username,
      paths: [
        database ?? undefined,
        realDatabase,
        state.backupDirectory() ?? undefined,
        paths.dataDirectory,
        paths.logsDirectory,
        paths.runtimeRoot,
      ],
      secrets: [running?.runId],
      appVersion: app.getVersion(),
      ...(state.settings ? { installId: state.settings.installId } : {}),
      arch: process.arch,
      locale: app.getLocale(),
      owner: state.owner,
      backend: running ? "running" : state.backend,
      databaseStatus: databaseStatus(),
      recentErrors: state.recentErrors.list(),
      lastBackup: await lastBackup.current(),
      recentOutput: supervisor.recentOutput,
      generatedAt: new Date(),
      ...mcpLeaseInput(),
    });
  }

  async function folderFor(target: RepairFolderTarget): Promise<string | null> {
    if (target === "logs") return paths.logsDirectory;
    const database = state.databasePath();
    const directory = target === "database" ? (database ? dirname(database) : null) : state.backupDirectory();
    if (directory) await mkdir(directory, { recursive: true }).catch(() => undefined);
    return directory;
  }

  return { snapshot, diagnosticsPreview, folderFor, databaseStatus, tabInputs };
}
