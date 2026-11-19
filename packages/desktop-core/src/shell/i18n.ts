import type { BackendErrorCode } from "../backend/errors.js";
import type { OperationKind, RecoveryNoticeKind } from "../operations/journal-record.js";
import type { AppTab } from "./app-tabs.js";
import type { RepairBusyReason, RepairBusyWhat } from "./repair-busy.js";

/** Languages the shell speaks: Traditional Chinese for any `zh-*` locale, English for everything else. */
export type ShellLocale = "zh-TW" | "en";

/** Codes of failures that happen in the shell itself, before or around the backend child. */
export type ShellErrorCode =
  | "RUNTIME_INSTALL_FAILED"
  /** Windows: an Agent still runs from the runtime folder that has to be replaced (M-08). */
  | "RUNTIME_IN_USE"
  | "RUNTIME_UNSAFE_PERMISSIONS"
  | "RUNTIME_ACL_UNREADABLE"
  | "LEGACY_SERVICE_ACTIVE"
  | "DB_INTEGRITY_CHECK_FAILED"
  /** The database is on a network drive (DT-08): the App stops and does not use it. */
  | "DB_STORAGE_NETWORK"
  /** The diagnostics file was not made: a last check still found a secret or a path in it (DT-19). Nothing was written. */
  | "DIAGNOSTICS_SCAN_FAILED";

/** One error code as the user reads it: what happened and what to try. */
export interface ErrorMessage {
  readonly title: string;
  readonly hint: string;
}

/** Every string of the tray, the quit confirmation and the repair window. Both languages must define all of it. */
export interface ShellMessages {
  readonly appName: string;
  readonly trayOpenDashboard: string;
  /** Opens the App window; `{name}` is `appName`. */
  readonly trayOpenApp: string;
  readonly trayQuit: string;
  /** `{reason}` is one of the `trayReason*` texts. */
  readonly trayDisabledTemplate: string;
  readonly trayReasonStarting: string;
  readonly trayReasonNeedsRepair: string;
  readonly trayReasonStopped: string;
  readonly trayTooltipManaged: string;
  readonly trayTooltipNeedsRepair: string;
  /** `{location}` is the platform's name for the tray area. */
  readonly trayBackgroundHint: string;
  readonly trayLocationMac: string;
  readonly trayLocationWindows: string;
  readonly trayLocationOther: string;
  /** The window's tab labels, in the page's language. */
  readonly tabLabels: Readonly<Record<AppTab, string>>;
  /** Accessible name of the tab strip. */
  readonly tabListLabel: string;
  /** Spoken after a tab's name when it has the attention dot or the busy mark. */
  readonly tabAttentionLabel: string;
  readonly tabBusyLabel: string;
  /** The Status tab's one-line database state links to the Data tab with this text. */
  readonly statusOpenData: string;
  /** The banner about an operation a crash interrupted (what happened, what to do, how to dismiss it). */
  readonly recoveryHeading: string;
  /** `{port}` is the port in use, `{attempted}` the one the interrupted change was moving to, `{operation}` its name. */
  readonly recoveryNotices: Readonly<Record<RecoveryNoticeKind, string>>;
  /** What the user can do next; names the tab and the button where that is. */
  readonly recoveryNextSteps: Readonly<Record<RecoveryNoticeKind, string>>;
  readonly recoveryOperationNames: Readonly<Record<OperationKind, string>>;
  /** `{tab}` is the tab's label. */
  readonly recoveryOpenTab: string;
  readonly recoveryDismiss: string;
  /** macOS menu bar: `{name}` is `appName`. */
  readonly menuAbout: string;
  readonly menuEdit: string;
  readonly menuWindow: string;
  readonly menuCloseWindow: string;
  readonly quitTitle: string;
  readonly quitMessage: string;
  /** `{time}` is the local time of the last successful backup. */
  readonly quitLastBackup: string;
  readonly quitNoBackup: string;
  readonly quitUnknownBackup: string;
  readonly quitConfirm: string;
  readonly quitCancel: string;
  readonly notifyTitle: string;
  /** The native error box shown when the App cannot even find its data folder and must close. */
  readonly startupFailedTitle: string;
  readonly startupFailedMessage: string;
  /** The operations journal was written by a newer App: nothing is started on it and nothing is changed. */
  readonly journalNewerVersion: string;
  /** `{title}` is the error title. */
  readonly notifyBody: string;
  readonly repairIntro: string;
  readonly repairServiceHeading: string;
  readonly repairDatabaseHeading: string;
  readonly repairErrorsHeading: string;
  readonly repairNoErrors: string;
  readonly repairNoDatabase: string;
  readonly repairCandidates: string;
  readonly repairConfirmCandidate: string;
  readonly repairBusy: string;
  /** Another operation holds the App (a restart, an import, a backup, a port change): not an error, try again later. */
  readonly repairBusyOperation: string;
  /** Names what holds the App, as a gerund phrase for `repairBusyNamed`. */
  readonly repairBusyWhat: Readonly<Record<RepairBusyWhat, string>>;
  /** `{what}` is one of `repairBusyWhat`. */
  readonly repairBusyNamed: string;
  /** The Dashboard itself is importing, backing up or exporting. */
  readonly repairBusyActivity: string;
  /** The App could not tell whether the Dashboard is working on data. */
  readonly repairBusyUnknown: string;
  /** Confirm button for a database whose schema must be updated; pressing it is the user's consent. */
  readonly repairConfirmMigrate: string;
  readonly repairMigrationNote: string;
  readonly repairCandidateNotUsable: string;
  /** Shown when the App exits without proof that the backend stopped (never in background mode). */
  readonly quitStopIncompleteTitle: string;
  readonly quitStopIncompleteMessage: string;
  readonly quitStopIncompleteOk: string;
  readonly repairDone: string;
  /** After the App's database was changed: Agents that are already open keep writing to the old one (M-07). */
  readonly databaseChangedDone: string;
  /** Heading of the card the repair window shows once a repair the user started has worked. */
  readonly repairRecovered: string;
  readonly repairRecoveredHint: string;
  /** `{count}` is the number of projects in the database. */
  readonly repairProjectCount: string;
  readonly repairProjectCountLabel: string;
  /** The system notification that says the App can be used again. */
  readonly notifyRecoveredTitle: string;
  readonly notifyRecoveredBody: string;
  readonly repairFailedGeneric: string;
  readonly actionRetry: string;
  readonly actionChooseDatabase: string;
  readonly actionOpenDatabaseFolder: string;
  readonly actionOpenBackups: string;
  readonly actionOpenLogs: string;
  readonly actionExport: string;
  /** Shown instead of a diff when a file is too large to compare. */
  readonly agentsTooLargeNote: string;
  /** The box the user ticks before applying a preview that has a file without a shown diff. */
  readonly agentsAckUndiffable: string;
  /** The LEGACY_SERVICE_ACTIVE hint when the page has no "start anyway" button for the database that was refused. */
  readonly legacyActiveNoOverrideHint: string;
  readonly ownerLabel: string;
  readonly backendLabel: string;
  readonly databaseStatusLabel: string;
  readonly lastBackupLabel: string;
  readonly owners: Readonly<Record<string, string>>;
  readonly backends: Readonly<Record<string, string>>;
  readonly databaseStatuses: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<BackendErrorCode | ShellErrorCode, ErrorMessage>>;
}

const zhTW: ShellMessages = {
  appName: "Work Intelligence",
  trayOpenDashboard: "開啟 Dashboard",
  trayOpenApp: "開啟 {name}…",
  trayQuit: "退出（退出後不會每日備份）",
  trayDisabledTemplate: "{label}（{reason}）",
  trayReasonStarting: "服務啟動中",
  trayReasonNeedsRepair: "服務需要修復",
  trayReasonStopped: "服務未執行",
  trayTooltipManaged: "Work Intelligence：服務執行中",
  trayTooltipNeedsRepair: "Work Intelligence：需要修復",
  trayBackgroundHint: "Work Intelligence 會在{location}繼續執行。",
  trayLocationMac: "選單列",
  trayLocationWindows: "通知區",
  trayLocationOther: "系統匣",
  tabLabels: { setup: "首次設定", status: "狀態", agent: "Agent", settings: "設定", data: "資料", diagnostics: "診斷" },
  tabListLabel: "Work Intelligence 分頁",
  tabAttentionLabel: "需要處理",
  tabBusyLabel: "進行中",
  statusOpenData: "前往「資料」分頁",
  recoveryHeading: "上次被中斷的操作",
  recoveryNotices: {
    "journal-unreadable":
      "App 上次留下的操作紀錄無法讀取，已移到一旁。這代表更早之前被中斷的操作（例如切換資料庫或還原備份）可能沒有完成，App 無法確認資料目前處於哪個狀態，所以先沒有自動啟動服務，也沒有改動任何資料。",
    "port-kept":
      "上次變更連接埠時 App 被中斷，已確認仍使用原連接埠 {port}。新的連接埠 {attempted} 沒有生效，資料沒有被改動。",
    "port-applied": "上次變更連接埠時 App 被中斷，但新的連接埠 {port} 已經生效。",
    "db-kept": "上次切換資料庫時 App 被中斷，切換沒有生效，仍使用原本的資料庫，資料沒有被改動。",
    "db-applied": "上次切換資料庫時 App 被中斷，但切換已經完成，現在使用的是你選的資料庫。",
    "copy-removed": "上次複製資料庫到本機磁碟時 App 被中斷，已清除未完成的副本，原本的資料庫沒有被改動。",
    "legacy-present": "上次停用舊的登入服務時 App 被中斷，舊的登入服務仍在，App 沒有動它。",
    "legacy-disabled": "上次停用舊的登入服務時 App 被中斷，但舊的登入服務已經停用。",
    "agent-interrupted": "上次設定 Agent 時 App 被中斷，未完成的變更已經還原或補完。",
    "needs-repair":
      "上次{operation}時 App 被中斷，無法確認資料目前處於哪個狀態，所以 App 先沒有自動啟動服務，也沒有改動任何資料。",
  },
  recoveryNextSteps: {
    "journal-unreadable":
      "請在「狀態」分頁確認服務與資料庫是否正常；如果資料看起來不對，可以到「資料」分頁選擇資料庫，或從備份還原。",
    "port-kept": "想改用新的連接埠，可以到「設定」分頁再變更一次。",
    "port-applied": "可以到「設定」分頁確認目前的連接埠。",
    "db-kept": "想改用另一個資料庫，可以到「資料」分頁再選一次。",
    "db-applied": "可以到「資料」分頁確認目前使用的資料庫。",
    "copy-removed": "想再複製一次，可以到「資料」分頁按「複製到本機磁碟並改用」。",
    "legacy-present": "想再試一次，可以在「狀態」分頁按「停用舊的登入服務…」。",
    "legacy-disabled": "不需要再做任何事。",
    "agent-interrupted": "請到「Agent」分頁確認各 Agent 的狀態，需要時再設定一次。",
    "needs-repair": "請在「狀態」分頁按「重試啟動」；若仍無法啟動，可以到「資料」分頁選擇資料庫。",
  },
  recoveryOperationNames: {
    takeover: "啟動服務",
    restart: "重新啟動服務",
    "change-port": "變更連接埠",
    "change-db": "切換資料庫",
    "apply-agent": "設定 Agent",
    restore: "還原資料庫",
    maintenance: "整理資料庫",
    "legacy-disable": "停用舊的登入服務",
  },
  recoveryOpenTab: "前往「{tab}」分頁",
  recoveryDismiss: "知道了",
  menuAbout: "關於 {name}",
  menuEdit: "編輯",
  menuWindow: "視窗",
  menuCloseWindow: "關閉視窗",
  quitTitle: "退出 Work Intelligence？",
  quitMessage: "退出後不會每日備份。",
  quitLastBackup: "最後成功備份：{time}",
  quitNoBackup: "尚無成功備份",
  quitUnknownBackup: "無法確認最後成功備份的時間",
  quitConfirm: "退出",
  quitCancel: "取消",
  notifyTitle: "Work Intelligence 需要處理",
  startupFailedTitle: "Work Intelligence 無法啟動",
  startupFailedMessage:
    "找不到這個使用者的應用程式資料夾（Windows 為 AppData），App 必須關閉，資料沒有任何變更。請確認使用者設定檔完整後再開啟。",
  journalNewerVersion:
    "這個資料夾的操作紀錄是由較新版本的 Work Intelligence 寫入的，這個版本無法讀取。為了不影響資料，App 沒有自動啟動服務，也沒有改動任何資料。請先更新 App，再開啟一次。",
  notifyBody: "{title}。請開啟 App 的「狀態」分頁。",
  repairIntro: "服務沒有正常執行。你的資料沒有被改動；下面列出目前的狀況和可以做的事。",
  repairServiceHeading: "服務",
  repairDatabaseHeading: "資料庫",
  repairErrorsHeading: "最近的錯誤",
  repairNoErrors: "沒有紀錄到錯誤。",
  repairNoDatabase: "尚未設定資料庫。",
  repairCandidates: "你選擇的資料庫",
  repairConfirmCandidate: "使用這個資料庫並重試",
  repairBusy: "處理中…",
  repairBusyOperation: "App 正在處理另一項操作，請稍後再試。",
  repairBusyWhat: {
    takeover: "啟動服務",
    restart: "重新啟動服務",
    "change-port": "變更連接埠",
    "change-db": "切換資料庫",
    "apply-agent": "設定 Agent",
    restore: "還原備份",
    maintenance: "整理資料庫",
    "legacy-disable": "停用舊的登入服務",
    "copy-to-local": "複製資料庫到本機磁碟",
    "login-item": "變更登入時自動啟動",
    "backup-directory": "更換備份位置",
  },
  repairBusyNamed: "App 正在{what}，請等它完成後再試。沒有變更任何資料。",
  repairBusyActivity: "Dashboard 正在匯入、備份或匯出資料，請等它完成後再試。沒有變更任何資料。",
  repairBusyUnknown: "暫時無法確認 Dashboard 是否正在處理資料，請稍後再試。沒有變更任何資料。",
  repairConfirmMigrate: "同意更新資料庫結構，使用這個資料庫並重試",
  repairMigrationNote: "這個資料庫需要更新結構才能使用；更新前會先備份。",
  repairCandidateNotUsable: "這個資料庫目前不能使用。",
  quitStopIncompleteTitle: "背景服務可能仍在執行",
  quitStopIncompleteMessage:
    "無法確認 Work Intelligence 的背景服務已完全停止。若稍後仍無法重新開啟，請在工作管理員或活動監視器中結束它，或重新啟動電腦。細節已寫入記錄檔。",
  quitStopIncompleteOk: "知道了",
  repairDone: "已完成。",
  databaseChangedDone: "已完成。已經開著的 Agent 仍會寫入原本的資料庫，請關閉後重新開啟，才會改用新的。",
  repairRecovered: "✓ 已恢復",
  repairRecoveredHint: "資料庫已可使用，正在為你開啟 Dashboard。",
  repairProjectCount: "{count} 個專案",
  repairProjectCountLabel: "專案數",
  notifyRecoveredTitle: "Work Intelligence 已可使用",
  notifyRecoveredBody: "資料庫已恢復，正在開啟 Dashboard。",
  repairFailedGeneric: "這個動作沒有完成，請再試一次。",
  actionRetry: "重試啟動",
  actionChooseDatabase: "選擇資料庫…",
  actionOpenDatabaseFolder: "開啟資料庫資料夾",
  actionOpenBackups: "開啟備份資料夾",
  actionOpenLogs: "開啟紀錄資料夾",
  actionExport: "匯出診斷資訊…",
  agentsTooLargeNote: "檔案過大，無法顯示差異",
  agentsAckUndiffable: "我了解有檔案無法顯示差異",
  legacyActiveNoOverrideHint:
    "為了避免兩個後端同時使用同一份資料庫，App 沒有啟動自己的後端。請在「狀態」分頁停用舊的登入服務，或改選另一份資料庫。",
  ownerLabel: "服務狀態",
  backendLabel: "背景程序",
  databaseStatusLabel: "資料庫狀態",
  lastBackupLabel: "最後成功備份",
  owners: {
    UNCONFIGURED: "尚未設定",
    EXTERNAL: "由外部管理",
    PREPARING: "準備中",
    QUIESCING: "停止舊服務中",
    STARTING: "啟動中",
    MANAGED: "由本 App 管理",
    NEEDS_REPAIR: "需要修復",
  },
  backends: { running: "執行中", starting: "啟動中", stopped: "未執行", crashed: "意外結束" },
  databaseStatuses: {
    ok: "可以使用",
    missing: "找不到檔案",
    offline: "儲存位置離線",
    denied: "沒有讀取權限",
    unreadable: "無法讀取",
    "unsupported-schema": "版本不支援",
    unknown: "尚未檢查",
  },
  errors: {
    LEGACY_SERVICE_ACTIVE: {
      title: "舊的登入服務也在使用這份資料庫",
      hint: "為了避免兩個後端同時使用同一份資料庫，App 沒有啟動自己的後端。請在「狀態」分頁停用舊的登入服務，或對目前的資料庫選擇「仍要啟動」。",
    },
    DB_MISSING: {
      title: "找不到資料庫檔案",
      hint: "檔案可能被移動或刪除。請選擇資料庫，或到「資料」分頁 → 「從備份還原」。",
    },
    DB_OFFLINE: { title: "資料庫所在的儲存位置離線", hint: "請接上外接硬碟或網路磁碟後重試。" },
    DB_PERMISSION: { title: "沒有權限讀取資料庫", hint: "請確認檔案的存取權限後重試。" },
    DB_IDENTITY_CHANGED: { title: "資料庫已不是先前確認的那一份", hint: "檔案可能被取代。請重新選擇並確認資料庫。" },
    DB_INTEGRITY_CHECK_FAILED: {
      title: "資料庫檢查沒有通過",
      hint: "舊的登入服務停下後，這份資料庫的檢查發現問題，App 沒有開啟它。請到「資料」分頁 → 「從備份還原」，或選擇另一份資料庫。",
    },
    DB_STORAGE_NETWORK: {
      title: "資料庫放在網路磁碟上",
      hint: "SQLite 在網路磁碟上可能損壞資料，所以 App 沒有使用它。請把資料庫複製到這台電腦的本機磁碟，再選擇複製後的檔案。",
    },
    DIAGNOSTICS_SCAN_FAILED: {
      title: "無法產生診斷資訊",
      hint: "最後的檢查仍發現可能的個人資訊或授權碼，為了安全沒有產生檔案。請回報這個代碼，不要附上原始記錄。",
    },
    SCHEMA_TOO_NEW: { title: "資料庫比這個版本新", hint: "請更新 Work Intelligence 後重試。" },
    SCHEMA_MIGRATION_BLOCKED: { title: "資料庫需要更新但沒有完成", hint: "你的資料沒有被改動。請查看備份後重試。" },
    PORT_OCCUPIED_BY_OTHER: {
      title: "連接埠被其他程式占用",
      hint: "請關閉占用的程式，或在「設定」分頁的「連接埠」區塊換一個連接埠。",
    },
    PORT_NOT_PERMITTED: {
      title: "系統不允許使用這個連接埠",
      hint: "作業系統沒有讓 Work Intelligence 使用這個連接埠（例如 Windows 保留的連接埠範圍）。請在「連接埠」區塊換一個連接埠。",
    },
    PORT_NOT_RELEASED: { title: "連接埠尚未釋放", hint: "稍等幾秒後重試。" },
    RUNTIME_MISSING: { title: "找不到執行環境", hint: "安裝可能不完整。請重新安裝 Work Intelligence。" },
    RUNTIME_UNSAFE_PERMISSIONS: {
      title: "執行環境資料夾的權限不安全",
      hint: "Work Intelligence 的執行環境資料夾允許其他帳號修改，為了安全不會啟動。請重新安裝 Work Intelligence，或請系統管理員還原資料夾權限（只保留你自己、SYSTEM 與系統管理員可寫入）後再試。",
    },
    RUNTIME_ACL_UNREADABLE: {
      title: "無法檢查執行環境資料夾的權限",
      hint: "無法讀取資料夾權限（PowerShell 可能被原則封鎖或逾時），所以沒有啟動服務。請確認 PowerShell 可以執行，或請系統管理員協助後重試；你的資料沒有被改動。",
    },
    RUNTIME_POINTER_MISSING: {
      title: "找不到執行環境的版本指標",
      hint: "安裝可能不完整。請重新安裝 Work Intelligence。",
    },
    RUNTIME_POINTER_INVALID: {
      title: "執行環境的版本指標無效",
      hint: "指標檔案可能已損毀。請重新安裝 Work Intelligence。",
    },
    RUNTIME_MANIFEST_INVALID: {
      title: "執行環境的清單無效",
      hint: "清單檔案可能已損毀。請重新安裝 Work Intelligence。",
    },
    RUNTIME_FILE_MISSING: {
      title: "執行環境缺少檔案",
      hint: "有檔案被刪除或安裝不完整。請重新安裝 Work Intelligence。",
    },
    RUNTIME_FILE_UNEXPECTED: {
      title: "執行環境多了不明的檔案",
      hint: "資料夾內有不屬於安裝內容的檔案。請重新安裝 Work Intelligence。",
    },
    RUNTIME_FILE_TAMPERED: {
      title: "執行環境的檔案內容已被改動",
      hint: "檔案與安裝時不一致，為了安全不會啟動。請重新安裝 Work Intelligence。",
    },
    RUNTIME_SYMLINK_REJECTED: {
      title: "執行環境含有不允許的捷徑",
      hint: "為了安全不會啟動。請重新安裝 Work Intelligence。",
    },
    RUNTIME_ACTION_NOT_ALLOWED: {
      title: "執行環境不允許這個動作",
      hint: "請更新或重新安裝 Work Intelligence 後再試。",
    },
    RUNTIME_KIND_NOT_ALLOWED: {
      title: "不允許這種執行環境",
      hint: "請更新或重新安裝 Work Intelligence 後再試。",
    },
    RUNTIME_ALREADY_INSTALLED: {
      title: "這個執行環境已經安裝",
      hint: "請重試；若持續發生請重新安裝 Work Intelligence。",
    },
    RUNTIME_BUNDLE_INVALID: {
      title: "App 內附的執行環境無效",
      hint: "安裝檔可能已損毀。請重新下載並安裝 Work Intelligence。",
    },
    RUNTIME_IN_USE: {
      title: "執行環境正被使用，無法更新",
      hint: "請先關閉正在使用 Work Intelligence 的 Agent（Codex、Claude Code 等），再按重試。",
    },
    RUNTIME_INSTALL_FAILED: {
      title: "無法準備執行環境",
      hint: "請確認磁碟空間與資料夾權限，並暫時排除防毒軟體對 Work Intelligence 資料夾的掃描後重試；若持續發生請重新安裝。",
    },
    SERVICE_IDENTITY_MISMATCH: { title: "連接埠上的服務不是本 App 啟動的", hint: "請關閉占用的程式後重試。" },
    CHILD_START_TIMEOUT: { title: "服務沒有在時限內啟動", hint: "請稍後重試；若持續發生請匯出診斷資訊。" },
    CHILD_PROTOCOL_ERROR: { title: "服務回應異常", hint: "請重試；若持續發生請匯出診斷資訊。" },
    CHILD_EXITED: { title: "服務意外結束", hint: "請重試；若持續發生請匯出診斷資訊。" },
    REPAIR_REQUIRED: { title: "需要修復", hint: "請匯出診斷資訊，或重新選擇資料庫。" },
  },
};

const en: ShellMessages = {
  appName: "Work Intelligence",
  trayOpenDashboard: "Open Dashboard",
  trayOpenApp: "Open {name}…",
  trayQuit: "Quit (no daily backup after quitting)",
  trayDisabledTemplate: "{label} ({reason})",
  trayReasonStarting: "service is starting",
  trayReasonNeedsRepair: "service needs repair",
  trayReasonStopped: "service is not running",
  trayTooltipManaged: "Work Intelligence: service running",
  trayTooltipNeedsRepair: "Work Intelligence: needs repair",
  trayBackgroundHint: "Work Intelligence keeps running in the {location}.",
  trayLocationMac: "menu bar",
  trayLocationWindows: "notification area",
  trayLocationOther: "system tray",
  tabLabels: {
    setup: "Setup",
    status: "Status",
    agent: "Agent",
    settings: "Settings",
    data: "Data",
    diagnostics: "Diagnostics",
  },
  tabListLabel: "Work Intelligence sections",
  tabAttentionLabel: "Needs attention",
  tabBusyLabel: "In progress",
  statusOpenData: "Open the Data tab",
  recoveryHeading: "An operation was interrupted last time",
  recoveryNotices: {
    "journal-unreadable":
      "The App's record of earlier operations could not be read and was set aside. An operation that was interrupted earlier (for example switching the database or restoring a backup) may not have finished, and the App cannot confirm what state your data is in. So it did not start the service by itself and did not change any data.",
    "port-kept":
      "The App was interrupted while changing the port last time. Confirmed: it still uses the original port {port}. The new port {attempted} did not take effect, and your data was not changed.",
    "port-applied":
      "The App was interrupted while changing the port last time, but the new port {port} did take effect.",
    "db-kept":
      "The App was interrupted while switching the database last time. The switch did not take effect: the original database is still in use and your data was not changed.",
    "db-applied":
      "The App was interrupted while switching the database last time, but the switch had finished: the database you chose is now in use.",
    "copy-removed":
      "The App was interrupted while copying the database to the local disk last time. The unfinished copy was removed and the original database was not changed.",
    "legacy-present":
      "The App was interrupted while turning off the old login service last time. The old login service is still there and the App did not touch it.",
    "legacy-disabled":
      "The App was interrupted while turning off the old login service last time, but the old login service is now turned off.",
    "agent-interrupted":
      "The App was interrupted while setting up an Agent last time. The unfinished changes were reverted or completed.",
    "needs-repair":
      "The App was interrupted during the last attempt to {operation}, and it cannot confirm what state your data is in. So the App did not start the service by itself and did not change any data.",
  },
  recoveryNextSteps: {
    "journal-unreadable":
      "Check on the Status tab that the service and database look right. If your data looks wrong, choose a database on the Data tab or restore from a backup.",
    "port-kept": "To use the new port, change it again on the Settings tab.",
    "port-applied": "You can check the current port on the Settings tab.",
    "db-kept": "To use another database, choose it again on the Data tab.",
    "db-applied": "You can check the database in use on the Data tab.",
    "copy-removed": 'To copy again, choose "Copy to local disk and switch" on the Data tab.',
    "legacy-present": 'To try again, choose "Turn off the old login service…" on the Status tab.',
    "legacy-disabled": "There is nothing more to do.",
    "agent-interrupted": "Check each Agent's state on the Agent tab and set it up again if needed.",
    "needs-repair":
      'Choose "Retry start" on the Status tab; if it still cannot start, choose a database on the Data tab.',
  },
  recoveryOperationNames: {
    takeover: "start the service",
    restart: "restart the service",
    "change-port": "change the port",
    "change-db": "switch the database",
    "apply-agent": "set up an Agent",
    restore: "restore the database",
    maintenance: "maintain the database",
    "legacy-disable": "turn off the old login service",
  },
  recoveryOpenTab: "Open the {tab} tab",
  recoveryDismiss: "Got it",
  menuAbout: "About {name}",
  menuEdit: "Edit",
  menuWindow: "Window",
  menuCloseWindow: "Close Window",
  quitTitle: "Quit Work Intelligence?",
  quitMessage: "No daily backup will run after you quit.",
  quitLastBackup: "Last successful backup: {time}",
  quitNoBackup: "No successful backup yet",
  quitUnknownBackup: "Cannot confirm when the last successful backup was made",
  quitConfirm: "Quit",
  quitCancel: "Cancel",
  notifyTitle: "Work Intelligence needs attention",
  startupFailedTitle: "Work Intelligence cannot start",
  startupFailedMessage:
    "The App could not find this user's application data folder (AppData on Windows) and has to close. Nothing was changed. Check that the user profile is complete, then open the App again.",
  journalNewerVersion:
    "The App's record of operations was written by a newer version of Work Intelligence, which this version cannot read. To protect your data, the App did not start the service by itself and did not change any data. Update the App, then open it again.",
  notifyBody: "{title}. Open the Status tab in the App.",
  repairIntro:
    "The service is not running normally. Your data was not changed; below is what is going on and what you can do.",
  repairServiceHeading: "Service",
  repairDatabaseHeading: "Database",
  repairErrorsHeading: "Recent errors",
  repairNoErrors: "No errors recorded.",
  repairNoDatabase: "No database is set up yet.",
  repairCandidates: "The database you chose",
  repairConfirmCandidate: "Use this database and retry",
  repairBusy: "Working…",
  repairBusyOperation: "The App is working on another operation. Try again in a moment.",
  repairBusyWhat: {
    takeover: "starting the service",
    restart: "restarting the service",
    "change-port": "changing the port",
    "change-db": "switching the database",
    "apply-agent": "setting up an Agent",
    restore: "restoring a backup",
    maintenance: "maintain the database",
    "legacy-disable": "disabling the old login service",
    "copy-to-local": "copying the database to the local disk",
    "login-item": "changing the start-at-login setting",
    "backup-directory": "changing the backup location",
  },
  repairBusyNamed: "The App is busy: {what}. Wait for it to finish, then try again. Nothing was changed.",
  repairBusyActivity:
    "The Dashboard is importing, backing up or exporting data. Wait for it to finish, then try again. Nothing was changed.",
  repairBusyUnknown:
    "The App could not confirm whether the Dashboard is working on data right now. Try again in a moment. Nothing was changed.",
  repairConfirmMigrate: "Allow a schema update, use this database and retry",
  repairMigrationNote: "This database needs a schema update before it can be used; a backup is made first.",
  repairCandidateNotUsable: "This database cannot be used right now.",
  quitStopIncompleteTitle: "The background service may still be running",
  quitStopIncompleteMessage:
    "Work Intelligence could not confirm that its background service has fully stopped. If it will not reopen, end it in Task Manager or Activity Monitor, or restart the computer. Details are in the log file.",
  quitStopIncompleteOk: "OK",
  repairDone: "Done.",
  databaseChangedDone:
    "Done. Agents that are already open keep writing to the previous database; close and reopen them to use the new one.",
  repairRecovered: "✓ Recovered",
  repairRecoveredHint: "The database is ready to use. Opening the Dashboard for you.",
  repairProjectCount: "{count} projects",
  repairProjectCountLabel: "Projects",
  notifyRecoveredTitle: "Work Intelligence is ready",
  notifyRecoveredBody: "The database is back. Opening the Dashboard.",
  repairFailedGeneric: "That did not finish. Please try again.",
  actionRetry: "Retry start",
  actionChooseDatabase: "Choose database…",
  actionOpenDatabaseFolder: "Open database folder",
  actionOpenBackups: "Open backups folder",
  actionOpenLogs: "Open logs folder",
  actionExport: "Export diagnostics…",
  agentsTooLargeNote: "File too large to show a diff",
  agentsAckUndiffable: "I understand some files have no diff shown",
  legacyActiveNoOverrideHint:
    "To keep two backends off one database, the App did not start its own backend. Turn off the old login service in the Status tab, or choose another database.",
  ownerLabel: "Service",
  backendLabel: "Background process",
  databaseStatusLabel: "Database status",
  lastBackupLabel: "Last successful backup",
  owners: {
    UNCONFIGURED: "Not set up",
    EXTERNAL: "Managed elsewhere",
    PREPARING: "Preparing",
    QUIESCING: "Stopping the old service",
    STARTING: "Starting",
    MANAGED: "Managed by this app",
    NEEDS_REPAIR: "Needs repair",
  },
  backends: { running: "Running", starting: "Starting", stopped: "Not running", crashed: "Ended unexpectedly" },
  databaseStatuses: {
    ok: "Usable",
    missing: "File not found",
    offline: "Storage offline",
    denied: "No read permission",
    unreadable: "Cannot be read",
    "unsupported-schema": "Unsupported version",
    unknown: "Not checked yet",
  },
  errors: {
    LEGACY_SERVICE_ACTIVE: {
      title: "The old login service also uses this database",
      hint: "To keep two backends off one database, the App did not start its own backend. Turn off the old login service in the Status tab, or choose “Start anyway” for the current database.",
    },
    DB_MISSING: {
      title: "The database file was not found",
      hint: "It may have been moved or deleted. Choose a database, or open the Data tab → “Restore from backup”.",
    },
    DB_OFFLINE: {
      title: "The storage holding the database is offline",
      hint: "Reconnect the external or network drive and retry.",
    },
    DB_PERMISSION: { title: "No permission to read the database", hint: "Check the file's permissions and retry." },
    DB_IDENTITY_CHANGED: {
      title: "The database is no longer the one you confirmed",
      hint: "The file may have been replaced. Choose and confirm the database again.",
    },
    DB_INTEGRITY_CHECK_FAILED: {
      title: "The database did not pass its check",
      hint: "After the old login service stopped, a check of this database found a problem, so the App did not open it. Open the Data tab → “Restore from backup”, or choose another database.",
    },
    DB_STORAGE_NETWORK: {
      title: "The database is on a network drive",
      hint: "SQLite can corrupt data on a network drive, so the App did not use it. Copy the database to a local disk on this computer, then choose the copy.",
    },
    DIAGNOSTICS_SCAN_FAILED: {
      title: "The diagnostics could not be prepared",
      hint: "A final check still found what may be personal information or a secret, so no file was made. Report this code, and do not attach raw logs.",
    },
    SCHEMA_TOO_NEW: { title: "The database is newer than this version", hint: "Update Work Intelligence and retry." },
    SCHEMA_MIGRATION_BLOCKED: {
      title: "The database needed an update that did not finish",
      hint: "Your data was not changed. Check the backups and retry.",
    },
    PORT_OCCUPIED_BY_OTHER: {
      title: "Another program is using the port",
      hint: "Close that program, or pick another port in the Port section of the Settings tab.",
    },
    PORT_NOT_PERMITTED: {
      title: "The system does not allow this port",
      hint: "The operating system did not let Work Intelligence use this port (for example a range Windows reserves). Pick another port in the Port section.",
    },
    PORT_NOT_RELEASED: { title: "The port is not released yet", hint: "Wait a few seconds and retry." },
    RUNTIME_MISSING: {
      title: "The runtime was not found",
      hint: "The installation may be incomplete. Reinstall Work Intelligence.",
    },
    RUNTIME_UNSAFE_PERMISSIONS: {
      title: "The runtime folder's permissions are not safe",
      hint: "Another account can modify Work Intelligence's runtime folder, so it was not started. Reinstall Work Intelligence, or ask your administrator to restore the folder permissions (only you, SYSTEM and Administrators may write), then retry.",
    },
    RUNTIME_ACL_UNREADABLE: {
      title: "The runtime folder's permissions could not be checked",
      hint: "The folder permissions could not be read (PowerShell may be blocked by policy or timed out), so the service was not started. Make sure PowerShell can run, or ask your administrator for help, then retry; your data was not changed.",
    },
    RUNTIME_POINTER_MISSING: {
      title: "The runtime version pointer was not found",
      hint: "The installation may be incomplete. Reinstall Work Intelligence.",
    },
    RUNTIME_POINTER_INVALID: {
      title: "The runtime version pointer is invalid",
      hint: "The pointer file may be damaged. Reinstall Work Intelligence.",
    },
    RUNTIME_MANIFEST_INVALID: {
      title: "The runtime manifest is invalid",
      hint: "The manifest file may be damaged. Reinstall Work Intelligence.",
    },
    RUNTIME_FILE_MISSING: {
      title: "The runtime is missing a file",
      hint: "A file was deleted or the installation is incomplete. Reinstall Work Intelligence.",
    },
    RUNTIME_FILE_UNEXPECTED: {
      title: "The runtime has an unexpected file",
      hint: "The folder holds a file that is not part of the installation. Reinstall Work Intelligence.",
    },
    RUNTIME_FILE_TAMPERED: {
      title: "A runtime file was changed",
      hint: "A file differs from what was installed, so it was not started. Reinstall Work Intelligence.",
    },
    RUNTIME_SYMLINK_REJECTED: {
      title: "The runtime contains a link that is not allowed",
      hint: "It was not started for safety. Reinstall Work Intelligence.",
    },
    RUNTIME_ACTION_NOT_ALLOWED: {
      title: "The runtime does not allow this action",
      hint: "Update or reinstall Work Intelligence, then retry.",
    },
    RUNTIME_KIND_NOT_ALLOWED: {
      title: "This kind of runtime is not allowed",
      hint: "Update or reinstall Work Intelligence, then retry.",
    },
    RUNTIME_ALREADY_INSTALLED: {
      title: "This runtime is already installed",
      hint: "Retry; if it keeps happening, reinstall Work Intelligence.",
    },
    RUNTIME_BUNDLE_INVALID: {
      title: "The runtime bundled with the app is invalid",
      hint: "The installer may be damaged. Download and install Work Intelligence again.",
    },
    RUNTIME_IN_USE: {
      title: "The runtime is in use and cannot be updated",
      hint: "Close the Agents that use Work Intelligence (Codex, Claude Code, ...) and retry.",
    },
    RUNTIME_INSTALL_FAILED: {
      title: "The runtime could not be prepared",
      hint: "Check free disk space and folder permissions, and pause antivirus scanning of the Work Intelligence folder, then retry. If it keeps happening, reinstall.",
    },
    SERVICE_IDENTITY_MISMATCH: {
      title: "The service on the port was not started by this app",
      hint: "Close the program using the port and retry.",
    },
    CHILD_START_TIMEOUT: {
      title: "The service did not start in time",
      hint: "Retry in a moment; if it keeps happening, export diagnostics.",
    },
    CHILD_PROTOCOL_ERROR: {
      title: "The service answered unexpectedly",
      hint: "Retry; if it keeps happening, export diagnostics.",
    },
    CHILD_EXITED: {
      title: "The service ended unexpectedly",
      hint: "Retry; if it keeps happening, export diagnostics.",
    },
    REPAIR_REQUIRED: { title: "Repair is needed", hint: "Export diagnostics, or choose the database again." },
  },
};

/** `zh-*` (any region or script) reads Traditional Chinese; every other locale reads English. */
export function resolveShellLocale(systemLocale: string | undefined): ShellLocale {
  return typeof systemLocale === "string" && /^zh(?:[-_]|$)/i.test(systemLocale.trim()) ? "zh-TW" : "en";
}

/** The string table of `locale`. */
export function shellMessages(locale: ShellLocale): ShellMessages {
  return locale === "zh-TW" ? zhTW : en;
}

/** Fills `{name}` placeholders; a placeholder without a value stays visible so a missing value is noticed. */
export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

/** The hint of an error; the legacy-service one only names "start anyway" where that button exists. */
export function errorHintFor(messages: ShellMessages, code: string, startAnywayAvailable: boolean): string {
  if (code === "LEGACY_SERVICE_ACTIVE" && !startAnywayAvailable) return messages.legacyActiveNoOverrideHint;
  return errorMessageFor(messages, code).hint;
}

/** The message of an error code, or the generic repair one for a code this build does not know. */
export function errorMessageFor(messages: ShellMessages, code: string): ErrorMessage {
  return (messages.errors as Readonly<Record<string, ErrorMessage>>)[code] ?? messages.errors.REPAIR_REQUIRED;
}

/** The sentence for what holds the App back; it names the real reason, and is generic only when the reason is unknown. */
export function busyReasonText(messages: ShellMessages, reason: RepairBusyReason | undefined): string {
  switch (reason?.source) {
    case "operation":
      return formatMessage(messages.repairBusyNamed, { what: messages.repairBusyWhat[reason.what] });
    case "activity":
      return messages.repairBusyActivity;
    case "unknown":
      return messages.repairBusyUnknown;
    default:
      return messages.repairBusyOperation;
  }
}
