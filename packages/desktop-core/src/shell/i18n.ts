import type { BackendErrorCode } from "../backend/errors.js";

/** Languages the shell speaks: Traditional Chinese for any `zh-*` locale, English for everything else. */
export type ShellLocale = "zh-TW" | "en";

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
  readonly quitTitle: string;
  readonly quitMessage: string;
  /** `{time}` is the local time of the last successful backup. */
  readonly quitLastBackup: string;
  readonly quitNoBackup: string;
  readonly quitUnknownBackup: string;
  readonly quitConfirm: string;
  readonly quitCancel: string;
  readonly notifyTitle: string;
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
  readonly repairFailedGeneric: string;
  readonly actionRetry: string;
  readonly actionChooseDatabase: string;
  readonly actionOpenDatabaseFolder: string;
  readonly actionOpenBackups: string;
  readonly actionOpenLogs: string;
  readonly actionExport: string;
  readonly ownerLabel: string;
  readonly backendLabel: string;
  readonly databaseStatusLabel: string;
  readonly lastBackupLabel: string;
  readonly owners: Readonly<Record<string, string>>;
  readonly backends: Readonly<Record<string, string>>;
  readonly databaseStatuses: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<BackendErrorCode, ErrorMessage>>;
}

const zhTW: ShellMessages = {
  appName: "Work Intelligence",
  trayOpenDashboard: "開啟 Dashboard",
  trayRepair: "修復…",
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
  quitTitle: "退出 Work Intelligence？",
  quitMessage: "退出後不會每日備份。",
  quitLastBackup: "最後成功備份：{time}",
  quitNoBackup: "尚無成功備份",
  quitUnknownBackup: "無法確認最後成功備份的時間",
  quitConfirm: "退出",
  quitCancel: "取消",
  notifyTitle: "Work Intelligence 需要處理",
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
  repairFailedGeneric: "這個動作沒有完成，請再試一次。",
  actionRetry: "重試啟動",
  actionChooseDatabase: "選擇資料庫…",
  actionOpenDatabaseFolder: "開啟資料庫資料夾",
  actionOpenBackups: "開啟備份資料夾",
  actionOpenLogs: "開啟紀錄資料夾",
  actionExport: "匯出診斷資訊…",
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
    DB_MISSING: { title: "找不到資料庫檔案", hint: "檔案可能被移動或刪除。請選擇資料庫，或從備份還原。" },
    DB_OFFLINE: { title: "資料庫所在的儲存位置離線", hint: "請接上外接硬碟或網路磁碟後重試。" },
    DB_PERMISSION: { title: "沒有權限讀取資料庫", hint: "請確認檔案的存取權限後重試。" },
    DB_IDENTITY_CHANGED: { title: "資料庫已不是先前確認的那一份", hint: "檔案可能被取代。請重新選擇並確認資料庫。" },
    SCHEMA_TOO_NEW: { title: "資料庫比這個版本新", hint: "請更新 Work Intelligence 後重試。" },
    SCHEMA_MIGRATION_BLOCKED: { title: "資料庫需要更新但沒有完成", hint: "你的資料沒有被改動。請查看備份後重試。" },
    PORT_OCCUPIED_BY_OTHER: { title: "連接埠被其他程式占用", hint: "請關閉占用的程式，或在設定中換一個連接埠。" },
    PORT_NOT_RELEASED: { title: "連接埠尚未釋放", hint: "稍等幾秒後重試。" },
    RUNTIME_MISSING: { title: "找不到執行環境", hint: "安裝可能不完整。請重新安裝 Work Intelligence。" },
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
  quitTitle: "Quit Work Intelligence?",
  quitMessage: "No daily backup will run after you quit.",
  quitLastBackup: "Last successful backup: {time}",
  quitNoBackup: "No successful backup yet",
  quitUnknownBackup: "Cannot confirm when the last successful backup was made",
  quitConfirm: "Quit",
  quitCancel: "Cancel",
  notifyTitle: "Work Intelligence needs attention",
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
  repairFailedGeneric: "That did not finish. Please try again.",
  actionRetry: "Retry start",
  actionChooseDatabase: "Choose database…",
  actionOpenDatabaseFolder: "Open database folder",
  actionOpenBackups: "Open backups folder",
  actionOpenLogs: "Open logs folder",
  actionExport: "Export diagnostics…",
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
    DB_MISSING: {
      title: "The database file was not found",
      hint: "It may have been moved or deleted. Choose a database, or restore from a backup.",
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
    SCHEMA_TOO_NEW: { title: "The database is newer than this version", hint: "Update Work Intelligence and retry." },
    SCHEMA_MIGRATION_BLOCKED: {
      title: "The database needed an update that did not finish",
      hint: "Your data was not changed. Check the backups and retry.",
    },
    PORT_OCCUPIED_BY_OTHER: {
      title: "Another program is using the port",
      hint: "Close that program, or pick another port in the settings.",
    },
    PORT_NOT_RELEASED: { title: "The port is not released yet", hint: "Wait a few seconds and retry." },
    RUNTIME_MISSING: {
      title: "The runtime was not found",
      hint: "The installation may be incomplete. Reinstall Work Intelligence.",
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

/** The message of an error code, or the generic repair one for a code this build does not know. */
export function errorMessageFor(messages: ShellMessages, code: string): ErrorMessage {
  return (messages.errors as Readonly<Record<string, ErrorMessage>>)[code] ?? messages.errors.REPAIR_REQUIRED;
}
