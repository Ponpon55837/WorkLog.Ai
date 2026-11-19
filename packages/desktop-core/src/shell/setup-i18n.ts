import type { StoragePolicyRisk } from "../db-source/storage-policy.js";
import type { DbGroupStatus, DbSourceKind } from "../db-source/types.js";
import type { AgentDisplayState } from "../agents/status.js";
import type { AgentHookSource, AgentHookState, AgentRegistrationOwner, SetupAgentId } from "./agents-state.js";
import type { LegacyDisableStepText } from "../legacy-service/disable.js";
import type { CopyToLocalFailure } from "./copy-to-local.js";
import type { ShellLocale } from "./i18n.js";
import type { SystemSettingsTarget } from "../legacy-service/system-settings.js";

/**
 * Strings of the first-run page, the Agent page and the old-login-service warning. Kept apart from ShellMessages so the
 * tray and repair strings stay as they are; both languages must define all of it. zh-TW copy is short and plain.
 */
export interface SetupMessages {
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
  /** A found database is on storage that is never taken on one click (DT-08). */
  readonly setupUseThis: string;
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
  /** Heading of the hand-off for a service the App cannot turn off itself, and the steps for each OS place. */
  readonly legacyManualHeading: string;
  readonly legacyManualSteps: Readonly<Record<SystemSettingsTarget, readonly string[]>>;
  readonly legacyOpenSettings: Readonly<Record<SystemSettingsTarget, string>>;
  /** The OS place could not be opened; says where to find it by hand. */
  readonly legacyOpenFailed: Readonly<Record<SystemSettingsTarget, string>>;
  readonly legacyRecheck: string;
  /** The check after 「重新檢查」 still finds the service. */
  readonly legacyStillThere: string;
  readonly legacyStartAnyway: string;
  readonly legacyStartAnywayConfirm: string;
  readonly legacyBlocked: string;
  readonly legacyStartsAtLogin: string;
  readonly legacyDisable: string;
  readonly legacyDisableHeading: string;
  readonly legacyDisableIntro: string;
  readonly legacyDisableNotRunning: string;
  readonly legacyDisableGraceful: string;
  readonly legacyDisableHardStop: string;
  readonly legacyDisableSameDatabase: string;
  readonly legacyDisableBusy: string;
  readonly legacyDisableSteps: string;
  /** One plain sentence per step under 「詳細步驟」; never a command. */
  readonly legacyDisableStepText: LegacyDisableStepText;
  readonly legacyDisableConfirm: string;
  readonly legacyDisableConfirmBusy: string;
  readonly legacyDisableCancel: string;
  readonly legacyDisableDialog: string;
  readonly legacyDisableDone: string;
  readonly legacyDisableDoneStart: string;
  readonly legacyStartNow: string;
  readonly legacyDisableChanged: string;
  readonly legacyDisableStillRunning: string;
  readonly legacyDisableFailed: string;
  readonly legacyDisableFailedPartly: string;
  readonly legacyDisableCheckFailed: string;
  readonly legacyDisableCheckUnverified: string;
  readonly legacyDisableUnavailable: string;
  readonly legacyDisableBusyOther: string;
  readonly setupDetectingHint: string;
  readonly trayLegacyStatus: string;
  /** The backend could not bind its port and the old service is installed: say which one holds it. */
  readonly legacyPortInUse: string;
  readonly trayCompleteSetup: string;
  readonly setupDone: string;
  readonly setupOpenAgents: string;
  readonly setupClose: string;
  readonly agentsIntro: string;
  readonly agentNames: Readonly<Record<SetupAgentId, string>>;
  readonly agentStates: Readonly<Record<AgentDisplayState, string>>;
  readonly agentOwners: Readonly<Record<AgentRegistrationOwner, string>>;
  /** Hooks that work, by who manages them. */
  readonly agentHookInstalled: Readonly<Record<AgentHookSource, string>>;
  /** Hooks that are not working, by state. */
  readonly agentHookNotInstalled: Readonly<Record<Exclude<AgentHookState, "installed">, string>>;
  /** Hooks run from a source checkout keep working; moving them to the App is optional. */
  readonly agentsHookCheckoutNote: string;
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
  /** The checkbox on an Agent's card: whether the next preview sets this Agent up. */
  readonly agentsSelect: string;
  readonly agentsNotDetected: string;
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
  /** DT-08: what each kind of risky storage means, in plain words. `why` says what can go wrong, `todo` what to do. */
  readonly storageRisk: Readonly<Record<StoragePolicyRisk, StorageRiskText>>;
  /** `{label}`: a schema update on this database was refused because of where it is stored. */
  readonly storageMigrationBlocked: string;
  readonly storageRefused: string;
  readonly storageCopyToLocal: string;
  /** The native confirmation before the copy starts. */
  readonly copyConfirmMessage: string;
  readonly copyConfirmDetail: string;
  readonly copyConfirmYes: string;
  readonly copyConfirmNo: string;
  readonly copyWorking: string;
  readonly copyDone: string;
  readonly copyErrors: Readonly<Record<CopyToLocalFailure, string>>;
}

export interface StorageRiskText {
  /** Short name: 網路磁碟, 外接磁碟, 雲端同步資料夾, 硬連結, 無法確認磁碟類型. */
  readonly label: string;
  readonly why: string;
  readonly todo: string;
  /** The checkbox that must be ticked before this database may be used; `unknown` needs it only for a one-click choice. */
  readonly consent: string;
}

const zhTW: SetupMessages = {
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
  setupNextAgents: "接下來可以在「Agent」分頁連接 Codex 或 Claude Code。",
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
  legacyWarning: "偵測到舊的登入服務也在使用這份資料庫；同時執行兩個後端可能造成問題",
  legacyRunning: "目前正在執行。",
  legacyStopped: "目前沒有執行。",
  legacyUnknown: "無法確認是否正在執行。",
  legacyManualHeading: "自行停用舊的登入服務",
  legacyManualSteps: {
    "task-scheduler": [
      "按下方的「開啟工作排程器」。",
      "在左側選「工作排程器程式庫」，找到名為「Work Intelligence」的工作。",
      "在這個工作上按右鍵，選「停用」，或選「刪除」永久移除。",
      "回到這個視窗，按「重新檢查」。",
    ],
    "login-items": [
      "按下方的「開啟登入項目」。",
      "在「允許在背景執行」清單找到名為「Work Intelligence」、「node」或「ai.workintelligence.server」的項目，把它關閉。",
      "如果找不到，會改為開啟 LaunchAgents 資料夾；把「ai.workintelligence.server.plist」移到垃圾桶。",
      "回到這個視窗，按「重新檢查」。",
    ],
  },
  legacyOpenSettings: { "task-scheduler": "開啟工作排程器", "login-items": "開啟登入項目" },
  legacyOpenFailed: {
    "task-scheduler": "無法自動開啟。請在「開始」功能表搜尋「工作排程器」，再照上面的步驟操作。",
    "login-items": "無法自動開啟。請打開「系統設定」，到「一般」＞「登入項目與延伸功能」，再照上面的步驟操作。",
  },
  legacyRecheck: "重新檢查",
  legacyStillThere: "仍偵測到舊的登入服務。請確認已停用，再按一次「重新檢查」。",
  legacyStartAnyway: "仍要啟動",
  legacyStartAnywayConfirm: "確定要在舊服務也在執行時啟動嗎？兩個後端同時寫入同一份資料庫可能造成問題。",
  legacyBlocked: "為了避免兩個後端同時使用同一份資料庫，App 還沒有啟動自己的後端。",
  legacyStartsAtLogin: "下次登入時會啟動。",
  legacyDisable: "停用舊的登入服務…",
  legacyDisableHeading: "停用舊的登入服務",
  legacyDisableIntro:
    "這會停下舊的登入服務，並移除它在登入時自動啟動的設定，之後改由這個 App 管理。資料庫和備份都不會被刪除。",
  legacyDisableNotRunning: "舊服務目前沒有在執行，只會移除它在登入時自動啟動的設定。",
  legacyDisableGraceful: "舊服務會先把手上的工作完成再停下。",
  legacyDisableHardStop: "正在執行的舊服務會被立即結束；已儲存的資料不受影響，正在寫入的一筆可能需要重做。",
  legacyDisableSameDatabase: "停下之後，App 會先檢查這份資料庫，沒有問題才會使用。",
  legacyDisableBusy: "舊服務可能正在匯入或備份，建議稍後再停用。",
  legacyDisableSteps: "詳細步驟",
  legacyDisableStepText: {
    stopTask: "停止排程工作「{name}」",
    removeTask: "移除排程工作「{name}」",
    endRunners: "結束舊服務還在執行的程序",
    stopService: "停止舊服務「{name}」，並移除它在登入時自動啟動的設定",
    checkStopped: "確認舊服務已經停止、不會再自動啟動",
    refreshService: "讓系統重新讀取服務清單",
    deleteFile: "刪除檔案 {path}",
    other: "清理舊服務留下的設定",
  },
  legacyDisableConfirm: "停用",
  legacyDisableConfirmBusy: "仍要停用",
  legacyDisableCancel: "取消",
  legacyDisableDialog: "確定要停用舊的登入服務嗎？",
  legacyDisableDone: "舊的登入服務已停用。",
  legacyDisableDoneStart: "舊的登入服務已停用。現在可以啟動這個 App 的服務。",
  legacyStartNow: "立即啟動",
  legacyDisableChanged: "舊服務的設定在檢查之後有變動，所以沒有做任何更改。請再按一次「停用舊的登入服務…」。",
  legacyDisableStillRunning: "舊服務沒有及時停下，所以還沒有移除它的設定。請稍後再試一次。",
  legacyDisableFailed: "停用沒有完成，也沒有移除任何設定。請依下方的步驟自行停用。",
  legacyDisableFailedPartly: "停用只完成了一部分。請依下方的步驟完成停用。",
  legacyDisableCheckFailed: "舊服務已停用，但資料庫檢查沒有通過，App 沒有開啟它。請在「狀態」分頁處理。",
  legacyDisableCheckUnverified:
    "舊的登入服務已停用，但這次沒能完成資料庫檢查（資料庫可能暫時被占用），所以沒有立即啟動。請稍後重新開啟 App。",
  legacyDisableUnavailable: "這個服務無法由 App 停用，請依下方的步驟自行停用。",
  legacyDisableBusyOther: "另一個操作正在進行，請稍後再試。",
  setupDetectingHint: "正在檢查…完成後即可使用",
  trayLegacyStatus: "偵測到舊的登入服務也使用這份資料庫，未自動啟動",
  legacyPortInUse: "連接埠已被舊的登入服務使用。請先停用舊服務，再重試。",
  trayCompleteSetup: "完成首次設定…",
  setupDone: "已可以開始使用。Dashboard 已開啟。",
  setupOpenAgents: "設定 Agent…",
  setupClose: "關閉",
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
  agentHookInstalled: {
    app: "已安裝（由 App 管理）",
    checkout: "已安裝（由 checkout 管理）",
    plugin: "已安裝（由 plugin 管理）",
  },
  agentHookNotInstalled: { stale: "需要更新", missing: "未設定", disabled: "已停用", unknown: "無法判斷" },
  agentsHookCheckoutNote:
    "checkout 的 hook 設定仍然有效。「改由桌面 App 管理…」是選用的；改用後，移動 checkout、更換 Node 或更新 App 都不必重新設定。",
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
  agentsSelect: "設定這個 Agent",
  agentsNotDetected: "這台電腦上沒有找到它的設定資料夾，預設不會設定。要設定請勾選上面的選項。",
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
  storageRisk: {
    network: {
      label: "網路磁碟",
      why: "這份資料庫放在網路磁碟上。SQLite 在網路磁碟上可能損壞資料，所以 App 不會使用它。",
      todo: "請先把資料庫複製到這台電腦的本機磁碟，再選擇複製後的檔案。",
      consent: "",
    },
    removable: {
      label: "外接磁碟",
      why: "這份資料庫放在外接磁碟上。磁碟被拔掉或休眠時，寫到一半的資料可能損壞。",
      todo: "建議複製到本機磁碟。若仍要使用，請先勾選下方的確認。",
      consent: "我知道這份資料庫在外接磁碟上，拔掉磁碟可能損壞資料，仍要使用。",
    },
    "cloud-sync": {
      label: "雲端同步資料夾",
      why: "這份資料庫放在雲端同步資料夾裡。同步程式可能在寫入到一半時上傳或改動檔案，造成資料損壞或衝突的副本。",
      todo: "建議複製到本機磁碟。若仍要使用，請先勾選下方的確認。",
      consent: "我知道這份資料庫在雲端同步資料夾裡，同步可能損壞資料，仍要使用。",
    },
    "hard-link": {
      label: "硬連結",
      why: "這個檔案有其他名稱（硬連結）指向同一份內容。備份或還原時，可能改到別處的檔案。",
      todo: "建議複製成一個獨立的檔案。若仍要使用，請先勾選下方的確認。",
      consent: "我知道這份資料庫是硬連結，仍要使用。",
    },
    unknown: {
      label: "無法確認磁碟類型",
      why: "App 無法確認這份資料庫放在哪種磁碟上（可能是網路磁碟或外接磁碟）。",
      todo: "如果它在這台電腦的本機磁碟上，可以放心使用。",
      consent: "我知道無法確認磁碟類型，仍要使用。",
    },
  },
  storageMigrationBlocked: "這份資料庫在{label}上，所以不會更新它的格式。請改用「複製到本機磁碟並改用」。",
  storageRefused: "App 不會使用這份資料庫。",
  storageCopyToLocal: "複製到本機磁碟並改用",
  copyConfirmMessage: "要把這份資料庫複製到本機磁碟並改用嗎？",
  copyConfirmDetail:
    "App 會把它複製到預設的資料資料夾，改用複製後的檔案，並更新複製後檔案的格式。原本的檔案不會被改動，也不會被刪除。",
  copyConfirmYes: "複製並改用",
  copyConfirmNo: "取消",
  copyWorking: "正在複製…",
  copyDone: "已改用本機磁碟上的副本。原本的檔案沒有被改動。已經開著的 Agent 仍會寫入原本的檔案，請關閉後重新開啟。",
  copyErrors: {
    "no-space": "本機磁碟的可用空間不夠，沒有複製。請清出空間後再試。",
    "target-exists": "複製的目標檔名已經存在，沒有覆蓋任何檔案。請再試一次。",
    "target-risky":
      "App 的預設資料資料夾本身在網路磁碟、外接磁碟或雲端同步資料夾上，複製過去不會更安全，所以沒有複製。",
    "integrity-failed": "複製後的檢查沒有通過，所以沒有使用它。原本的檔案沒有被改動。",
    "copy-failed": "複製沒有完成。原本的檔案沒有被改動。",
    "start-failed": "已複製，但改用後無法啟動，設定已維持原樣，副本也已移除。原本的檔案沒有被改動。",
  },
};

const en: SetupMessages = {
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
  setupNextAgents: "Next, connect Codex or Claude Code in the Agent tab.",
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
  legacyWarning: "The old login service also uses this database; running two backends at once can cause problems",
  legacyRunning: "It is running now.",
  legacyStopped: "It is not running now.",
  legacyUnknown: "Whether it is running cannot be told.",
  legacyManualHeading: "Turn off the old login service yourself",
  legacyManualSteps: {
    "task-scheduler": [
      "Press “Open Task Scheduler” below.",
      "In the left pane choose “Task Scheduler Library” and find the task named “Work Intelligence”.",
      "Right-click that task and choose “Disable”, or “Delete” to remove it for good.",
      "Come back to this window and press “Check again”.",
    ],
    "login-items": [
      "Press “Open Login Items” below.",
      "In the “Allow in the Background” list, find the item named “Work Intelligence”, “node” or “ai.workintelligence.server” and turn it off.",
      "If you cannot find it, the LaunchAgents folder opens instead; move “ai.workintelligence.server.plist” to the Trash.",
      "Come back to this window and press “Check again”.",
    ],
  },
  legacyOpenSettings: { "task-scheduler": "Open Task Scheduler", "login-items": "Open Login Items" },
  legacyOpenFailed: {
    "task-scheduler":
      "It could not be opened automatically. Search for “Task Scheduler” in the Start menu, then follow the steps above.",
    "login-items":
      "It could not be opened automatically. Open System Settings, go to General > Login Items & Extensions, then follow the steps above.",
  },
  legacyRecheck: "Check again",
  legacyStillThere: "The old login service is still found. Make sure it is turned off, then press “Check again”.",
  legacyStartAnyway: "Start anyway",
  legacyStartAnywayConfirm:
    "Start while the old service may be running? Two backends writing to one database can cause problems.",
  legacyBlocked: "To keep two backends off one database, the App has not started its own backend yet.",
  legacyStartsAtLogin: "It will start at the next login.",
  legacyDisable: "Turn off the old login service…",
  legacyDisableHeading: "Turn off the old login service",
  legacyDisableIntro:
    "This stops the old login service and removes its start-at-login setting, so this App takes over. No database or backup is deleted.",
  legacyDisableNotRunning: "The old service is not running now; only its start-at-login setting is removed.",
  legacyDisableGraceful: "The old service finishes what it is doing before it stops.",
  legacyDisableHardStop:
    "The running old service is ended at once; saved data is not affected, but an entry being written may have to be redone.",
  legacyDisableSameDatabase: "Once it has stopped, the App checks this database before using it.",
  legacyDisableBusy: "The old service may be importing or backing up. It is better to turn it off later.",
  legacyDisableSteps: "Detailed steps",
  legacyDisableStepText: {
    stopTask: "Stop the scheduled task “{name}”",
    removeTask: "Remove the scheduled task “{name}”",
    endRunners: "End the programs the old service is still running",
    stopService: "Stop the old service “{name}” and remove its start-at-login setting",
    checkStopped: "Check that the old service is stopped and will not start again by itself",
    refreshService: "Let the system read its service list again",
    deleteFile: "Delete the file {path}",
    other: "Clean up what the old service left behind",
  },
  legacyDisableConfirm: "Turn off",
  legacyDisableConfirmBusy: "Turn off anyway",
  legacyDisableCancel: "Cancel",
  legacyDisableDialog: "Turn off the old login service?",
  legacyDisableDone: "The old login service is turned off.",
  legacyDisableDoneStart: "The old login service is turned off. You can start this App's service now.",
  legacyStartNow: "Start now",
  legacyDisableChanged:
    "The old service's setup changed after it was checked, so nothing was changed. Press “Turn off the old login service…” again.",
  legacyDisableStillRunning:
    "The old service did not stop in time, so its setup was not removed yet. Try again in a moment.",
  legacyDisableFailed:
    "Turning it off did not finish and nothing was removed. Follow the steps below to turn it off yourself.",
  legacyDisableFailedPartly: "Turning it off only partly finished. Follow the steps below to finish turning it off.",
  legacyDisableCheckFailed:
    "The old service is turned off, but the database did not pass its check, so the App did not open it. Continue in the Status tab.",
  legacyDisableCheckUnverified:
    "The old login service is turned off, but the database check could not finish this time (the database may be in use), so nothing was started. Open the App again later.",
  legacyDisableUnavailable: "The App cannot turn this service off. Follow the steps below to turn it off yourself.",
  legacyDisableBusyOther: "Another operation is running. Try again in a moment.",
  setupDetectingHint: "Checking… available when done",
  trayLegacyStatus: "The old login service also uses this database; the App did not start automatically",
  legacyPortInUse: "The port is used by the old login service. Turn it off first, then try again.",
  trayCompleteSetup: "Finish setup…",
  setupDone: "You are ready to go. The Dashboard is open.",
  setupOpenAgents: "Set up Agents…",
  setupClose: "Close",
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
  agentHookInstalled: {
    app: "Installed (managed by the App)",
    checkout: "Installed (managed by the checkout)",
    plugin: "Installed (managed by the plugin)",
  },
  agentHookNotInstalled: {
    stale: "Needs an update",
    missing: "Not set up",
    disabled: "Disabled",
    unknown: "Cannot tell",
  },
  agentsHookCheckoutNote:
    "The checkout's hook setup keeps working. “Let the desktop App manage it…” is optional; afterwards, moving the checkout, changing Node or updating the App no longer needs a new setup.",
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
  agentsSelect: "Set up this Agent",
  agentsNotDetected:
    "Its settings folder was not found on this computer, so it is not set up by default. Tick the box above to set it up.",
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
  storageRisk: {
    network: {
      label: "Network drive",
      why: "This database is on a network drive. SQLite can corrupt data there, so the App will not use it.",
      todo: "Copy the database to a local disk on this computer first, then choose the copy.",
      consent: "",
    },
    removable: {
      label: "External drive",
      why: "This database is on an external drive. If the drive is unplugged or goes to sleep, a half-written change can corrupt it.",
      todo: "Copying it to a local disk is recommended. To use it anyway, tick the confirmation below first.",
      consent: "I know this database is on an external drive and unplugging it can corrupt the data. Use it anyway.",
    },
    "cloud-sync": {
      label: "Cloud-sync folder",
      why: "This database is in a cloud-sync folder. The sync app can upload or change the file halfway through a write, which can corrupt it or create conflicting copies.",
      todo: "Copying it to a local disk is recommended. To use it anyway, tick the confirmation below first.",
      consent: "I know this database is in a cloud-sync folder and syncing can corrupt the data. Use it anyway.",
    },
    "hard-link": {
      label: "Hard link",
      why: "This file has other names (hard links) pointing at the same content. A backup or restore may change a file somewhere else.",
      todo: "Copying it to a separate file is recommended. To use it anyway, tick the confirmation below first.",
      consent: "I know this database is a hard link. Use it anyway.",
    },
    unknown: {
      label: "Disk type unknown",
      why: "The App could not tell what kind of disk this database is on (it might be a network or external drive).",
      todo: "If it is on a local disk of this computer, it is fine to use.",
      consent: "I know the disk type could not be confirmed. Use it anyway.",
    },
  },
  storageMigrationBlocked:
    "This database is on a {label}, so its format will not be updated. Use “Copy to local disk and switch” instead.",
  storageRefused: "The App will not use this database.",
  storageCopyToLocal: "Copy to local disk and switch",
  copyConfirmMessage: "Copy this database to the local disk and switch to the copy?",
  copyConfirmDetail:
    "The App copies it to its default data folder, switches to the copy, and updates the format of the copy. The original file is not changed or deleted.",
  copyConfirmYes: "Copy and switch",
  copyConfirmNo: "Cancel",
  copyWorking: "Copying…",
  copyDone:
    "Now using the copy on the local disk. The original file was not changed. Agents that are already open keep writing to the original; close and reopen them.",
  copyErrors: {
    "no-space": "The local disk does not have enough free space, so nothing was copied. Free some space and try again.",
    "target-exists": "The name for the copy already exists, so nothing was overwritten. Please try again.",
    "target-risky":
      "The App's default data folder is itself on a network drive, a removable drive or a cloud-sync folder, so a copy there would be no safer and nothing was copied.",
    "integrity-failed": "The copy did not pass its check, so it was not used. The original file was not changed.",
    "copy-failed": "The copy did not finish. The original file was not changed.",
    "start-failed":
      "The copy was made but could not be started, so the settings stay as they were and the copy was removed. The original file was not changed.",
  },
};

export function setupMessages(locale: ShellLocale): SetupMessages {
  return locale === "zh-TW" ? zhTW : en;
}
