import type { DbProbeStatus } from "../db-source/types.js";
import { buildAppShellState, tabForOperation, type AppShellState, type AppTab } from "./app-tabs.js";
import type { OperationKind, RecoveryNotice } from "../operations/journal-record.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { ShellLocale } from "./i18n.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";
import type { StorageRiskView } from "./storage-risk-view.js";
import type { RepairUpdateSection } from "../update-check/result.js";
import { canDisableLegacyService } from "../legacy-service/disable.js";
import { systemSettingsField, type SystemSettingsTarget } from "../legacy-service/system-settings.js";
import type { LegacyServiceDetection } from "../legacy-service/types.js";

export type BackendRunState = "running" | "starting" | "stopped" | "crashed";

/** What the repair window may ask main to do; the buttons the page shows come from this list. */
export type RepairActionId =
  | "retry-start"
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
  /** Opaque id main handed out; the only thing the page may send back to confirm. */
  readonly id: string;
  /** Path with the home directory shown as `~`. */
  readonly display: string;
  readonly status: DbProbeStatus | "unknown";
  /** The preview could not run; the page shows the message of this backend error code. */
  readonly errorCode?: string;
  /** Confirming opens it (its preview said `ok`). */
  readonly canConfirm: boolean;
  /** Confirming also updates its schema; the page asks the user for explicit consent first. */
  readonly needsMigration: boolean;
  /** The file is on risky storage (DT-08): the reason, the consent checkbox and the copy button follow from it. */
  readonly storageRisk?: StorageRiskView;
}

/**
 * What start-up recovery found an interrupted operation left in, as the Status tab's banner shows it: the page words it
 * from `kind` and the ports, and offers `tab` as the place to act. Dismissing it (`recoveryAcknowledge`) is persisted.
 */
export interface RepairRecoveryNotice {
  /** The interrupted operation's id: what the page sends back to dismiss it. */
  readonly id: string;
  readonly kind: RecoveryNotice["kind"];
  readonly operation: OperationKind;
  /** The port in use (port notices). */
  readonly port: number | null;
  /** The port the interrupted change was moving to (port notices). */
  readonly attemptedPort: number | null;
  /** The tab where the user can act on it. */
  readonly tab: AppTab;
}

/** The snapshot the repair page renders. It holds no real path: those stay in main. */
export interface RepairState {
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly database: {
    readonly display: string | null;
    readonly status: DbProbeStatus | "unknown";
    /** The App's own database is on risky storage and its schema update was refused: the copy button is offered (DT-08). */
    readonly storageRisk?: StorageRiskView;
  };
  readonly candidates: readonly RepairCandidateView[];
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly actions: readonly RepairAction[];
  /** Id of the retry operation main will accept next (a fresh uuid per snapshot). */
  readonly retryOperationId: string;
  /** Set only while the success card shows, right after a repair the user started worked. */
  readonly recovered: RepairRecovered | null;
  /** Notices about operations a crash interrupted, newest first, until the user dismisses each. */
  readonly recoveryNotices: readonly RepairRecoveryNotice[];
  /** The 「連接埠」 section (null before the App has settings). */
  readonly port: RepairPortSection | null;
  /** The 「更新」 card: the running version, and the check's progress and last answer (kept in main). Absent: no card. */
  readonly update?: RepairUpdateSection;
  /** What the tab strip needs: the tab list, the blocking tab and one badge per tab (see repair-ipc.ts). */
  readonly shell: AppShellState;
  /**
   * The old login service is installed and may serve this database. `blocked`: the App did not start
   * its backend because of it; only "仍要啟動" (the `start-anyway` action) starts it.
   */
  readonly legacyService: {
    readonly running: "running" | "stopped" | "unknown";
    readonly blocked: boolean;
    /** The backend could not bind its port, and the old service listens on that port: the page names it. */
    readonly portInUse: boolean;
    /** 「停用舊的登入服務」 is offered: the definition is the one `service:install` writes, for a known checkout. */
    readonly canDisable: boolean;
    /** Where the App opens for the user to turn the service off by hand; absent where it has no such place. */
    readonly systemSettings?: SystemSettingsTarget;
  } | null;
}

/** The 「連接埠」 section: always shown, so a port that cannot start can still be changed from here. */
export interface RepairPortSection {
  /** The port the settings name (what the next start uses). */
  readonly port: number | null;
  /** The port the running backend serves, when one runs. */
  readonly activePort: number | null;
  /**
   * Main asked for the section to be shown (the tray item, the Dashboard's link) and no page has been told yet: true in
   * exactly one state, so a later load of the page does not scroll to it again.
   */
  readonly focus: boolean;
  /** The Dashboard's preferences wait in memory to be carried over. */
  readonly handoffHeld: boolean;
}

export interface RepairRecovered {
  /** Projects in the database, when the backend reported it; the page hides the count without it. */
  readonly projectCount?: number;
}

export interface RepairStateInputs {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly databasePath: string | null;
  readonly databaseStatus: DbProbeStatus | "unknown";
  /** How the App's own database is shown when its storage is risky (DT-08). */
  readonly databaseStorageRisk?: StorageRiskView;
  readonly candidates: readonly {
    readonly id: string;
    readonly path: string;
    readonly status: DbProbeStatus | "unknown";
    readonly needsMigration?: boolean;
    readonly errorCode?: string;
    /** Confirming is allowed (an `ok` preview that carries an identity). Defaults to `status === "ok"`. */
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
  /** What the start-up check found, when it found the old login service on this database. */
  readonly legacyService?: LegacyServiceDetection | null;
  /** The App held its backend back because of that service. */
  readonly legacyBlocked?: boolean;
  /** The last start found the port taken, and the old service is on that port. */
  readonly legacyPortInUse?: boolean;
  /** A retry or another operation is running: actions are disabled until it ends. */
  readonly busy: boolean;
  /** No settings file yet: the Setup tab exists. Defaults to false. */
  readonly needsSetup?: boolean;
  /** A login start was held back by the old login service (besides `legacyBlocked`). Defaults to false. */
  readonly legacyHeld?: boolean;
  /** The kind of the operation the coordinator runs right now (its busy badge goes on the tab it belongs to). */
  readonly operation?: OperationKind | null;
}

/** The database status the page shows: a running backend proves `ok`; otherwise the latest error code says what was found. */
export function databaseStatusFor(running: boolean, latestErrorCode: string | undefined): DbProbeStatus | "unknown" {
  if (running) return "ok";
  if (latestErrorCode === "DB_MISSING") return "missing";
  if (latestErrorCode === "DB_OFFLINE") return "offline";
  if (latestErrorCode === "DB_PERMISSION") return "denied";
  if (latestErrorCode?.startsWith("SCHEMA_")) return "unsupported-schema";
  return "unknown";
}

function normalize(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase().replaceAll("\\", "/") : value;
}

/** Shows `path` with the home directory replaced by `~` (case-insensitive and either slash on Windows). */
export function displayPath(path: string, homeDirectory: string, platform: NodeJS.Platform): string {
  const home = homeDirectory.replace(/[\\/]+$/, "");
  if (home.length < 2) return path;
  const lead = normalize(path, platform);
  const homeKey = normalize(home, platform);
  if (lead === homeKey) return "~";
  if (lead.startsWith(`${homeKey}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** Builds the page's snapshot; paths are masked here so the renderer never receives a real one. */
export function buildRepairState(inputs: RepairStateInputs): RepairState {
  const show = (path: string): string => displayPath(path, inputs.homeDirectory, inputs.platform);
  const idle = !inputs.busy;
  const canRetry = idle && !(inputs.owner === "MANAGED" && inputs.backend === "running");
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
