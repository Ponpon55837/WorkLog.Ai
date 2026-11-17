import { z } from "zod";
import type { RepairActionId, RepairState } from "./repair-state.js";
import type { SetupState } from "./setup-state.js";
import { SETUP_AGENT_IDS, type AgentsState, type SetupAgentId } from "./agents-state.js";
import { isRepairPageUrl } from "./navigation-policy.js";

/** IPC channel names between the repair page (through its preload) and main. */
export const REPAIR_CHANNELS = {
  getState: "repair:get-state",
  retryStart: "repair:retry-start",
  chooseDatabase: "repair:choose-database",
  confirmDatabase: "repair:confirm-database",
  openFolder: "repair:open-folder",
  exportDiagnostics: "repair:export-diagnostics",
  startAnyway: "repair:start-anyway",
  getView: "app:get-view",
  copyCommand: "app:copy-command",
  setupGetState: "setup:get-state",
  setupUseDefaults: "setup:use-defaults",
  setupUseSource: "setup:use-source",
  setupChooseFile: "setup:choose-file",
  setupLater: "setup:later",
  showView: "app:show-view",
  agentsGetState: "agents:get-state",
  agentsPreview: "agents:preview",
  agentsApply: "agents:apply",
  agentsDiscard: "agents:discard",
  agentsUndo: "agents:undo",
  agentsSelfTest: "agents:self-test",
  agentsUseCheckoutDatabase: "agents:use-checkout-database",
} as const;

/** What the one App window shows; main decides, the page asks. */
export const APP_VIEWS = ["repair", "setup", "agents"] as const;
export type AppView = (typeof APP_VIEWS)[number];

/** Commands the page may ask main to copy to the clipboard; the text itself never comes from the page. */
export const COPY_COMMAND_TARGETS = ["legacy-remove", "legacy-fallback"] as const;
export type CopyCommandTarget = (typeof COPY_COMMAND_TARGETS)[number];

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
  /** Start although the old login service may serve the same database; the user said "仍要啟動". */
  startAnyway: z.strictObject({ operationId: z.uuid() }),
  getView: z.undefined(),
  copyCommand: z.strictObject({ target: z.enum(COPY_COMMAND_TARGETS) }),
  setupGetState: z.undefined(),
  setupUseDefaults: z.strictObject({ launchAtLogin: z.boolean(), startAnyway: z.boolean().optional() }),
  setupUseSource: z.strictObject({
    sourceId: z.string().min(1).max(64),
    allowMigration: z.boolean().optional(),
    startAnyway: z.boolean().optional(),
    launchAtLogin: z.boolean(),
  }),
  setupChooseFile: z.strictObject({}),
  setupLater: z.strictObject({}),
  /** The page may only move to the Agent page (after the first run); main opens every other view itself. */
  showView: z.strictObject({ view: z.literal("agents") }),
  agentsGetState: z.undefined(),
  /** `adopt`: also take over the hand-written checkout registrations ("改由桌面 App 管理"). Nothing is written. */
  agentsPreview: z.strictObject({ adopt: z.boolean() }),
  /** Applies exactly the plan this preview showed; a file changed since then makes the apply refuse. */
  agentsApply: z.strictObject({ previewId: z.uuid(), acknowledgeUndiffable: z.boolean().optional() }),
  agentsDiscard: z.strictObject({}),
  agentsUndo: z.strictObject({}),
  agentsSelfTest: z.strictObject({}),
  /** Opens the App's database change for the database this Agent's checkout uses; main reads the path itself. */
  agentsUseCheckoutDatabase: z.strictObject({ agent: z.enum(SETUP_AGENT_IDS) }),
} as const;

/** What an Agent page action answers. */
export type AgentsActionResult =
  | { readonly ok: true; readonly state: AgentsState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "failed";
      readonly errorCode?: string;
      readonly state?: AgentsState;
    };

/** What a first-run action answers; like the repair actions, `ok: false` carries a code, never a path. */
export type SetupActionResult =
  | { readonly ok: true; readonly state: SetupState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "cancelled" | "failed" | "legacy-service";
      readonly errorCode?: string;
      readonly state?: SetupState;
    };

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
  startAnyway(operationId: string): Promise<RepairActionResult>;
  getView(): Promise<AppView>;
  copyCommand(target: CopyCommandTarget): Promise<{ readonly ok: boolean }>;
  setupGetState(): Promise<SetupState>;
  setupUseDefaults(launchAtLogin: boolean, startAnyway?: boolean): Promise<SetupActionResult>;
  setupUseSource(input: {
    readonly sourceId: string;
    readonly launchAtLogin: boolean;
    readonly allowMigration?: boolean;
    readonly startAnyway?: boolean;
  }): Promise<SetupActionResult>;
  setupChooseFile(): Promise<SetupActionResult>;
  setupLater(): Promise<{ readonly ok: boolean }>;
  showAgents(): Promise<{ readonly ok: boolean }>;
  agentsGetState(): Promise<AgentsState>;
  agentsPreview(adopt: boolean): Promise<AgentsActionResult>;
  agentsApply(previewId: string, acknowledgeUndiffable?: boolean): Promise<AgentsActionResult>;
  agentsDiscard(): Promise<AgentsActionResult>;
  agentsUndo(): Promise<AgentsActionResult>;
  agentsSelfTest(): Promise<AgentsActionResult>;
  agentsUseCheckoutDatabase(agent: SetupAgentId): Promise<AgentsActionResult>;
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
    "start-anyway",
  ].includes(value);
}
