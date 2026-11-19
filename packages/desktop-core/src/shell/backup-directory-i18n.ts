import { formatMessage, type ShellLocale } from "./i18n.js";
import type { BackupDirectoryChooseResult } from "./backup-directory.js";
import { busyText, restoreMessages } from "./restore-i18n.js";

/** The strings of 「備份位置」: the card, its answers and the native confirmation for a risky folder. */
export interface BackupDirectoryMessages {
  readonly heading: string;
  readonly intro: string;
  readonly current: string;
  /** Said next to the button, before and after a change: the old backups are not moved. */
  readonly notMoved: string;
  readonly change: string;
  readonly changing: string;
  readonly folderTitle: string;
  readonly cancelled: string;
  readonly noSettings: string;
  readonly notWritable: string;
  /** `{label}` is the kind of storage (network drive, external drive...). */
  readonly refused: string;
  readonly declined: string;
  readonly startFailed: string;
  readonly failed: string;
  /** `{folder}` is the new folder. */
  readonly done: string;
  readonly riskTitle: string;
  readonly riskMessage: string;
  /** `{label}` is the kind of storage. */
  readonly riskDetail: string;
  readonly riskButton: string;
  readonly cancelButton: string;
}

const zhTW: BackupDirectoryMessages = {
  heading: "備份位置",
  intro: "App 自動備份和整理資料庫前的備份，都會存在這個資料夾。",
  current: "目前的備份資料夾",
  notMoved:
    "更換位置只影響之後的備份：已經存在的備份不會被移動或刪除，仍留在原來的資料夾；從備份還原時可以用「選擇備份檔…」找到它們。",
  change: "更換備份位置…",
  changing: "正在更換…",
  folderTitle: "選擇存放備份的資料夾",
  cancelled: "已取消，備份位置沒有變更。",
  noSettings: "還沒有完成首次設定，無法更換備份位置。",
  notWritable: "這個資料夾無法寫入，備份位置沒有變更。請選擇一個你有權限寫入、而且空間足夠的資料夾。",
  refused:
    "這個資料夾在「{label}」上，備份可能寫到一半就中斷，所以 App 不使用它。備份位置沒有變更。請選擇這台電腦的本機磁碟。",
  declined: "已取消，備份位置沒有變更。",
  startFailed: "備份位置已改回原來的設定，但服務沒能重新啟動。請到「狀態」分頁按「重試」。",
  failed: "更換備份位置沒有完成，備份位置沒有變更。",
  done: "之後的備份會存到「{folder}」。已經存在的備份沒有被移動，仍在原來的資料夾。",
  riskTitle: "這個資料夾可能不適合放備份",
  riskMessage: "要使用這個資料夾存放備份嗎？",
  riskDetail:
    "這個資料夾在「{label}」上。備份可能在你需要它的時候讀不到、不完整，或被同步軟體改動。建議改用這台電腦的本機磁碟。",
  riskButton: "仍要使用",
  cancelButton: "取消",
};

const en: BackupDirectoryMessages = {
  heading: "Backup location",
  intro:
    "The App's automatic backups, and the backup it makes before maintaining the database, are stored in this folder.",
  current: "Current backup folder",
  notMoved:
    "Changing the location affects later backups only: backups that already exist are not moved or deleted and stay in their old folder. When restoring, use “Choose a backup file…” to find them.",
  change: "Change the backup location…",
  changing: "Changing…",
  folderTitle: "Choose the folder for backups",
  cancelled: "Cancelled. The backup location was not changed.",
  noSettings: "The first-run setup is not finished, so the backup location cannot be changed.",
  notWritable:
    "This folder cannot be written to, so the backup location was not changed. Choose a folder you may write to and that has enough space.",
  refused:
    "This folder is on a {label}, where a backup can be cut off half way, so the App does not use it. The backup location was not changed. Choose a local disk of this computer.",
  declined: "Cancelled. The backup location was not changed.",
  startFailed:
    "The backup location was set back, but the service could not start again. Open the Status tab and press Retry.",
  failed: "Changing the backup location did not finish. The backup location was not changed.",
  done: "Later backups go to “{folder}”. Backups that already exist were not moved and stay in their old folder.",
  riskTitle: "This folder may not be a good place for backups",
  riskMessage: "Use this folder for backups?",
  riskDetail:
    "This folder is on a {label}. A backup there may be unreadable when you need it, incomplete, or changed by sync software. A local disk of this computer is safer.",
  riskButton: "Use it anyway",
  cancelButton: "Cancel",
};

export function backupDirectoryMessages(locale: ShellLocale): BackupDirectoryMessages {
  return locale === "zh-TW" ? zhTW : en;
}

/** The sentence for an answer; `label` names the storage kind when the answer has one. */
export function backupDirectoryResultText(
  messages: BackupDirectoryMessages,
  locale: ShellLocale,
  result: BackupDirectoryChooseResult,
  label: string,
): string {
  if (result.ok) return formatMessage(messages.done, { folder: result.display });
  switch (result.reason) {
    case "busy":
      return busyText(restoreMessages(locale), result.busy);
    case "cancelled":
      return messages.cancelled;
    case "no-settings":
      return messages.noSettings;
    case "not-writable":
      return messages.notWritable;
    case "refused":
      return formatMessage(messages.refused, { label });
    case "declined":
      return messages.declined;
    case "start-failed":
      return messages.startFailed;
    default:
      return messages.failed;
  }
}
