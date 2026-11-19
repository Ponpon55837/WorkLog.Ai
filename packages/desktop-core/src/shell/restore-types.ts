import type { OperationKind } from "../operations/journal-record.js";

/**
 * The contract of 「從備份還原」 between the App window and main. The page never sends or receives a path: `list` and `pick`
 * answer with opaque one-time ids (`backupId`) that main keeps in memory, and `run` sends one back (see
 * restore-backup-store.ts). Types only: the window imports this file for checking and it leaves nothing in its bundle.
 */

/** Why a file cannot be restored from; known at list or pick time, before anything is touched. */
export const BACKUP_PROBLEMS = ["newer-schema", "not-database", "corrupt", "unreadable", "missing"] as const;
export type BackupProblem = (typeof BACKUP_PROBLEMS)[number];

export type RestoreBackupLabel =
  "automatic" | "manual" | "migration" | "deletion" | "session_deletion" | "maintenance" | "import" | "picked";

/** One backup as the page shows it. Without `backupId` it cannot be restored (see `problem`). */
export interface RestoreBackupView {
  /** Present only for a backup that can be restored; one-time, bound to this window, expires. */
  readonly backupId?: string;
  readonly label: RestoreBackupLabel;
  /** The file's own name, never a folder. */
  readonly fileName: string;
  /** When the backup was made (ISO), or null when unknown. */
  readonly createdAt: string | null;
  readonly bytes: number;
  readonly schemaVersion: number | null;
  readonly projects: number | null;
  readonly sessions: number | null;
  readonly problem: BackupProblem | null;
}

export type RestoreListResult =
  | {
      readonly ok: true;
      readonly backups: readonly RestoreBackupView[];
      /** The backup folder could not be read at all (as opposed to being empty). */
      readonly directoryReadable: boolean;
      /** An Agent (MCP) connection looks alive: the page says so before the user starts a restore. */
      readonly agentsRunning: boolean;
      /** The App has no database path yet (first run not finished): there is nothing to restore into. */
      readonly noDatabase: boolean;
    }
  | { readonly ok: false; readonly reason: "failed" | "invalid" };

export type RestorePickResult =
  | { readonly ok: true; readonly backup: RestoreBackupView }
  | {
      readonly ok: false;
      readonly reason: "cancelled" | "invalid" | "failed" | BackupProblem;
      /** `newer-schema`: the version the file uses. */
      readonly schemaVersion?: number;
    };

/** What holds a restore back when another thing runs. */
export type RestoreBusyDetail =
  | { readonly source: "operation"; readonly operation: OperationKind }
  | { readonly source: "activity"; readonly activities: readonly string[] }
  | { readonly source: "page-action" }
  | { readonly source: "unknown" };

export const RESTORE_FAILURE_REASONS = [
  "expired",
  "cancelled",
  "busy",
  "agents-running",
  "locked",
  "no-space",
  "newer-schema",
  "not-database",
  "corrupt",
  "verify-failed",
  "missing",
  "same-file",
  "no-database",
  "start-failed",
  "outcome-unknown",
  "failed",
  "invalid",
] as const;
export type RestoreFailureReason = (typeof RESTORE_FAILURE_REASONS)[number];

export type RestoreRunResult =
  | {
      readonly ok: true;
      /** File name of the backup made of the replaced data, when there was a database. */
      readonly safetyBackup?: string;
      readonly projects: number;
      readonly sessions: number;
      /** How many project folders now point at a new place on this computer; absent when none were moved. */
      readonly remapped?: number;
    }
  | {
      readonly ok: false;
      readonly reason: RestoreFailureReason;
      readonly busy?: RestoreBusyDetail;
      /**
       * True when the database that was in use is exactly as it was before the restore began. False for `start-failed` (the restore
       * worked but the service did not start on the restored data) and `outcome-unknown` (the restore child gave no verdict and the
       * database could not be shown unchanged).
       */
      readonly dataIntact: boolean;
      /** The service is running again (on the original data) after the failure. */
      readonly backendRunning: boolean;
      readonly safetyBackup?: string;
      readonly errorCode?: string;
    };
