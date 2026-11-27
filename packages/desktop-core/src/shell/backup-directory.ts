import { storagePolicy } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { RestoreBusyDetail } from "./restore-types.js";

export interface RepairBackupDirectorySection {
  readonly display: string;
}

export const BACKUP_DIRECTORY_FAILURE_REASONS = [
  "cancelled",
  "busy",
  "no-settings",
  "not-writable",
  "refused",
  "declined",
  "start-failed",
  "not-restored",
  "failed",
] as const;
export type BackupDirectoryFailureReason = (typeof BACKUP_DIRECTORY_FAILURE_REASONS)[number];

export type BackupDirectoryChooseResult =
  | {
      readonly ok: true;
      readonly display: string;
      readonly existingBackupsStayed: true;
    }
  | {
      readonly ok: false;
      readonly reason: BackupDirectoryFailureReason;
      readonly busy?: RestoreBusyDetail;
      readonly risk?: Exclude<StorageRisk, "none">;
      readonly backendRunning?: boolean;
    };

export type BackupDirectoryVerdict = "use" | "confirm" | "refuse";

export function backupDirectoryVerdict(risk: StorageRisk | undefined): BackupDirectoryVerdict {
  const policy = storagePolicy(risk);
  if (policy.refused) return "refuse";
  return policy.needsConsent ? "confirm" : "use";
}
