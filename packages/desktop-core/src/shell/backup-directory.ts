import { storagePolicy } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { RestoreBusyDetail } from "./restore-types.js";

/**
 * The Settings tab's 「備份位置」. The page sends nothing but "choose" (main opens the native folder dialog and reads every
 * path); the answer carries a masked display path and words, never a real path. Existing backups are never moved.
 */

/** What the card shows about the folder new backups go to. */
export interface RepairBackupDirectorySection {
  /** The folder with the home directory shown as `~`. */
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
  /** The service could not start on the new folder and the old folder could not be written back: the settings name the new one. */
  "not-restored",
  "failed",
] as const;
export type BackupDirectoryFailureReason = (typeof BACKUP_DIRECTORY_FAILURE_REASONS)[number];

export type BackupDirectoryChooseResult =
  | {
      readonly ok: true;
      /** The new folder, masked. */
      readonly display: string;
      /** Backups made before the change stay where they are. */
      readonly existingBackupsStayed: true;
    }
  | {
      readonly ok: false;
      readonly reason: BackupDirectoryFailureReason;
      readonly busy?: RestoreBusyDetail;
      /** The storage verdict that refused or needed a consent. */
      readonly risk?: Exclude<StorageRisk, "none">;
      /** The service runs again with the folder as it was (false only after a failed restart). */
      readonly backendRunning?: boolean;
    };

/** What the storage verdict of the chosen folder means for backups: use it, ask first, or refuse. */
export type BackupDirectoryVerdict = "use" | "confirm" | "refuse";

/**
 * Backups reuse the database's storage policy. A network drive is refused (a backup written over a share can be cut off
 * half way, and the App would believe it is safe); an external, cloud-synced or hard-linked folder needs the user's yes,
 * because the copy may be missing, partial or shared; a verdict that could not be read is only a soft note.
 */
export function backupDirectoryVerdict(risk: StorageRisk | undefined): BackupDirectoryVerdict {
  const policy = storagePolicy(risk);
  if (policy.refused) return "refuse";
  return policy.needsConsent ? "confirm" : "use";
}
