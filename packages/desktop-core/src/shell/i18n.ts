import type { BackendErrorCode } from "../backend/errors.js";
import type { AppTab } from "./app-tabs.js";

/** Languages the shell speaks: Traditional Chinese for any `zh-*` locale, English for everything else. */
export type ShellLocale = "zh-TW" | "en";

/** Codes of failures that happen in the shell itself, before or around the backend child. */
export type ShellErrorCode =
  | "RUNTIME_INSTALL_FAILED"
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
  readonly trayRepair: string;
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
  /** `{title}` is the error title. */
  readonly notifyBody: string;
  readonly repairWindowTitle: string;
  readonly repairHeading: string;
  readonly repairIntro: string;
  readonly repairServiceHeading: string;
  readonly repairDatabaseHeading: string;
  readonly repairErrorsHeading: string;
  readonly repairBackupHeading: string;
  readonly repairActionsHeading: string;
  readonly repairNoErrors: string;
  readonly repairNoDatabase: string;
  readonly repairCandidates: string;
  readonly repairConfirmCandidate: string;
  readonly repairBusy: string;
  /** A restart is already running (an automatic retry or another operation): not an error. */
  readonly repairRestarting: string;
  /** Confirm button for a database whose schema must be updated; pressing it is the user's consent. */
  readonly repairConfirmMigrate: string;
  readonly repairMigrationNote: string;
  readonly repairCandidateNotUsable: string;
  /** Shown when the App exits without proof that the backend stopped (never in background mode). */
  readonly quitStopIncompleteTitle: string;
  readonly quitStopIncompleteMessage: string;
  readonly quitStopIncompleteOk: string;
  readonly repairDone: string;
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
  trayRepair: "修復…",
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
  notifyBody: "{title}。從工具列選單開啟「修復…」。",
  repairWindowTitle: "Work Intelligence 修復",
  repairHeading: "修復 Work Intelligence",
  repairIntro: "服務沒有正常執行。你的資料沒有被改動；下面列出目前的狀況和可以做的事。",
  repairServiceHeading: "服務",
  repairDatabaseHeading: "資料庫",
  repairErrorsHeading: "最近的錯誤",
  repairBackupHeading: "備份",
  repairActionsHeading: "可以做的事",
  repairNoErrors: "沒有紀錄到錯誤。",
  repairNoDatabase: "尚未設定資料庫。",
  repairCandidates: "你選擇的資料庫",
  repairConfirmCandidate: "使用這個資料庫並重試",
  repairBusy: "處理中…",
  repairRestarting: "正在重新啟動服務，請稍候。",
  repairConfirmMigrate: "同意更新資料庫結構，使用這個資料庫並重試",
  repairMigrationNote: "這個資料庫需要更新結構才能使用；更新前會先備份。",
  repairCandidateNotUsable: "這個資料庫目前不能使用。",
  quitStopIncompleteTitle: "背景服務可能仍在執行",
  quitStopIncompleteMessage:
    "無法確認 Work Intelligence 的背景服務已完全停止。若稍後仍無法重新開啟，請在工作管理員或活動監視器中結束它，或重新啟動電腦。細節已寫入記錄檔。",
  quitStopIncompleteOk: "知道了",
  repairDone: "已完成。",
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
    "為了避免兩個後端同時使用同一份資料庫，App 沒有啟動自己的後端。請先移除舊的登入服務（pnpm service:uninstall），或改選另一份資料庫。",
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
      hint: "為了避免兩個後端同時使用同一份資料庫，App 沒有啟動自己的後端。請先移除舊的登入服務（pnpm bootstrap），或在這個視窗對目前的資料庫選擇「仍要啟動」。",
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
      hint: "請關閉占用的程式，或在「修復」視窗的「連接埠」區塊（也可從工具列選單的「變更連接埠…」）換一個連接埠。",
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
  trayRepair: "Repair…",
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
  notifyBody: "{title}. Open “Repair…” from the tray menu.",
  repairWindowTitle: "Work Intelligence Repair",
  repairHeading: "Repair Work Intelligence",
  repairIntro:
    "The service is not running normally. Your data was not changed; below is what is going on and what you can do.",
  repairServiceHeading: "Service",
  repairDatabaseHeading: "Database",
  repairErrorsHeading: "Recent errors",
  repairBackupHeading: "Backups",
  repairActionsHeading: "What you can do",
  repairNoErrors: "No errors recorded.",
  repairNoDatabase: "No database is set up yet.",
  repairCandidates: "The database you chose",
  repairConfirmCandidate: "Use this database and retry",
  repairBusy: "Working…",
  repairRestarting: "The service is restarting. Please wait.",
  repairConfirmMigrate: "Allow a schema update, use this database and retry",
  repairMigrationNote: "This database needs a schema update before it can be used; a backup is made first.",
  repairCandidateNotUsable: "This database cannot be used right now.",
  quitStopIncompleteTitle: "The background service may still be running",
  quitStopIncompleteMessage:
    "Work Intelligence could not confirm that its background service has fully stopped. If it will not reopen, end it in Task Manager or Activity Monitor, or restart the computer. Details are in the log file.",
  quitStopIncompleteOk: "OK",
  repairDone: "Done.",
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
    "To keep two backends off one database, the App did not start its own backend. Remove the old login service first (pnpm service:uninstall), or choose another database.",
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
      hint: "To keep two backends off one database, the App did not start its own backend. Remove the old login service (pnpm bootstrap) first, or choose “Start anyway” for the current database in this window.",
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
      hint: 'Close that program, or pick another port in the Port section of the repair window (also reachable from the tray menu\'s "Change port…").',
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
