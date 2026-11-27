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
  type RepairLanguageSection,
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
  snapshot(): Promise<RepairState>;
  diagnosticsPreview(): Promise<BuiltDiagnostics>;
  folderFor(target: RepairFolderTarget): Promise<string | null>;
  databaseStatus(): RepairState["database"]["status"];
  tabInputs(): AppTabInputs;
}

export interface RepairInfoOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly lastBackup: LastBackupTracker;
  readonly legacy: LegacyGuard;
  readonly coordinator?: Pick<OperationCoordinator, "current">;
  readonly journal: Pick<OperationJournal, "pendingNotices">;
  readonly storage: StorageRiskService;
  readonly port?: () => RepairPortSection;
  readonly update?: () => RepairUpdateSection;
  readonly loginItem?: () => RepairLoginItemSection;
  readonly language?: () => RepairLanguageSection;
  readonly backupDirectory?: () => RepairBackupDirectorySection | undefined;
  readonly maintenance?: () => RepairMaintenanceSection;
}

export function createRepairInfo(options: RepairInfoOptions): RepairInfo {
  const { state, paths, supervisor, lastBackup, legacy, storage } = options;

  function databaseStatus(): RepairState["database"]["status"] {
    return databaseStatusFor(supervisor.running !== undefined, state.recentErrors.latest()?.code);
  }

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
          canConfirm: state.candidates.checkConfirm(entry.id, true, true).ok,
          ...(storageRisk ? { storageRisk } : {}),
        };
      }),
      recentErrors: state.recentErrors.list(),
      lastBackup: await lastBackup.current(),
      retryOperationId: state.retryIds.current(),
      busy: state.busy,
      recovered: state.recovered,
      recoveryNotices: pending.flatMap((record) =>
        record.recoveryNotice ? [{ id: record.operationId, notice: record.recoveryNotice }] : [],
      ),
      ...(options.port ? { port: options.port() } : {}),
      ...(options.update ? { update: options.update() } : {}),
      ...(options.loginItem ? { loginItem: options.loginItem() } : {}),
      ...(options.language ? { language: options.language() } : {}),
      ...(options.maintenance ? { maintenance: options.maintenance() } : {}),
      ...(options.backupDirectory?.() ? { backupDirectory: options.backupDirectory() } : {}),
      fallback: state.startupFallback,
      legacyService: relevance.conflict || relevance.portInUse ? legacy.latest() : null,
      legacyBlocked: !running && latestCode === "LEGACY_SERVICE_ACTIVE",
      legacyPortInUse: relevance.portInUse,
      needsSetup: state.needsSetup,
      legacyHeld: legacyHeld(),
      operation: options.coordinator?.current()?.kind ?? null,
    });
  }

  function mcpLeaseInput(): { mcpLease: ReturnType<typeof readMcpLeaseInput> } | Record<string, never> {
    try {
      return { mcpLease: readMcpLeaseInput(paths.runtimeRoot, configDirectory()) };
    } catch {
      return {};
    }
  }

  async function diagnosticsPreview(): Promise<BuiltDiagnostics> {
    const running = supervisor.running;
    const database = state.databasePath();
    // A database reached through a link or mapped drive shows up under its real path in error text.
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
      locale: state.locale,
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
