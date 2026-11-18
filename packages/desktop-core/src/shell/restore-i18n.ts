import type { OperationKind } from "../operations/journal-record.js";
import { formatMessage, type ShellLocale } from "./i18n.js";
import type {
  BackupProblem,
  RestoreBackupLabel,
  RestoreBusyDetail,
  RestorePickResult,
  RestoreRunResult,
} from "./restore-types.js";

/**
 * The strings of 「從備份還原」: the Data tab's section, its answers and the native dialogs. No command, terminal or path
 * wording anywhere; where something must be closed or retried, the text says what to do in the App or in the user's own
 * programs.
 */
export interface RestoreMessages {
  readonly heading: string;
  readonly intro: string;
  readonly listHeading: string;
  readonly loading: string;
  readonly noBackups: string;
  readonly noDatabase: string;
  readonly folderUnreadable: string;
  readonly listFailed: string;
  readonly chooseFile: string;
  readonly refresh: string;
  readonly restore: string;
  readonly restoring: string;
  readonly labels: Readonly<Record<RestoreBackupLabel, string>>;
  readonly factTime: string;
  readonly factSize: string;
  /** `{version}` is the schema version of the backup. */
  readonly factVersion: string;
  /** `{projects}` and `{sessions}` are counts. */
  readonly factContent: string;
  readonly unknownTime: string;
  /** Shown beside a backup that cannot be restored from. */
  readonly problems: Readonly<Record<BackupProblem, string>>;
  /** `{version}`: the schema version of a file from a newer App. */
  readonly newerSchemaWithVersion: string;
  /** Agents may hold the database: asked to close them first. */
  readonly agentsRunning: string;
  readonly pickCancelled: string;
  readonly pickFailed: string;
  readonly expired: string;
  readonly cancelled: string;
  readonly busyOperation: string;
  readonly busyActivity: string;
  readonly busyPageAction: string;
  readonly busyUnknown: string;
  /** `{what}` is one of `operations`. */
  readonly busyOperationNamed: string;
  readonly operations: Readonly<Record<OperationKind, string>>;
  readonly locked: string;
  readonly noSpace: string;
  readonly verifyFailed: string;
  readonly sameFile: string;
  readonly noDatabaseToRestore: string;
  readonly failed: string;
  /** Appended when a failure left the service stopped. */
  readonly notRunning: string;
  /** Appended after a failure that touched nothing. */
  readonly dataIntact: string;
  /** The restore gave no answer and the database could not be shown unchanged; no claim about the data is made. */
  readonly outcomeUnknown: string;
  /** `{safety}` is the file name of the safety backup. */
  readonly startFailed: string;
  /** `{safety}` is the file name; `{projects}` and `{sessions}` are counts. */
  readonly done: string;
  readonly doneNoSafety: string;
  /** The native chooser. */
  readonly pickTitle: string;
  readonly pickFilter: string;
  /** The native confirmation. */
  readonly confirmTitle: string;
  readonly confirmMessage: string;
  /** `{database}` is the current database file, `{time}` and `{size}` describe the backup. */
  readonly confirmDetail: string;
  readonly confirmDetailNoDatabase: string;
  readonly confirmButton: string;
  readonly cancelButton: string;
}

const zhTW: RestoreMessages = {
  heading: "從備份還原",
  intro:
    "用一份備份取代目前的資料。還原前 App 會先自動備份目前的資料；如果還原沒有成功，目前的資料庫維持原樣。還原時服務會短暫重新啟動。",
  listHeading: "可用的備份",
  loading: "正在讀取備份…",
  noBackups: "這個資料庫還沒有備份。你也可以選擇其他位置的備份檔。",
  noDatabase: "尚未設定資料庫，沒有可以還原的目標。",
  folderUnreadable: "無法讀取備份資料夾。你仍可選擇其他位置的備份檔。",
  listFailed: "無法讀取備份清單，請稍後再試。",
  chooseFile: "選擇備份檔…",
  refresh: "重新整理",
  restore: "還原這份備份…",
  restoring: "正在還原…",
  labels: {
    automatic: "自動備份",
    manual: "手動備份",
    migration: "升級前備份",
    deletion: "刪除前備份",
    session_deletion: "刪除 Session 前備份",
    maintenance: "維護前備份",
    import: "匯入前備份",
    picked: "你選擇的檔案",
  },
  factTime: "備份時間",
  factSize: "大小",
  factVersion: "資料庫版本 {version}",
  factContent: "{projects} 個專案、{sessions} 筆 Session",
  unknownTime: "不明",
  problems: {
    "newer-schema": "這份備份來自較新版本的 Work Intelligence，這個版本還不能使用。請先更新 App。",
    "not-database": "這不是 Work Intelligence 的資料庫檔案。",
    corrupt: "這份備份已損壞（完整性檢查沒有通過），無法還原。",
    unreadable: "無法讀取這個檔案，請確認檔案的存取權限。",
    missing: "找不到這個檔案，它可能已被移動或刪除。",
  },
  newerSchemaWithVersion: "這份備份使用較新的資料庫版本（{version}），這個版本的 App 還不能使用。請先更新 App 再還原。",
  agentsRunning: "請先關閉 Claude Code / Codex 等 Agent 再還原。它們開著時可能仍在使用資料庫，還原不會開始。",
  pickCancelled: "已取消，沒有變更。",
  pickFailed: "無法檢查這個檔案，沒有變更任何資料。",
  expired: "這份備份的選擇已過期，請重新整理清單後再選一次。沒有變更任何資料。",
  cancelled: "已取消，沒有變更任何資料。",
  busyOperation: "App 正在處理另一項操作，請等它完成後再還原。",
  busyOperationNamed: "App 正在{what}，請等它完成後再還原。沒有變更任何資料。",
  busyActivity: "Dashboard 正在匯入、備份或匯出資料，請等它完成後再還原。沒有變更任何資料。",
  busyPageAction: "這個視窗正在進行另一項操作，請等它完成後再還原。沒有變更任何資料。",
  busyUnknown: "暫時無法確認 Dashboard 是否正在處理資料，請稍後再試。沒有變更任何資料。",
  operations: {
    takeover: "啟動服務",
    "change-port": "變更連接埠",
    "change-db": "變更資料庫",
    "apply-agent": "設定 Agent",
    restart: "重新啟動服務",
    restore: "還原備份",
    "legacy-disable": "停用舊的登入服務",
  },
  locked:
    "無法取代資料庫檔案：它可能正被其他程式鎖定（例如防毒軟體、雲端同步或檔案總管的預覽）。原本的資料庫沒有任何變更。請暫時關閉這些程式後再試一次。",
  noSpace: "磁碟空間不足，無法還原。原本的資料庫沒有任何變更。請釋出空間後再試。",
  verifyFailed: "還原用的副本在升級後沒有通過檢查，所以沒有取代目前的資料庫。請改用其他備份。",
  sameFile: "這個檔案就是目前使用的資料庫，不需要還原。",
  noDatabaseToRestore: "尚未設定資料庫，無法還原。",
  failed: "還原沒有成功。原本的資料庫沒有任何變更。",
  notRunning: "服務目前沒有執行。請到「狀態」分頁按「重試」，或再試一次還原。",
  dataIntact: "原本的資料庫沒有任何變更。",
  outcomeUnknown:
    "還原沒有回報結果，無法確定資料庫目前是原本的資料還是還原後的資料。還原前 App 會先自動備份目前的資料，那份備份應該在備份資料夾中（可在這一頁的清單看到最新的備份）。請先確認資料是否正常，需要的話可以再選一份備份重新還原。",
  startFailed:
    "備份已還原，但服務沒能用還原後的資料啟動。還原前的資料已備份為「{safety}」，仍在備份資料夾中。請到「狀態」分頁查看，或選擇另一份備份還原。",
  done: "已還原：{projects} 個專案、{sessions} 筆 Session。還原前的資料已備份為「{safety}」。",
  doneNoSafety: "已還原：{projects} 個專案、{sessions} 筆 Session。",
  pickTitle: "選擇備份檔",
  pickFilter: "資料庫備份",
  confirmTitle: "從備份還原",
  confirmMessage: "要用這份備份取代目前的資料嗎？",
  confirmDetail:
    "將被覆蓋的資料庫：\n{database}\n\n使用的備份：{time}，{size}\n\n還原前 App 會先自動備份目前的資料。還原時服務會短暫重新啟動；如果還原失敗，目前的資料庫維持原樣。",
  confirmDetailNoDatabase:
    "目前找不到資料庫檔案，不會有資料被覆蓋。\n\n使用的備份：{time}，{size}\n\n還原後服務會用這份備份啟動。",
  confirmButton: "還原",
  cancelButton: "取消",
};

const en: RestoreMessages = {
  heading: "Restore from backup",
  intro:
    "Replace the current data with a backup. Before it does, the App makes an automatic backup of the current data; if the restore does not succeed, the current database stays exactly as it was. The service restarts briefly.",
  listHeading: "Available backups",
  loading: "Reading backups…",
  noBackups: "This database has no backups yet. You can also choose a backup file from another location.",
  noDatabase: "No database is set up yet, so there is nothing to restore into.",
  folderUnreadable: "The backup folder could not be read. You can still choose a backup file from another location.",
  listFailed: "The backup list could not be read. Try again in a moment.",
  chooseFile: "Choose a backup file…",
  refresh: "Refresh",
  restore: "Restore this backup…",
  restoring: "Restoring…",
  labels: {
    automatic: "Automatic backup",
    manual: "Manual backup",
    migration: "Backup before an upgrade",
    deletion: "Backup before a deletion",
    session_deletion: "Backup before a Session deletion",
    maintenance: "Backup before maintenance",
    import: "Backup before an import",
    picked: "File you chose",
  },
  factTime: "Backup time",
  factSize: "Size",
  factVersion: "Database version {version}",
  factContent: "{projects} projects, {sessions} sessions",
  unknownTime: "Unknown",
  problems: {
    "newer-schema":
      "This backup comes from a newer version of Work Intelligence that this version cannot use yet. Update the App first.",
    "not-database": "This is not a Work Intelligence database file.",
    corrupt: "This backup is damaged (it failed its integrity check) and cannot be restored.",
    unreadable: "This file could not be read. Check its access permissions.",
    missing: "This file was not found; it may have been moved or deleted.",
  },
  newerSchemaWithVersion:
    "This backup uses a newer database version ({version}) that this version of the App cannot use yet. Update the App, then restore.",
  agentsRunning:
    "Close Claude Code, Codex and other Agents before restoring. While they are open they may still be using the database, so the restore will not start.",
  pickCancelled: "Cancelled. Nothing was changed.",
  pickFailed: "This file could not be checked. Nothing was changed.",
  expired: "This backup choice has expired. Refresh the list and choose it again. Nothing was changed.",
  cancelled: "Cancelled. Nothing was changed.",
  busyOperation: "The App is busy with another operation. Wait for it to finish, then restore.",
  busyOperationNamed: "The App is busy: {what}. Wait for it to finish, then restore. Nothing was changed.",
  busyActivity:
    "The Dashboard is importing, backing up or exporting data. Wait for it to finish, then restore. Nothing was changed.",
  busyPageAction: "This window is running another action. Wait for it to finish, then restore. Nothing was changed.",
  busyUnknown:
    "The App could not confirm whether the Dashboard is working on data right now. Try again in a moment. Nothing was changed.",
  operations: {
    takeover: "starting the service",
    "change-port": "changing the port",
    "change-db": "changing the database",
    "apply-agent": "setting up an Agent",
    restart: "restarting the service",
    restore: "restoring a backup",
    "legacy-disable": "disabling the old login service",
  },
  locked:
    "The database file could not be replaced: another program may be locking it (for example antivirus, cloud sync or a file-explorer preview). The original database was not changed. Close those programs for a moment and try again.",
  noSpace:
    "There is not enough disk space to restore. The original database was not changed. Free some space and try again.",
  verifyFailed:
    "The copy prepared for the restore failed its check after the upgrade, so the current database was not replaced. Use another backup.",
  sameFile: "This file is the database in use right now; there is nothing to restore.",
  noDatabaseToRestore: "No database is set up yet, so nothing can be restored.",
  failed: "The restore did not succeed. The original database was not changed.",
  notRunning: "The service is not running. Open the Status tab and press Retry, or try the restore again.",
  dataIntact: "The original database was not changed.",
  outcomeUnknown:
    "The restore did not report a result, so it is not certain whether the database now holds the original data or the restored data. Before replacing anything the App makes an automatic backup of the current data; it should be in the backup folder (the newest backup in the list on this page). Check that your data looks right, and restore a backup again if you need to.",
  startFailed:
    "The backup was restored, but the service could not start on the restored data. The data from before the restore was backed up as “{safety}” and is still in the backup folder. Check the Status tab, or restore another backup.",
  done: "Restored: {projects} projects, {sessions} sessions. The data from before the restore was backed up as “{safety}”.",
  doneNoSafety: "Restored: {projects} projects, {sessions} sessions.",
  pickTitle: "Choose a backup file",
  pickFilter: "Database backup",
  confirmTitle: "Restore from backup",
  confirmMessage: "Replace the current data with this backup?",
  confirmDetail:
    "Database that will be overwritten:\n{database}\n\nBackup used: {time}, {size}\n\nBefore restoring, the App makes an automatic backup of the current data. The service restarts briefly; if the restore fails, the current database stays as it was.",
  confirmDetailNoDatabase:
    "No database file was found, so no data will be overwritten.\n\nBackup used: {time}, {size}\n\nAfter the restore the service starts on this backup.",
  confirmButton: "Restore",
  cancelButton: "Cancel",
};

/** The string table of `locale`. */
export function restoreMessages(locale: ShellLocale): RestoreMessages {
  return locale === "zh-TW" ? zhTW : en;
}

/** A size in the unit a person reads (KB, MB, GB), the same in every language. */
export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The sentence for what held a restore back; it names the real reason, not a generic one. */
export function busyText(messages: RestoreMessages, busy: RestoreBusyDetail | undefined): string {
  switch (busy?.source) {
    case "operation":
      return formatMessage(messages.busyOperationNamed, { what: messages.operations[busy.operation] });
    case "activity":
      return messages.busyActivity;
    case "page-action":
      return messages.busyPageAction;
    case "unknown":
      return messages.busyUnknown;
    default:
      return messages.busyOperation;
  }
}

/** The sentence for a refused pick (a file that is not a restorable backup, or a cancelled chooser). */
export function pickFailureText(messages: RestoreMessages, result: Extract<RestorePickResult, { ok: false }>): string {
  if (result.reason === "newer-schema" && result.schemaVersion !== undefined) {
    return formatMessage(messages.newerSchemaWithVersion, { version: String(result.schemaVersion) });
  }
  switch (result.reason) {
    case "cancelled":
      return messages.pickCancelled;
    case "invalid":
    case "failed":
      return messages.pickFailed;
    default:
      return messages.problems[result.reason];
  }
}

/** The sentence for a restore that did not finish: what happened, and what is true of the data now. */
export function runFailureText(messages: RestoreMessages, result: Extract<RestoreRunResult, { ok: false }>): string {
  const tail = result.backendRunning ? "" : ` ${messages.notRunning}`;
  switch (result.reason) {
    case "expired":
      return messages.expired;
    case "cancelled":
      return messages.cancelled;
    case "busy":
      return busyText(messages, result.busy);
    case "agents-running":
      return `${messages.agentsRunning} ${messages.dataIntact}${tail}`;
    case "locked":
      return `${messages.locked}${tail}`;
    case "no-space":
      return `${messages.noSpace}${tail}`;
    case "verify-failed":
      return `${messages.verifyFailed}${tail}`;
    case "same-file":
      return messages.sameFile;
    case "no-database":
      return messages.noDatabaseToRestore;
    case "newer-schema":
    case "not-database":
    case "corrupt":
    case "missing":
      return `${messages.problems[result.reason]} ${messages.dataIntact}${tail}`;
    case "outcome-unknown":
      return `${messages.outcomeUnknown}${tail}`;
    case "start-failed":
      return formatMessage(messages.startFailed, { safety: result.safetyBackup ?? "" });
    default:
      return `${messages.failed}${tail}`;
  }
}

/** The sentence for a restore that worked. */
export function runSuccessText(messages: RestoreMessages, result: Extract<RestoreRunResult, { ok: true }>): string {
  const values = {
    projects: String(result.projects),
    sessions: String(result.sessions),
    safety: result.safetyBackup ?? "",
  };
  return formatMessage(result.safetyBackup ? messages.done : messages.doneNoSafety, values);
}
