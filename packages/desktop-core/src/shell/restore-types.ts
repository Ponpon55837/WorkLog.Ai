import type { OperationKind } from "../operations/journal-record.js";

export const BACKUP_PROBLEMS = ["newer-schema", "not-database", "corrupt", "unreadable", "missing"] as const;
export type BackupProblem = (typeof BACKUP_PROBLEMS)[number];

export type RestoreBackupLabel =
  "automatic" | "manual" | "migration" | "deletion" | "session_deletion" | "maintenance" | "import" | "picked";

export interface RestoreBackupView {
  readonly backupId?: string;
  readonly label: RestoreBackupLabel;
  readonly fileName: string;
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
      readonly directoryReadable: boolean;
      readonly agentsRunning: boolean;
      readonly noDatabase: boolean;
    }
  | { readonly ok: false; readonly reason: "failed" | "invalid" };

export type RestorePickResult =
  | { readonly ok: true; readonly backup: RestoreBackupView }
  | {
      readonly ok: false;
      readonly reason: "cancelled" | "invalid" | "failed" | BackupProblem;
      readonly schemaVersion?: number;
    };

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
      readonly safetyBackup?: string;
      readonly projects: number;
      readonly sessions: number;
      readonly remapped?: number;
    }
  | {
      readonly ok: false;
      readonly reason: RestoreFailureReason;
      readonly busy?: RestoreBusyDetail;
      readonly dataIntact: boolean;
      readonly backendRunning: boolean;
      readonly safetyBackup?: string;
      readonly errorCode?: string;
    };
