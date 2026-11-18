/**
 * Contract of the one App window (tabbed shell). The window is created once and never reloaded to change tab.
 *
 * - Tabs: `APP_TABS` = setup, status, agent, settings, data, diagnostics (display order). `setup` exists only while
 *   `needsSetup`. See app-tabs.ts for the selection rule: requested tab > blocking tab > remembered tab > default.
 * - page asks main: `getTab()` (`app:get-tab`) answers `{ tab, tabs }` on mount; `rememberTab(tab)`
 *   (`app:remember-tab`, `{ tab }`) tells main which tab the user chose (memory only, validated against `APP_TABS`).
 * - main tells the page: `onSelectTab(cb)` (`app:select-tab`, payload an `AppTab`) whenever an open window is asked to
 *   show another tab. The page switches in place.
 * - `getState()` (`RepairState`) carries `shell: AppShellState` (`tabs`, `blockingTab`, `badges[tab] = { attention,
 *   busy }`) beside every field the earlier single-page view used. `attention` marks the blocking tab (Status while the
 *   service needs repair or the old login service holds the database); `busy` marks the tab whose coordinator operation
 *   is running.
 * - Every channel is checked in main: trusted sender (main frame of the one window on the fixed page URL), then input.
 */

import { z } from "zod";
import { APP_TABS, type AppTab, type AppTabSelection } from "./app-tabs.js";
import type { DiagnosticsReport } from "./diagnostics.js";
import type { RepairActionId, RepairState } from "./repair-state.js";
import type { SetupState } from "./setup-state.js";
import { SETUP_AGENT_IDS, type AgentsState, type SetupAgentId } from "./agents-state.js";
import { SYSTEM_SETTINGS_TARGETS, type SystemSettingsTarget } from "../legacy-service/system-settings.js";
import { isRepairPageUrl } from "./navigation-policy.js";
import type { PortProblem } from "./port-policy.js";
import {
  UPDATE_LINK_TARGETS,
  type UpdateCheckResult,
  type UpdateLinkTarget,
  type UpdateOpenLinkResult,
} from "../update-check/result.js";

/** IPC channel names between the repair page (through its preload) and main. */
export const REPAIR_CHANNELS = {
  getState: "repair:get-state",
  retryStart: "repair:retry-start",
  chooseDatabase: "repair:choose-database",
  confirmDatabase: "repair:confirm-database",
  openFolder: "repair:open-folder",
  previewDiagnostics: "repair:preview-diagnostics",
  saveDiagnostics: "repair:save-diagnostics",
  startAnyway: "repair:start-anyway",
  getTab: "app:get-tab",
  rememberTab: "app:remember-tab",
  /** The page names one of `SYSTEM_SETTINGS_TARGETS`; main opens one fixed OS place for it. */
  openSystemSettings: "app:open-system-settings",
  /** Read the old login service again (the user turned it off by hand). No input. */
  legacyRecheck: "legacy:recheck",
  setupGetState: "setup:get-state",
  setupUseDefaults: "setup:use-defaults",
  setupUseSource: "setup:use-source",
  setupChooseFile: "setup:choose-file",
  setupCopyToLocal: "setup:copy-to-local",
  setupLater: "setup:later",
  showView: "app:show-view",
  agentsGetState: "agents:get-state",
  agentsPreview: "agents:preview",
  agentsApply: "agents:apply",
  agentsDiscard: "agents:discard",
  agentsUndo: "agents:undo",
  agentsSelfTest: "agents:self-test",
  agentsUseCheckoutDatabase: "agents:use-checkout-database",
  legacyDisablePreview: "legacy:disable-preview",
  legacyDisableConfirm: "legacy:disable-confirm",
  legacyStartNow: "legacy:start-now",
  portChange: "port:change",
  copyToLocal: "repair:copy-to-local",
  updateCheck: "update:check",
  updateOpenLink: "update:open-link",
  /** Main to the page (not a request): select this tab (the payload is an `AppTab`); the window is never reloaded for it. */
  selectTab: "app:select-tab",
  /** Main to the page (not a request): the update check started or finished, so the page reads the state again. */
  updateChanged: "update:changed",
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
    /** The user ticked the checkbox that states why this database's storage is risky (DT-08). */
    acknowledgeStorageRisk: z.boolean().optional(),
  }),
  openFolder: z.strictObject({ target: z.enum(REPAIR_FOLDER_TARGETS) }),
  /** Builds the diagnostics text and keeps it in main; nothing is written. */
  previewDiagnostics: z.strictObject({}),
  /** Saves exactly the bytes of this preview (single use); the page never sends text or a path. */
  saveDiagnostics: z.strictObject({ previewId: z.uuid() }),
  /** Start although the old login service may serve the same database; the user said "仍要啟動". */
  startAnyway: z.strictObject({ operationId: z.uuid() }),
  getTab: z.undefined(),
  /** The tab the user selected; main remembers it for this session only and rejects any id outside `APP_TABS`. */
  rememberTab: z.strictObject({ tab: z.enum(APP_TABS) }),
  openSystemSettings: z.strictObject({ target: z.enum(SYSTEM_SETTINGS_TARGETS) }),
  legacyRecheck: z.strictObject({}),
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
  /** 「複製到本機磁碟並改用」 on the first-run page: for a source the page lists; main reads every path itself. */
  setupCopyToLocal: z.strictObject({ sourceId: z.string().min(1).max(64), launchAtLogin: z.boolean().optional() }),
  setupLater: z.strictObject({}),
  /** The page may only move to the Agent tab (after the first run); main selects every other tab itself. */
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
  /** Read-only: what 「停用舊的登入服務」 would do. Nothing is stopped or removed. */
  legacyDisablePreview: z.strictObject({}),
  /** Disables exactly what this preview showed; `continueWhileBusy`: the user saw the import/backup warning and went on. */
  legacyDisableConfirm: z.strictObject({ previewId: z.uuid(), continueWhileBusy: z.boolean().optional() }),
  /** 「立即啟動」 after a disable; main checks again that it is still offered. */
  legacyStartNow: z.strictObject({}),
  /** The port the user typed, as text or a number; main validates it (range, restricted ports) and runs the change. */
  portChange: z.strictObject({ port: z.union([z.string().max(16), z.number()]) }),
  /** 「複製到本機磁碟並改用」: for a browsed candidate, or (no id) the App's own database. Main reads every path itself. */
  copyToLocal: z.strictObject({ candidateId: z.string().min(1).max(64).optional() }),
  /** 「檢查更新」: no input; the one request goes to the fixed GitHub endpoint. */
  updateCheck: z.strictObject({}),
  /** Which kept link to open: a name, never a URL. */
  updateOpenLink: z.strictObject({ target: z.enum(UPDATE_LINK_TARGETS) }),
} as const;

/** What the 「停用舊的登入服務」 preview shows; the step lines are for 「詳細步驟」 only. */
export interface LegacyDisablePreview {
  readonly previewId: string;
  readonly running: boolean;
  /** Windows: the running old service is ended at once (no graceful shutdown). */
  readonly hardStop: boolean;
  /** An import or backup of the old service looks like it is running. */
  readonly busy: boolean;
  /** The old service used the App's own database (it is checked before the App opens it). */
  readonly sameDatabase: boolean;
  readonly steps: readonly string[];
}

export type LegacyDisablePreviewResult =
  | { readonly ok: true; readonly preview: LegacyDisablePreview }
  | { readonly ok: false; readonly reason: "unavailable" };

export type LegacyDisableConfirmResult =
  /** `databaseUnverified`: the database check could not finish this time (not damage); no 「立即啟動」 then. */
  | { readonly ok: true; readonly offerStart: boolean; readonly databaseUnverified?: boolean }
  | {
      readonly ok: false;
      /** `now-busy`: an import or backup started after the preview; nothing was done, the preview now warns. */
      readonly reason:
        | "invalid"
        | "cancelled"
        | "now-busy"
        | "busy"
        | "changed"
        | "still-running"
        | "failed"
        | "database-check-failed";
      /** `failed`: whether part of the registration was already removed. */
      readonly removed?: boolean;
    };

export type LegacyDisableStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "busy" | "failed"; readonly errorCode?: string };

/** Why a port change was refused because something is running. */
export type PortBusyReason = "operation" | "activity" | "unknown";

/** What 「變更連接埠」 answers; `ok: false` carries a reason the page maps to a sentence, never a path or a message. */
export type PortChangeResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly port: number;
      /** The restart threw away an idle staged import preview; the page says so. Absent otherwise. */
      readonly discardedImportPreview?: true;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "occupied" | "not-permitted" | "busy" | "cancelled" | "failed";
      /** `invalid`: what is wrong with the input. */
      readonly problem?: PortProblem;
      /** `busy`: what holds the change back. */
      readonly busy?: PortBusyReason;
      /** `failed`: the backend is back on the old port (otherwise the repair state shows the failure). */
      readonly rolledBack?: boolean;
      readonly errorCode?: string;
    };

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
      /** Why a copy to the local disk did not finish, in the page's language (never a path). */
      readonly message?: string;
      readonly state?: SetupState;
    };

/** What an action answers; `ok: false` carries a code the page maps to a message, never a path or a stack. */
export type RepairActionResult =
  | { readonly ok: true; readonly state: RepairState }
  | {
      readonly ok: false;
      readonly reason: "busy" | "invalid" | "cancelled" | "failed";
      readonly errorCode?: string;
      /** Why a chosen database was refused before any preview opened it, in the page's language (DT-08). */
      readonly message?: string;
    };

/** What 「匯出診斷」 shows before anything is written: the exact text, and what was masked (counts only). */
export type DiagnosticsPreviewResult =
  | { readonly ok: true; readonly previewId: string; readonly text: string; readonly report: DiagnosticsReport }
  | {
      readonly ok: false;
      /** `scan-failed`: a last check still found a secret or a path, so no text was made. */
      readonly reason: "failed" | "scan-failed";
    };

export type DiagnosticsSaveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `expired`: the preview is unknown, used, past its ten minutes, replaced, or was made for another sender; the
       * page previews again. `invalid`: the input did not parse.
       */
      readonly reason: "expired" | "cancelled" | "failed" | "invalid";
    };

/** The API the preload exposes as `window.workIntelligenceRepair`. */
export interface RepairApi {
  getState(): Promise<RepairState>;
  retryStart(operationId: string): Promise<RepairActionResult>;
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
  /** Which tab to show and which tabs exist; main decides, the page follows. */
  getTab(): Promise<AppTabSelection>;
  /** The user selected `tab`; main keeps it for this App session (memory only). `ok: false` for a tab not available now. */
  rememberTab(tab: AppTab): Promise<{ readonly ok: boolean }>;
  /** Calls `listener` whenever main asks the page to select a tab (the tray, a launch flag); the window is not reloaded. */
  onSelectTab(listener: (tab: AppTab) => void): void;
  /** Opens the OS place where the user can turn the old login service off by hand (an enum, never a path). */
  openSystemSettings(target: SystemSettingsTarget): Promise<{ readonly ok: boolean }>;
  /** Detects the old login service again; the page then reads the state. */
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
  agentsPreview(adopt: boolean): Promise<AgentsActionResult>;
  agentsApply(previewId: string, acknowledgeUndiffable?: boolean): Promise<AgentsActionResult>;
  agentsDiscard(): Promise<AgentsActionResult>;
  agentsUndo(): Promise<AgentsActionResult>;
  legacyDisablePreview(): Promise<LegacyDisablePreviewResult>;
  legacyDisableConfirm(previewId: string, continueWhileBusy?: boolean): Promise<LegacyDisableConfirmResult>;
  legacyStartNow(): Promise<LegacyDisableStartResult>;
  agentsSelfTest(): Promise<AgentsActionResult>;
  agentsUseCheckoutDatabase(agent: SetupAgentId): Promise<AgentsActionResult>;
  portChange(port: string | number): Promise<PortChangeResult>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  openUpdateLink(target: UpdateLinkTarget): Promise<UpdateOpenLinkResult>;
  /** Calls `listener` whenever main starts or finishes an update check (the button's or the tray item's). */
  onUpdateChanged(listener: () => void): void;
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
