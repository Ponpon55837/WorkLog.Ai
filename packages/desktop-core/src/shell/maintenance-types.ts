import type { RestoreBusyDetail } from "./restore-types.js";

export const MAINTENANCE_MODES = ["maintain", "check"] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export interface MaintenanceLastRun {
  readonly status: "running" | "completed" | "failed";
  readonly at: string;
  readonly failureCode?: "DATABASE_INTEGRITY_FAILED" | "DATABASE_MAINTENANCE_FAILED";
}

export interface RepairMaintenanceSection {
  readonly reclaimableBytes: number | null;
  readonly databaseBytes: number | null;
  readonly suggest: boolean;
  readonly last: MaintenanceLastRun | null;
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
      readonly backupFileName?: string;
      readonly reclaimedBytes?: number;
    }
  | {
      readonly ok: false;
      readonly mode: MaintenanceMode;
      readonly reason: MaintenanceFailureReason;
      readonly busy?: RestoreBusyDetail;
      readonly dataIntact: boolean;
      readonly backendRunning: boolean;
      readonly backupFileName?: string;
    };
