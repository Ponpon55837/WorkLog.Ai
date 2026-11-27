import type { RepairBusyReason } from "./repair-busy.js";
import { z } from "zod";
import { APP_TABS, type AppTab, type AppTabSelection } from "./app-tabs.js";
import type { DiagnosticsReport } from "./diagnostics.js";
import type { RepairState } from "./repair-state.js";
import type { SetupState } from "./setup-state.js";
import { SETUP_AGENT_IDS, type AgentsState, type SetupAgentId } from "./agents-state.js";
import { SYSTEM_SETTINGS_TARGETS, type SystemSettingsTarget } from "../legacy-service/system-settings.js";
import { isRepairPageUrl } from "./navigation-policy.js";
import type { PortProblem } from "./port-policy.js";
import type { RepairLoginItemSection } from "./login-item-status.js";
import { SHELL_LANGUAGE_PREFERENCES, type ShellLanguagePreference } from "@work-intelligence/schema";
import {
  UPDATE_LINK_TARGETS,
  type UpdateCheckResult,
  type UpdateLinkTarget,
  type UpdateOpenLinkResult,
} from "../update-check/result.js";
import type { BackupDirectoryChooseResult } from "./backup-directory.js";
import { MAINTENANCE_MODES, type MaintenanceMode, type MaintenanceRunResult } from "./maintenance-types.js";
import type { RestoreListResult, RestorePickResult, RestoreRunResult } from "./restore-types.js";

export const REPAIR_CHANNELS = {
  getState: "repair:get-state",
  retryStart: "repair:retry-start",
  approveMigration: "repair:approve-migration",
  chooseDatabase: "repair:choose-database",
  confirmDatabase: "repair:confirm-database",
  openFolder: "repair:open-folder",
  previewDiagnostics: "repair:preview-diagnostics",
  saveDiagnostics: "repair:save-diagnostics",
  startAnyway: "repair:start-anyway",
  getTab: "app:get-tab",
  rememberTab: "app:remember-tab",
  openSystemSettings: "app:open-system-settings",
  legacyRecheck: "legacy:recheck",
  recoveryAcknowledge: "app:recovery-acknowledge",
  setupGetState: "setup:get-state",
  setupUseDefaults: "setup:use-defaults",
  setupUseSource: "setup:use-source",
  setupChooseFile: "setup:choose-file",
  setupCopyToLocal: "setup:copy-to-local",
  setupLater: "setup:later",
  showView: "app:show-view",
  agentsGetState: "agents:get-state",
  agentsPreview: "agents:preview",
  agentsRemovePreview: "agents:remove-preview",
  agentsApply: "agents:apply",
  agentsDiscard: "agents:discard",
  agentsUndo: "agents:undo",
  agentsSelfTest: "agents:self-test",
  agentsUseCheckoutDatabase: "agents:use-checkout-database",
  legacyDisablePreview: "legacy:disable-preview",
  legacyDisableConfirm: "legacy:disable-confirm",
  legacyStartNow: "legacy:start-now",
  portChange: "port:change",
  loginItemSet: "login-item:set",
  languageSet: "language:set",
  maintenanceRun: "maintenance:run",
  backupDirectoryChoose: "backup-directory:choose",
  copyToLocal: "repair:copy-to-local",
  updateCheck: "update:check",
  updateOpenLink: "update:open-link",
  restoreList: "restore:list",
  restorePick: "restore:pick",
  restoreRun: "restore:run",
  selectTab: "app:select-tab",
  updateChanged: "update:changed",
} as const;

export type RepairChannel = (typeof REPAIR_CHANNELS)[keyof typeof REPAIR_CHANNELS];

export const REPAIR_FOLDER_TARGETS = ["database", "backups", "logs"] as const;
export type RepairFolderTarget = (typeof REPAIR_FOLDER_TARGETS)[number];

/** Validated in main before anything runs. The page never sends a path, only ids main handed out. */
export const repairInputSchemas = {
  getState: z.undefined(),
  retryStart: z.strictObject({ operationId: z.uuid() }),
  approveMigration: z.strictObject({ operationId: z.uuid() }),
  chooseDatabase: z.strictObject({}),
  confirmDatabase: z.strictObject({
    candidateId: z.string().min(1).max(64),
    allowMigration: z.boolean().optional(),
    acknowledgeStorageRisk: z.boolean().optional(),
  }),
  openFolder: z.strictObject({ target: z.enum(REPAIR_FOLDER_TARGETS) }),
  previewDiagnostics: z.strictObject({}),
  saveDiagnostics: z.strictObject({ previewId: z.uuid() }),
  startAnyway: z.strictObject({ operationId: z.uuid() }),
  getTab: z.undefined(),
  rememberTab: z.strictObject({ tab: z.enum(APP_TABS) }),
  openSystemSettings: z.strictObject({ target: z.enum(SYSTEM_SETTINGS_TARGETS) }),
  legacyRecheck: z.strictObject({}),
  recoveryAcknowledge: z.strictObject({ id: z.string().min(1).max(128) }),
  setupGetState: z.undefined(),
  setupUseDefaults: z.strictObject({ launchAtLogin: z.boolean(), startAnyway: z.boolean().optional() }),
  setupUseSource: z.strictObject({
    sourceId: z.string().min(1).max(64),
    allowMigration: z.boolean().optional(),
    acknowledgeStorageRisk: z.boolean().optional(),
    startAnyway: z.boolean().optional(),
    launchAtLogin: z.boolean(),
  }),
  setupChooseFile: z.strictObject({}),
  setupCopyToLocal: z.strictObject({ sourceId: z.string().min(1).max(64), launchAtLogin: z.boolean().optional() }),
  setupLater: z.strictObject({}),
  showView: z.strictObject({ view: z.literal("agents") }),
  agentsGetState: z.undefined(),
  agentsPreview: z.strictObject({ adopt: z.boolean(), agents: z.array(z.enum(SETUP_AGENT_IDS)).min(1).optional() }),
  agentsRemovePreview: z.strictObject({}),
  agentsApply: z.strictObject({ previewId: z.uuid(), acknowledgeUndiffable: z.boolean().optional() }),
  agentsDiscard: z.strictObject({}),
  agentsUndo: z.strictObject({}),
  agentsSelfTest: z.strictObject({}),
  agentsUseCheckoutDatabase: z.strictObject({ agent: z.enum(SETUP_AGENT_IDS) }),
  legacyDisablePreview: z.strictObject({}),
  legacyDisableConfirm: z.strictObject({ previewId: z.uuid(), continueWhileBusy: z.boolean().optional() }),
  legacyStartNow: z.strictObject({}),
  portChange: z.strictObject({ port: z.union([z.string().max(16), z.number()]) }),
  loginItemSet: z.strictObject({ enable: z.boolean() }),
  languageSet: z.strictObject({ preference: z.enum(SHELL_LANGUAGE_PREFERENCES) }),
  maintenanceRun: z.strictObject({ mode: z.enum(MAINTENANCE_MODES) }),
  backupDirectoryChoose: z.strictObject({}),
  copyToLocal: z.strictObject({ candidateId: z.string().min(1).max(64).optional() }),
  updateCheck: z.strictObject({}),
  updateOpenLink: z.strictObject({ target: z.enum(UPDATE_LINK_TARGETS) }),
  restoreList: z.strictObject({}),
  restorePick: z.strictObject({}),
  restoreRun: z.strictObject({ backupId: z.uuid() }),
} as const;

export interface LegacyDisablePreview {
  readonly previewId: string;
  readonly running: boolean;
  readonly hardStop: boolean;
  readonly busy: boolean;
  readonly sameDatabase: boolean;
  readonly steps: readonly string[];
}

export type LegacyDisablePreviewResult =
  | { readonly ok: true; readonly preview: LegacyDisablePreview }
  | { readonly ok: false; readonly reason: "unavailable" };

export type LegacyDisableConfirmResult =
  | { readonly ok: true; readonly offerStart: boolean; readonly databaseUnverified?: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "cancelled"
        | "now-busy"
        | "busy"
        | "changed"
        | "still-running"
        | "failed"
        | "database-check-failed";
      readonly removed?: boolean;
      readonly busyReason?: RepairBusyReason;
    };

export type LegacyDisableStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "busy" | "failed";
      readonly errorCode?: string;
      readonly busyReason?: RepairBusyReason;
    };

export type LoginItemSetResult =
  | { readonly ok: true; readonly section: RepairLoginItemSection }
  | {
      readonly ok: false;
      readonly reason: "busy" | "unsupported" | "failed";
      readonly section?: RepairLoginItemSection;
    };

export type LanguageSetResult = { readonly ok: true } | { readonly ok: false; readonly reason: "failed" };

export type PortBusyReason = "operation" | "activity" | "unknown";

export type PortChangeResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly port: number;
      readonly discardedImportPreview?: true;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "occupied" | "not-permitted" | "busy" | "cancelled" | "failed";
      readonly problem?: PortProblem;
      readonly busy?: PortBusyReason;
      readonly rolledBack?: boolean;
      readonly errorCode?: string;
    };

export type AgentsActionResult =
  | { readonly ok: true; readonly state: AgentsState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "failed";
      readonly errorCode?: string;
      readonly state?: AgentsState;
    };

export type SetupActionResult =
  | { readonly ok: true; readonly state: SetupState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "cancelled" | "failed" | "legacy-service";
      readonly errorCode?: string;
      readonly message?: string;
      readonly state?: SetupState;
    };

export type RepairActionResult =
  | { readonly ok: true; readonly state: RepairState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "cancelled" | "failed";
      readonly errorCode?: string;
      readonly busyReason?: RepairBusyReason;
      readonly message?: string;
    };

export type DiagnosticsPreviewResult =
  | { readonly ok: true; readonly previewId: string; readonly text: string; readonly report: DiagnosticsReport }
  | {
      readonly ok: false;
      readonly reason: "failed" | "scan-failed";
    };

export type DiagnosticsSaveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "expired" | "cancelled" | "failed" | "invalid";
    };

export interface RepairApi {
  getState(): Promise<RepairState>;
  retryStart(operationId: string): Promise<RepairActionResult>;
  approveMigration(operationId: string): Promise<RepairActionResult>;
  chooseDatabase(): Promise<RepairActionResult>;
  confirmDatabase(
    candidateId: string,
    allowMigration?: boolean,
    acknowledgeStorageRisk?: boolean,
  ): Promise<RepairActionResult>;
  copyToLocal(candidateId?: string): Promise<RepairActionResult>;
  openFolder(target: RepairFolderTarget): Promise<{ readonly ok: boolean }>;
  previewDiagnostics(): Promise<DiagnosticsPreviewResult>;
  saveDiagnostics(previewId: string): Promise<DiagnosticsSaveResult>;
  startAnyway(operationId: string): Promise<RepairActionResult>;
  getTab(): Promise<AppTabSelection>;
  rememberTab(tab: AppTab): Promise<{ readonly ok: boolean }>;
  acknowledgeRecovery(id: string): Promise<{ readonly ok: boolean }>;
  onSelectTab(listener: (tab: AppTab) => void): void;
  openSystemSettings(target: SystemSettingsTarget): Promise<{ readonly ok: boolean }>;
  legacyRecheck(): Promise<{ readonly ok: boolean }>;
  setupGetState(): Promise<SetupState>;
  setupUseDefaults(launchAtLogin: boolean, startAnyway?: boolean): Promise<SetupActionResult>;
  setupUseSource(input: {
    readonly sourceId: string;
    readonly launchAtLogin: boolean;
    readonly allowMigration?: boolean;
    readonly acknowledgeStorageRisk?: boolean;
    readonly startAnyway?: boolean;
  }): Promise<SetupActionResult>;
  setupChooseFile(): Promise<SetupActionResult>;
  setupCopyToLocal(sourceId: string, launchAtLogin?: boolean): Promise<SetupActionResult>;
  setupLater(): Promise<{ readonly ok: boolean }>;
  showAgents(): Promise<{ readonly ok: boolean }>;
  agentsGetState(): Promise<AgentsState>;
  agentsPreview(adopt: boolean, agents?: readonly SetupAgentId[]): Promise<AgentsActionResult>;
  agentsRemovePreview(): Promise<AgentsActionResult>;
  agentsApply(previewId: string, acknowledgeUndiffable?: boolean): Promise<AgentsActionResult>;
  agentsDiscard(): Promise<AgentsActionResult>;
  agentsUndo(): Promise<AgentsActionResult>;
  legacyDisablePreview(): Promise<LegacyDisablePreviewResult>;
  legacyDisableConfirm(previewId: string, continueWhileBusy?: boolean): Promise<LegacyDisableConfirmResult>;
  legacyStartNow(): Promise<LegacyDisableStartResult>;
  agentsSelfTest(): Promise<AgentsActionResult>;
  agentsUseCheckoutDatabase(agent: SetupAgentId): Promise<AgentsActionResult>;
  portChange(port: string | number): Promise<PortChangeResult>;
  setLaunchAtLogin(enable: boolean): Promise<LoginItemSetResult>;
  setLanguage(preference: ShellLanguagePreference): Promise<LanguageSetResult>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  openUpdateLink(target: UpdateLinkTarget): Promise<UpdateOpenLinkResult>;
  runMaintenance(mode: MaintenanceMode): Promise<MaintenanceRunResult>;
  chooseBackupDirectory(): Promise<BackupDirectoryChooseResult>;
  restoreList(): Promise<RestoreListResult>;
  restorePick(): Promise<RestorePickResult>;
  restoreRun(backupId: string): Promise<RestoreRunResult>;
  onUpdateChanged(listener: () => void): void;
}

export interface RepairSender {
  readonly frameUrl: string;
  readonly isMainFrame: boolean;
  readonly fromRepairWindow: boolean;
}

export function isTrustedRepairSender(sender: RepairSender): boolean {
  return sender.fromRepairWindow && sender.isMainFrame && isRepairPageUrl(sender.frameUrl);
}
