import type { DbProbeStatus } from "../db-source/types.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { ShellLocale } from "./i18n.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";

export type BackendRunState = "running" | "starting" | "stopped" | "crashed";

/** What the repair window may ask main to do; the buttons the page shows come from this list. */
export type RepairActionId =
  | "retry-start"
  | "choose-database"
  | "open-database-folder"
  | "open-backups-folder"
  | "open-logs-folder"
  | "export-diagnostics";

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
}

/** The snapshot the repair page renders. It holds no real path: those stay in main. */
export interface RepairState {
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly database: { readonly display: string | null; readonly status: DbProbeStatus | "unknown" };
  readonly candidates: readonly RepairCandidateView[];
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly actions: readonly RepairAction[];
  /** Id of the retry operation main will accept next (a fresh uuid per snapshot). */
  readonly retryOperationId: string;
}

export interface RepairStateInputs {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly locale: ShellLocale;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly databasePath: string | null;
  readonly databaseStatus: DbProbeStatus | "unknown";
  readonly candidates: readonly {
    readonly id: string;
    readonly path: string;
    readonly status: DbProbeStatus | "unknown";
    readonly needsMigration?: boolean;
    readonly errorCode?: string;
    /** Confirming is allowed (an `ok` preview that carries an identity). Defaults to `status === "ok"`. */
    readonly canConfirm?: boolean;
  }[];
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly retryOperationId: string;
  /** A retry or another operation is running: actions are disabled until it ends. */
  readonly busy: boolean;
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
    },
    candidates: inputs.candidates.map((candidate) => ({
      id: candidate.id,
      display: show(candidate.path),
      status: candidate.status,
      canConfirm: candidate.canConfirm ?? candidate.status === "ok",
      needsMigration: candidate.needsMigration === true,
      ...(candidate.errorCode ? { errorCode: candidate.errorCode } : {}),
    })),
    recentErrors: inputs.recentErrors,
    lastBackup: inputs.lastBackup,
    retryOperationId: inputs.retryOperationId,
    actions: [
      { id: "retry-start", enabled: canRetry },
      { id: "choose-database", enabled: idle },
      { id: "open-database-folder", enabled: inputs.databasePath !== null },
      { id: "open-backups-folder", enabled: true },
      { id: "open-logs-folder", enabled: true },
      { id: "export-diagnostics", enabled: true },
    ],
  };
}
