import type { RestoreBusyDetail } from "./restore-types.js";

/**
 * The contract of 「整理資料庫」 between the App window and main. The page sends one enum (`maintain` or `check`) and never a
 * path; the answer carries file names and numbers only. Types only: the window imports this file for checking.
 */

export const MAINTENANCE_MODES = ["maintain", "check"] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

/** How the last maintenance run recorded in the database ended. */
export interface MaintenanceLastRun {
  readonly status: "running" | "completed" | "failed";
  /** ISO time of its end (or start while it was still marked running). */
  readonly at: string;
  readonly failureCode?: "DATABASE_INTEGRITY_FAILED" | "DATABASE_MAINTENANCE_FAILED";
}

/** What the Status and Data tabs show about maintenance. */
export interface RepairMaintenanceSection {
  /** Free pages times page size; null until the running backend has answered once. */
  readonly reclaimableBytes: number | null;
  readonly databaseBytes: number | null;
  /** The free space is worth a compaction. */
  readonly suggest: boolean;
  /** The last run the database records (also true after a restart of the App); null when there was none. */
  readonly last: MaintenanceLastRun | null;
  /** The read-only check of this App session, when one ran. */
  readonly check: { readonly ok: boolean; readonly at: string } | null;
}

export const MAINTENANCE_FAILURE_REASONS = [
  "busy",
  "agents-running",
  "cancelled",
  "no-database",
  "in-use",
  "missing",
  "invalid",
  "integrity-failed",
  "backup-failed",
  "start-failed",
  "outcome-unknown",
  "failed",
] as const;
export type MaintenanceFailureReason = (typeof MAINTENANCE_FAILURE_REASONS)[number];

export type MaintenanceRunResult =
  | {
      readonly ok: true;
      readonly mode: MaintenanceMode;
      /** The backup made before compacting (maintain only). */
      readonly backupFileName?: string;
      /** How much smaller the file became, when it did. */
      readonly reclaimedBytes?: number;
    }
  | {
      readonly ok: false;
      readonly mode: MaintenanceMode;
      readonly reason: MaintenanceFailureReason;
      readonly busy?: RestoreBusyDetail;
      /** True when the database is exactly as it was before; false when that cannot be said. */
      readonly dataIntact: boolean;
      /** The service runs again after the failure. */
      readonly backendRunning: boolean;
      readonly backupFileName?: string;
    };
