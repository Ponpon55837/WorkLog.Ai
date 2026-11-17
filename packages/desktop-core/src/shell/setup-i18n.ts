import type { DbGroupStatus, DbSourceKind } from "../db-source/types.js";
import type { AgentDisplayState } from "../agents/status.js";
import type { AgentRegistrationOwner, SetupAgentId } from "./agents-state.js";
import type { ShellLocale } from "./i18n.js";

/**
 * Strings of the first-run page, the Agent page and the old-login-service warning. Kept apart from ShellMessages so the
 * tray and repair strings stay as they are; both languages must define all of it. zh-TW copy is short and plain.
 */
export interface SetupMessages {
  readonly setupWindowTitle: string;
  readonly setupHeading: string;
  readonly setupDetecting: string;
  readonly setupNewIntro: string;
  readonly setupUseDefaults: string;
  readonly setupUseExisting: string;
  readonly setupExistingIntro: string;
  readonly setupKeepThisData: string;
  readonly setupChooseIntro: string;
  readonly setupChooseConflict: string;
  readonly setupChooseBlocked: string;
  readonly setupUseThis: string;
  readonly setupBrowse: string;
  readonly setupLater: string;
  readonly setupStarting: string;
  readonly setupDatabase: string;
  readonly setupUrl: string;
  readonly setupBackups: string;
  readonly setupLaunchAtLogin: string;
  readonly setupAdvanced: string;
  /** `{count}` projects. */
  readonly setupProjectCount: string;
  readonly setupFoundBy: string;
  readonly setupMigrationConsent: string;
  readonly setupFailed: string;
  readonly setupNextAgents: string;
  readonly sourceKinds: Readonly<Record<DbSourceKind, string>>;
  readonly sourceStatus: Readonly<Record<DbGroupStatus | "unknown", string>>;
  readonly legacyHeading: string;
  readonly legacyWarning: string;
  readonly legacyRunning: string;
  readonly legacyStopped: string;
  readonly legacyUnknown: string;
  readonly legacyRemoveHint: string;
  readonly legacyFallbackHint: string;
  readonly legacyCopy: string;
  readonly legacyCopied: string;
  readonly legacyStartAnyway: string;
  readonly legacyStartAnywayConfirm: string;
  readonly legacyBlocked: string;
  readonly legacyStartsAtLogin: string;
  readonly setupDetectingHint: string;
  readonly trayLegacyStatus: string;
  readonly trayLegacyStartAnyway: string;
  readonly trayLegacyHowToRemove: string;
  /** The backend could not bind its port and the old service is installed: say which one holds it. */
  readonly legacyPortInUse: string;
  readonly trayCompleteSetup: string;
  readonly trayAgentSetup: string;
  readonly setupDone: string;
  readonly setupOpenAgents: string;
  readonly setupClose: string;
  readonly agentsWindowTitle: string;
  readonly agentsHeading: string;
  readonly agentsIntro: string;
  readonly agentNames: Readonly<Record<SetupAgentId, string>>;
  readonly agentStates: Readonly<Record<AgentDisplayState, string>>;
  readonly agentOwners: Readonly<Record<AgentRegistrationOwner, string>>;
  readonly agentsMcp: string;
  readonly agentsHooks: string;
  readonly agentsCheckout: string;
  readonly agentsCheckoutMissing: string;
  readonly agentsAdoptHint: string;
  readonly agentsNotAdoptable: string;
  /** `{path}`: the database the checkout's MCP entry uses. */
  readonly agentsOtherDatabase: string;
  /** `{path}`: the checkout default a hook uses when the Agent's environment does not name a database. */
  readonly agentsOtherDatabaseDefault: string;
  readonly agentsUseOtherDatabase: string;
  readonly agentsKeepCheckout: string;
  readonly agentsPreview: string;
  readonly agentsPreviewAdopt: string;
  readonly agentsPreviewHeading: string;
  readonly agentsApply: string;
  readonly agentsDiscard: string;
  readonly agentsUndo: string;
  readonly agentsSelfTest: string;
  /** `{ms}`. */
  readonly agentsSelfTestOk: string;
  /** `{code}`. */
  readonly agentsSelfTestFailed: string;
  readonly agentsSelfTestNotRun: string;
  readonly agentsNoChanges: string;
  readonly agentsConflicts: string;
  /** `{count}`. */
  readonly agentsApplied: string;
  readonly agentsUndone: string;
  readonly agentsNothingToUndo: string;
  /** `{code}`. */
  readonly agentsFailed: string;
  /** `{path}`. */
  readonly agentsManualRepair: string;
  readonly agentsLauncherNotReady: string;
  readonly agentsChange: Readonly<Record<"create" | "update" | "delete", string>>;
  readonly agentsBusy: string;
}

const zhTW: SetupMessages = {
  setupWindowTitle: "Work Intelligence 設定",
  setupHeading: "開始使用 Work Intelligence",
  setupDetecting: "正在尋找既有資料…",
  setupNewIntro: "沒有找到既有資料。使用預設設定即可開始，之後都可以再改。",
  setupUseDefaults: "使用預設設定開始",
  setupUseExisting: "使用已有的資料庫…",
  setupExistingIntro: "找到一份既有資料。沿用它不會改動內容。",
  setupKeepThisData: "沿用這份資料",
  setupChooseIntro: "找到多份資料，請選擇要使用哪一份。不會合併，也不會刪除其他份。",
  setupChooseConflict: "這些資料庫來自同一份資料，但內容已經分開。請選擇一份。",
  setupChooseBlocked: "原本設定的資料庫目前無法讀取。請確認磁碟已連接，或選擇其他資料庫。",
  setupUseThis: "使用這份",
  setupBrowse: "瀏覽其他位置…",
  setupLater: "稍後再說",
  setupStarting: "正在啟動…",
  setupDatabase: "資料庫",
  setupUrl: "本機網址",
  setupBackups: "備份",
  setupLaunchAtLogin: "登入時在背景執行",
  setupAdvanced: "進階",
  setupProjectCount: "{count} 個專案",
  setupFoundBy: "來源",
  setupMigrationConsent: "這份資料庫需要更新格式；會先備份再更新。",
  setupFailed: "無法開始",
  setupNextAgents: "接下來可以在「設定 Agent…」連接 Codex 或 Claude Code。",
  sourceKinds: {
    "desktop-committed": "App 設定",
    "explicit-selection": "你選擇的",
    "legacy-service": "舊的登入服務",
    "plugin-link": "plugin 連結",
    "agent-mcp": "Agent 設定",
    "standalone-default": "預設位置",
    "checkout-default": "原始碼目錄",
  },
  sourceStatus: {
    ok: "可以使用",
    missing: "找不到檔案",
    offline: "磁碟未連接",
    denied: "沒有權限讀取",
    unreadable: "無法讀取",
    "unsupported-schema": "版本較新或不是 Work Intelligence 的資料庫",
    conflict: "與另一份來自同一份資料",
    unknown: "尚未檢查",
  },
  legacyHeading: "舊的登入服務",
  legacyWarning: "偵測到舊的登入服務（pnpm bootstrap）也在使用這份資料庫；同時執行兩個後端可能造成問題",
  legacyRunning: "目前正在執行。",
  legacyStopped: "目前沒有執行。",
  legacyUnknown: "無法確認是否正在執行。",
  legacyRemoveHint: "在終端機執行這個指令移除它：",
  legacyFallbackHint: "如果原始碼目錄已經不在，改用：",
  legacyCopy: "複製指令",
  legacyCopied: "已複製",
  legacyStartAnyway: "仍要啟動",
  legacyStartAnywayConfirm: "確定要在舊服務也在執行時啟動嗎？兩個後端同時寫入同一份資料庫可能造成問題。",
  legacyBlocked: "為了避免兩個後端同時使用同一份資料庫，App 還沒有啟動自己的後端。",
  legacyStartsAtLogin: "下次登入時會啟動。",
  setupDetectingHint: "正在檢查…完成後即可使用",
  trayLegacyStatus: "偵測到舊的登入服務也使用這份資料庫，未自動啟動",
  trayLegacyStartAnyway: "仍要啟動",
  trayLegacyHowToRemove: "如何移除舊服務",
  legacyPortInUse: "連接埠已被舊的登入服務（pnpm bootstrap）使用。請先移除舊服務，再重試。",
  trayCompleteSetup: "完成首次設定…",
  trayAgentSetup: "設定 Agent…",
  setupDone: "已可以開始使用。Dashboard 已開啟。",
  setupOpenAgents: "設定 Agent…",
  setupClose: "關閉",
  agentsWindowTitle: "Work Intelligence Agent 設定",
  agentsHeading: "設定 Agent",
  agentsIntro:
    "讓 Codex 與 Claude Code 透過桌面 App 使用 Work Intelligence。寫入前會先顯示每個檔案的變更，也可以復原。",
  agentNames: { codex: "Codex", "claude-code": "Claude Code" },
  agentStates: {
    "observed-connected": "已連線",
    "configured-unverified": "已設定，待確認",
    "needs-trust": "需要信任／授權",
    "externally-managed": "由其他方式管理",
    conflict: "設定衝突",
    "runtime-incompatible": "執行環境不相容",
    "needs-reconnect": "需要重新連線",
    "not-configured": "尚未設定",
  },
  agentOwners: {
    "desktop-managed": "桌面 App",
    manual: "手動設定",
    plugin: "plugin",
    mcpb: "擴充套件",
    unknown: "無法判斷",
    none: "未設定",
  },
  agentsMcp: "MCP",
  agentsHooks: "Hook",
  agentsCheckout: "原始碼目錄",
  agentsCheckoutMissing: "這個原始碼目錄已經不在，目前的設定無法啟動。",
  agentsAdoptHint: "目前直接執行原始碼目錄。可以改由桌面 App 管理；使用的資料庫不變。",
  agentsNotAdoptable: "這個設定不是 setup 寫入的格式，App 不會改動它：",
  agentsOtherDatabase:
    "這個原始碼目錄使用另一份資料庫：{path}。App 只接管使用同一份資料庫的設定，否則這個 Agent 的工作記錄會分散在兩個地方。",
  agentsOtherDatabaseDefault:
    "這個原始碼目錄的 hook 使用 {path}（除非 Agent 的環境另外指定了資料庫）。App 只接管使用同一份資料庫的設定，否則這個 Agent 的工作記錄會分散在兩個地方。",
  agentsUseOtherDatabase: "改用這份資料庫",
  agentsKeepCheckout: "也可以保留原本的設定，App 不會改動它。",
  agentsPreview: "預覽變更",
  agentsPreviewAdopt: "改由桌面 App 管理…",
  agentsPreviewHeading: "將要寫入的變更",
  agentsApply: "套用變更",
  agentsDiscard: "取消",
  agentsUndo: "復原上次變更",
  agentsSelfTest: "測試連線",
  agentsSelfTestOk: "連線正常（{ms} ms）",
  agentsSelfTestFailed: "測試失敗（{code}）",
  agentsSelfTestNotRun: "尚未測試",
  agentsNoChanges: "設定已是最新，不需要變更。",
  agentsConflicts: "有衝突，沒有寫入任何檔案：",
  agentsApplied: "已更新 {count} 個檔案。請重新開啟 Agent。",
  agentsUndone: "已復原上次的變更。",
  agentsNothingToUndo: "沒有可以復原的變更。",
  agentsFailed: "沒有完成（{code}），已寫入的部分已還原。",
  agentsManualRepair: "這個檔案在套用後被改過，沒有自動復原：{path}",
  agentsLauncherNotReady: "App 的執行環境還沒準備好；完成首次設定後再試。",
  agentsChange: { create: "新增", update: "修改", delete: "刪除" },
  agentsBusy: "處理中…",
};

const en: SetupMessages = {
  setupWindowTitle: "Work Intelligence Setup",
  setupHeading: "Get started with Work Intelligence",
  setupDetecting: "Looking for existing data…",
  setupNewIntro: "No existing data was found. Start with the defaults; you can change them later.",
  setupUseDefaults: "Start with the defaults",
  setupUseExisting: "Use an existing database…",
  setupExistingIntro: "Existing data was found. Using it changes nothing in it.",
  setupKeepThisData: "Keep using this data",
  setupChooseIntro: "Several databases were found. Choose the one to use; nothing is merged or deleted.",
  setupChooseConflict: "These databases come from the same data but have diverged. Choose one.",
  setupChooseBlocked: "The database that was set up cannot be read right now. Connect its disk, or choose another one.",
  setupUseThis: "Use this one",
  setupBrowse: "Browse…",
  setupLater: "Not now",
  setupStarting: "Starting…",
  setupDatabase: "Database",
  setupUrl: "Local address",
  setupBackups: "Backups",
  setupLaunchAtLogin: "Run in the background at login",
  setupAdvanced: "Advanced",
  setupProjectCount: "{count} projects",
  setupFoundBy: "Found in",
  setupMigrationConsent: "This database needs a format update; it is backed up first.",
  setupFailed: "Could not start",
  setupNextAgents: "Next, connect Codex or Claude Code from “Set up Agents…”.",
  sourceKinds: {
    "desktop-committed": "App settings",
    "explicit-selection": "Your choice",
    "legacy-service": "Old login service",
    "plugin-link": "Plugin link",
    "agent-mcp": "Agent settings",
    "standalone-default": "Default location",
    "checkout-default": "Source checkout",
  },
  sourceStatus: {
    ok: "Ready to use",
    missing: "File not found",
    offline: "Disk not connected",
    denied: "No permission to read it",
    unreadable: "Cannot be read",
    "unsupported-schema": "Newer version or not a Work Intelligence database",
    conflict: "Comes from the same data as another one",
    unknown: "Not checked yet",
  },
  legacyHeading: "Old login service",
  legacyWarning:
    "The old login service (pnpm bootstrap) also uses this database; running two backends at once can cause problems",
  legacyRunning: "It is running now.",
  legacyStopped: "It is not running now.",
  legacyUnknown: "Whether it is running cannot be told.",
  legacyRemoveHint: "Remove it by running this command in a terminal:",
  legacyFallbackHint: "If the source checkout is gone, use:",
  legacyCopy: "Copy command",
  legacyCopied: "Copied",
  legacyStartAnyway: "Start anyway",
  legacyStartAnywayConfirm:
    "Start while the old service may be running? Two backends writing to one database can cause problems.",
  legacyBlocked: "To keep two backends off one database, the App has not started its own backend yet.",
  legacyStartsAtLogin: "It will start at the next login.",
  setupDetectingHint: "Checking… available when done",
  trayLegacyStatus: "The old login service also uses this database; the App did not start automatically",
  trayLegacyStartAnyway: "Start anyway",
  trayLegacyHowToRemove: "How to remove the old service",
  legacyPortInUse: "The port is used by the old login service (pnpm bootstrap). Remove it first, then try again.",
  trayCompleteSetup: "Finish setup…",
  trayAgentSetup: "Set up Agents…",
  setupDone: "You are ready to go. The Dashboard is open.",
  setupOpenAgents: "Set up Agents…",
  setupClose: "Close",
  agentsWindowTitle: "Work Intelligence Agents",
  agentsHeading: "Set up Agents",
  agentsIntro:
    "Let Codex and Claude Code use Work Intelligence through the desktop App. Every file change is shown before it is written, and can be undone.",
  agentNames: { codex: "Codex", "claude-code": "Claude Code" },
  agentStates: {
    "observed-connected": "Connected",
    "configured-unverified": "Set up, not confirmed yet",
    "needs-trust": "Needs trust or approval",
    "externally-managed": "Managed elsewhere",
    conflict: "Conflicting settings",
    "runtime-incompatible": "Runtime not compatible",
    "needs-reconnect": "Needs to reconnect",
    "not-configured": "Not set up",
  },
  agentOwners: {
    "desktop-managed": "Desktop App",
    manual: "Set up by hand",
    plugin: "Plugin",
    mcpb: "Extension",
    unknown: "Cannot tell",
    none: "Not set up",
  },
  agentsMcp: "MCP",
  agentsHooks: "Hooks",
  agentsCheckout: "Source checkout",
  agentsCheckoutMissing: "This source checkout is gone; the current settings cannot start.",
  agentsAdoptHint:
    "It runs a source checkout directly. The desktop App can manage it instead; the database stays the same.",
  agentsNotAdoptable: "These settings are not in the form setup writes, so the App leaves them alone:",
  agentsOtherDatabase:
    "This source checkout uses another database: {path}. The App only takes over settings on the same database; otherwise this Agent's work would be recorded in two places.",
  agentsOtherDatabaseDefault:
    "This source checkout's hooks use {path} (unless the Agent's environment names another database). The App only takes over settings on the same database; otherwise this Agent's work would be recorded in two places.",
  agentsUseOtherDatabase: "Use this database",
  agentsKeepCheckout: "Or keep the current settings; the App leaves them alone.",
  agentsPreview: "Preview changes",
  agentsPreviewAdopt: "Let the desktop App manage it…",
  agentsPreviewHeading: "Changes to be written",
  agentsApply: "Apply changes",
  agentsDiscard: "Cancel",
  agentsUndo: "Undo the last change",
  agentsSelfTest: "Test the connection",
  agentsSelfTestOk: "Connection works ({ms} ms)",
  agentsSelfTestFailed: "Test failed ({code})",
  agentsSelfTestNotRun: "Not tested yet",
  agentsNoChanges: "The settings are up to date; nothing to change.",
  agentsConflicts: "Conflicts; no file was written:",
  agentsApplied: "{count} files updated. Restart the Agents.",
  agentsUndone: "The last change was undone.",
  agentsNothingToUndo: "There is no change to undo.",
  agentsFailed: "Not finished ({code}); what was written has been restored.",
  agentsManualRepair: "This file was changed after the apply and was not restored: {path}",
  agentsLauncherNotReady: "The App's runtime is not ready yet; finish the first-run setup, then try again.",
  agentsChange: { create: "New", update: "Changed", delete: "Removed" },
  agentsBusy: "Working…",
};

export function setupMessages(locale: ShellLocale): SetupMessages {
  return locale === "zh-TW" ? zhTW : en;
}
