import type { DbProbeStatus } from "../db-source/types.js";
import { buildAppShellState, tabForOperation, type AppShellState, type AppTab } from "./app-tabs.js";
import type { OperationKind, RecoveryNotice } from "../operations/journal-record.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { ShellLocale } from "./i18n.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";
import type { StorageRiskView } from "./storage-risk-view.js";
import type { RepairUpdateSection } from "../update-check/result.js";
import type { RepairLoginItemSection } from "./login-item-status.js";
import type { RepairLanguageSection } from "./language-i18n.js";
import type { RepairBackupDirectorySection } from "./backup-directory.js";
import type { RepairMaintenanceSection } from "./maintenance-types.js";
import type { StartupFallbackNote } from "./startup-fallback.js";
import { canDisableLegacyService } from "../legacy-service/disable.js";
import { systemSettingsField, type SystemSettingsTarget } from "../legacy-service/system-settings.js";
import type { LegacyServiceDetection } from "../legacy-service/types.js";

export type BackendRunState = "running" | "starting" | "stopped" | "crashed";

export type RepairDatabaseStatus = DbProbeStatus | "unknown" | "needs-migration";

export type RepairActionId =
  | "retry-start"
  | "approve-migration"
  | "choose-database"
  | "open-database-folder"
  | "open-backups-folder"
  | "open-logs-folder"
  | "export-diagnostics"
  | "start-anyway";

export interface RepairAction {
  readonly id: RepairActionId;
  readonly enabled: boolean;
}

export interface RepairCandidateView {
  readonly id: string;
  readonly display: string;
  readonly status: DbProbeStatus | "unknown";
  readonly errorCode?: string;
  readonly canConfirm: boolean;
  readonly needsMigration: boolean;
  readonly storageRisk?: StorageRiskView;
}

export interface RepairRecoveryNotice {
  readonly id: string;
  readonly kind: RecoveryNotice["kind"];
  readonly operation: OperationKind;
  readonly port: number | null;
  readonly attemptedPort: number | null;
  readonly tab: AppTab;
}

export interface RepairState {
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly database: {
    readonly display: string | null;
    readonly status: RepairDatabaseStatus;
    readonly storageRisk?: StorageRiskView;
  };
  readonly candidates: readonly RepairCandidateView[];
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly actions: readonly RepairAction[];
  readonly retryOperationId: string;
  readonly recovered: RepairRecovered | null;
  readonly recoveryNotices: readonly RepairRecoveryNotice[];
  readonly port: RepairPortSection | null;
  readonly update?: RepairUpdateSection;
  readonly loginItem?: RepairLoginItemSection;
  readonly language?: RepairLanguageSection;
  readonly maintenance?: RepairMaintenanceSection;
  readonly backupDirectory?: RepairBackupDirectorySection;
  readonly fallback?: StartupFallbackNote;
  readonly shell: AppShellState;
  readonly legacyService: {
    readonly running: "running" | "stopped" | "unknown";
    readonly blocked: boolean;
    readonly portInUse: boolean;
    readonly canDisable: boolean;
    readonly systemSettings?: SystemSettingsTarget;
  } | null;
}

export interface RepairPortSection {
  readonly port: number | null;
  readonly activePort: number | null;
  readonly focus: boolean;
  readonly handoffHeld: boolean;
}

export interface RepairRecovered {
  readonly projectCount?: number;
}

export interface RepairStateInputs {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly databasePath: string | null;
  readonly databaseStatus: RepairDatabaseStatus;
  readonly databaseStorageRisk?: StorageRiskView;
  readonly databaseMigrationBlocked?: boolean;
  readonly candidates: readonly {
    readonly id: string;
    readonly path: string;
    readonly status: DbProbeStatus | "unknown";
    readonly needsMigration?: boolean;
    readonly errorCode?: string;
    readonly canConfirm?: boolean;
    readonly storageRisk?: StorageRiskView;
  }[];
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly retryOperationId: string;
  readonly recovered?: RepairRecovered | null;
  readonly recoveryNotices?: readonly { readonly id: string; readonly notice: RecoveryNotice }[];
  readonly port?: RepairPortSection | null;
  readonly update?: RepairUpdateSection;
  readonly loginItem?: RepairLoginItemSection;
  readonly language?: RepairLanguageSection;
  readonly maintenance?: RepairMaintenanceSection;
  readonly backupDirectory?: RepairBackupDirectorySection;
  readonly fallback?: StartupFallbackNote | null;
  readonly legacyService?: LegacyServiceDetection | null;
  readonly legacyBlocked?: boolean;
  readonly legacyPortInUse?: boolean;
  readonly busy: boolean;
  readonly needsSetup?: boolean;
  readonly legacyHeld?: boolean;
  readonly operation?: OperationKind | null;
}

export function databaseStatusFor(running: boolean, latestErrorCode: string | undefined): RepairDatabaseStatus {
  if (running) return "ok";
  if (latestErrorCode === "DB_MISSING") return "missing";
  if (latestErrorCode === "DB_OFFLINE") return "offline";
  if (latestErrorCode === "DB_PERMISSION") return "denied";
  if (latestErrorCode === "SCHEMA_MIGRATION_BLOCKED") return "needs-migration";
  if (latestErrorCode?.startsWith("SCHEMA_")) return "unsupported-schema";
  return "unknown";
}

function normalize(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase().replaceAll("\\", "/") : value;
}

export function displayPath(path: string, homeDirectory: string, platform: NodeJS.Platform): string {
  const home = homeDirectory.replace(/[\\/]+$/, "");
  if (home.length < 2) return path;
  const lead = normalize(path, platform);
  const homeKey = normalize(home, platform);
  if (lead === homeKey) return "~";
  if (lead.startsWith(`${homeKey}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export function buildRepairState(inputs: RepairStateInputs): RepairState {
  const show = (path: string): string => displayPath(path, inputs.homeDirectory, inputs.platform);
  const idle = !inputs.busy;
  const canRetry = idle && !(inputs.owner === "MANAGED" && inputs.backend === "running");
  const offersMigration =
    inputs.databasePath !== null &&
    inputs.databaseStatus === "needs-migration" &&
    inputs.databaseMigrationBlocked !== true;
  return {
    locale: inputs.locale,
    owner: inputs.owner,
    backend: inputs.backend,
    database: {
      display: inputs.databasePath === null ? null : show(inputs.databasePath),
      status: inputs.databaseStatus,
      ...(inputs.databaseStorageRisk ? { storageRisk: inputs.databaseStorageRisk } : {}),
    },
    candidates: inputs.candidates.map((candidate) => ({
      id: candidate.id,
      display: show(candidate.path),
      status: candidate.status,
      canConfirm: candidate.canConfirm ?? candidate.status === "ok",
      needsMigration: candidate.needsMigration === true,
      ...(candidate.storageRisk ? { storageRisk: candidate.storageRisk } : {}),
      ...(candidate.errorCode ? { errorCode: candidate.errorCode } : {}),
    })),
    recentErrors: inputs.recentErrors,
    lastBackup: inputs.lastBackup,
    retryOperationId: inputs.retryOperationId,
    recovered: inputs.recovered ?? null,
    recoveryNotices: (inputs.recoveryNotices ?? []).map(({ id, notice }) => ({
      id,
      kind: notice.kind,
      operation: notice.operation,
      port: notice.port,
      attemptedPort: notice.attemptedPort,
      tab: tabForOperation(notice.operation, false),
    })),
    port: inputs.port ?? null,
    ...(inputs.update ? { update: inputs.update } : {}),
    ...(inputs.loginItem ? { loginItem: inputs.loginItem } : {}),
    ...(inputs.language ? { language: inputs.language } : {}),
    ...(inputs.maintenance ? { maintenance: inputs.maintenance } : {}),
    ...(inputs.backupDirectory ? { backupDirectory: inputs.backupDirectory } : {}),
    ...(inputs.fallback ? { fallback: inputs.fallback } : {}),
    shell: buildAppShellState({
      needsSetup: inputs.needsSetup === true,
      owner: inputs.owner,
      legacyHeld: inputs.legacyHeld === true || inputs.legacyBlocked === true,
      operation: inputs.operation ?? null,
    }),
    legacyService:
      inputs.legacyService?.kind === "found"
        ? {
            running: inputs.legacyService.running,
            blocked: inputs.legacyBlocked === true,
            portInUse: inputs.legacyPortInUse === true,
            canDisable: canDisableLegacyService(inputs.legacyService),
            ...systemSettingsField(inputs.legacyService.platform),
          }
        : null,
    actions: [
      ...(offersMigration ? [{ id: "approve-migration" as const, enabled: idle }] : []),
      { id: "retry-start", enabled: canRetry },
      { id: "choose-database", enabled: idle },
      { id: "open-database-folder", enabled: inputs.databasePath !== null },
      { id: "open-backups-folder", enabled: true },
      { id: "open-logs-folder", enabled: true },
      { id: "export-diagnostics", enabled: true },
      ...(inputs.legacyBlocked ? [{ id: "start-anyway" as const, enabled: idle }] : []),
    ],
  };
}
