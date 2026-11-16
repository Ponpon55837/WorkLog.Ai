import { z } from "zod";
import type { RepairActionId, RepairState } from "./repair-state.js";
import { isRepairPageUrl } from "./navigation-policy.js";

/** IPC channel names between the repair page (through its preload) and main. */
export const REPAIR_CHANNELS = {
  getState: "repair:get-state",
  retryStart: "repair:retry-start",
  chooseDatabase: "repair:choose-database",
  confirmDatabase: "repair:confirm-database",
  openFolder: "repair:open-folder",
  exportDiagnostics: "repair:export-diagnostics",
} as const;

export type RepairChannel = (typeof REPAIR_CHANNELS)[keyof typeof REPAIR_CHANNELS];

export const REPAIR_FOLDER_TARGETS = ["database", "backups", "logs"] as const;
export type RepairFolderTarget = (typeof REPAIR_FOLDER_TARGETS)[number];

/** Input of each invoke, validated in main before anything runs. The page never sends a path. */
export const repairInputSchemas = {
  getState: z.undefined(),
  retryStart: z.strictObject({ operationId: z.uuid() }),
  chooseDatabase: z.strictObject({}),
  confirmDatabase: z.strictObject({
    candidateId: z.string().min(1).max(64),
    /** The user agreed to a schema update (only meaningful for a database that needs one). */
    allowMigration: z.boolean().optional(),
  }),
  openFolder: z.strictObject({ target: z.enum(REPAIR_FOLDER_TARGETS) }),
  exportDiagnostics: z.strictObject({}),
} as const;

/** What an action answers; `ok: false` carries a code the page maps to a message, never a path or a stack. */
export type RepairActionResult =
  | { readonly ok: true; readonly state: RepairState }
  | { readonly ok: false; readonly reason: "busy" | "invalid" | "cancelled" | "failed"; readonly errorCode?: string };

export type RepairExportResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "cancelled" | "failed" };

/** The API the preload exposes as `window.workIntelligenceRepair`. */
export interface RepairApi {
  getState(): Promise<RepairState>;
  retryStart(operationId: string): Promise<RepairActionResult>;
  chooseDatabase(): Promise<RepairActionResult>;
  confirmDatabase(candidateId: string, allowMigration?: boolean): Promise<RepairActionResult>;
  openFolder(target: RepairFolderTarget): Promise<{ readonly ok: boolean }>;
  exportDiagnostics(): Promise<RepairExportResult>;
}

/** The facts main reads from `event.senderFrame` and its window. */
export interface RepairSender {
  readonly frameUrl: string;
  /** The frame has no parent: it is the window's main frame. */
  readonly isMainFrame: boolean;
  /** The sending web contents is the repair window this handler belongs to. */
  readonly fromRepairWindow: boolean;
}

/** Only the repair page, in the main frame of the repair window, may call these channels. */
export function isTrustedRepairSender(sender: RepairSender): boolean {
  return sender.fromRepairWindow && sender.isMainFrame && isRepairPageUrl(sender.frameUrl);
}

export function isRepairActionId(value: string): value is RepairActionId {
  return [
    "retry-start",
    "choose-database",
    "open-database-folder",
    "open-backups-folder",
    "open-logs-folder",
    "export-diagnostics",
  ].includes(value);
}
