import { formatMessage, type ShellLocale } from "./i18n.js";
import type { MaintenanceFailureReason, MaintenanceMode, MaintenanceRunResult } from "./maintenance-types.js";
import { busyText, formatBackupSize, restoreMessages } from "./restore-i18n.js";

export interface MaintenanceMessages {
  readonly heading: string;
  readonly intro: string;
  readonly reclaimable: string;
  readonly reclaimableUnknown: string;
  readonly reclaimWorth: string;
  readonly reclaimNotNeeded: string;
  readonly lastRunLabel: string;
  readonly lastCompleted: string;
  readonly lastFailed: string;
  readonly lastRunning: string;
  readonly lastNone: string;
  readonly lastCheckOk: string;
  readonly lastCheckFailed: string;
  readonly maintain: string;
  readonly maintaining: string;
  readonly check: string;
  readonly checking: string;
  readonly agentsRunning: string;
  readonly cancelled: string;
  readonly noDatabase: string;
  readonly inUse: string;
  readonly missing: string;
  readonly invalid: string;
  readonly integrityFailed: string;
  readonly backupFailed: string;
  readonly failed: string;
  readonly outcomeUnknown: string;
  readonly startFailed: string;
  readonly notRunning: string;
  readonly dataIntact: string;
  readonly doneMaintain: string;
  readonly doneMaintainNothing: string;
  readonly doneCheck: string;
  readonly confirmTitle: string;
  readonly confirmMessage: string;
  readonly confirmDetail: string;
  readonly confirmButton: string;
  readonly cancelButton: string;
}

const zhTW: MaintenanceMessages = {
  heading: "整理資料庫",
  intro:
    "整理會先自動備份，再檢查完整性、壓縮資料庫檔案並重建搜尋索引，需要幾分鐘，期間服務會短暫停止。檢查完整性只讀取資料，不會更動任何東西。",
  reclaimable: "資料庫內有 {size} 的未使用空間，整理後可以還給磁碟。",
  reclaimableUnknown: "服務執行中才能計算可回收的空間。",
  reclaimWorth: "建議整理一次。",
  reclaimNotNeeded: "目前不需要整理。",
  lastRunLabel: "最近一次整理",
  lastCompleted: "已完成（{time}）",
  lastFailed: "沒有完成（{time}）。整理前的備份仍保留在備份資料夾。",
  lastRunning: "上次整理沒有結束（{time}）。整理前的備份仍保留在備份資料夾。",
  lastNone: "還沒有整理過。",
  lastCheckOk: "這次開啟 App 後的完整性檢查：沒有發現問題（{time}）。",
  lastCheckFailed: "這次開啟 App 後的完整性檢查：發現問題（{time}）。請先從備份還原。",
  maintain: "整理資料庫…",
  maintaining: "正在整理…",
  check: "檢查完整性",
  checking: "正在檢查…",
  agentsRunning: "請先關閉 Claude Code / Codex 等 Agent 再整理。它們開著時可能仍在使用資料庫，整理不會開始。",
  cancelled: "已取消，沒有變更任何資料。",
  noDatabase: "尚未設定資料庫，無法整理。",
  inUse: "資料庫正被其他程式使用，整理沒有開始。請關閉會讀取它的程式後再試。原本的資料庫沒有任何變更。",
  missing: "找不到資料庫檔案，整理沒有開始。",
  invalid: "這個檔案無法讀取，或不是 Work Intelligence 的資料庫。沒有變更任何資料。",
  integrityFailed: "資料庫完整性檢查沒有通過，整理已停止。請從備份還原。",
  backupFailed: "整理前的備份失敗，所以整理沒有開始。請確認備份資料夾可以寫入且空間足夠。原本的資料庫沒有任何變更。",
  failed: "整理沒有完成。整理前的備份仍保留在備份資料夾。",
  outcomeUnknown: "整理沒有回報結果，無法確定資料庫目前的狀態。整理前的備份應該在備份資料夾中；請先確認資料是否正常。",
  startFailed: "整理已完成，但服務沒能重新啟動。請到「狀態」分頁查看，或從備份還原。",
  notRunning: "服務目前沒有執行。請到「狀態」分頁按「重試」。",
  dataIntact: "原本的資料庫沒有任何變更。",
  doneMaintain: "整理完成，檔案縮小了 {saved}。整理前的資料已備份為「{backup}」。",
  doneMaintainNothing: "整理完成。整理前的資料已備份為「{backup}」。",
  doneCheck: "完整性檢查完成，沒有發現問題。",
  confirmTitle: "整理資料庫",
  confirmMessage: "要現在整理資料庫嗎？",
  confirmDetail:
    "App 會先自動備份目前的資料，再檢查完整性、壓縮資料庫並重建搜尋索引。服務會短暫停止，完成後自動重新啟動。如果整理失敗，備份仍會保留。",
  confirmButton: "整理",
  cancelButton: "取消",
};

const en: MaintenanceMessages = {
  heading: "Maintain the database",
  intro:
    "Maintenance first makes an automatic backup, then checks integrity, compacts the database file and rebuilds the search index. It takes a few minutes and the service stops briefly. The integrity check only reads your data and changes nothing.",
  reclaimable: "The database holds {size} of unused space that maintenance gives back to the disk.",
  reclaimableUnknown: "The reclaimable space is calculated while the service is running.",
  reclaimWorth: "Worth running once.",
  reclaimNotNeeded: "No need to run it now.",
  lastRunLabel: "Last maintenance",
  lastCompleted: "Completed ({time})",
  lastFailed: "Did not finish ({time}). The backup made before it is still in the backup folder.",
  lastRunning: "The last run did not end ({time}). The backup made before it is still in the backup folder.",
  lastNone: "It has not run yet.",
  lastCheckOk: "Integrity check since the App opened: no problems found ({time}).",
  lastCheckFailed: "Integrity check since the App opened: problems found ({time}). Restore from a backup first.",
  maintain: "Maintain the database…",
  maintaining: "Maintaining…",
  check: "Check integrity",
  checking: "Checking…",
  agentsRunning:
    "Close Claude Code, Codex and other Agents before maintaining. While they are open they may still be using the database, so maintenance will not start.",
  cancelled: "Cancelled. Nothing was changed.",
  noDatabase: "No database is set up yet, so there is nothing to maintain.",
  inUse:
    "Another program is using the database, so maintenance did not start. Close whatever reads it and try again. The original database was not changed.",
  missing: "The database file was not found, so maintenance did not start.",
  invalid: "This file could not be read or is not a Work Intelligence database. Nothing was changed.",
  integrityFailed: "The database failed its integrity check, so maintenance stopped. Restore from a backup.",
  backupFailed:
    "The backup before maintenance failed, so maintenance did not start. Make sure the backup folder is writable and has space. The original database was not changed.",
  failed: "Maintenance did not finish. The backup made before it is still in the backup folder.",
  outcomeUnknown:
    "Maintenance did not report a result, so it is not certain what state the database is in. The backup made before it should be in the backup folder; check that your data looks right first.",
  startFailed:
    "Maintenance finished, but the service could not start again. Check the Status tab, or restore from a backup.",
  notRunning: "The service is not running. Open the Status tab and press Retry.",
  dataIntact: "The original database was not changed.",
  doneMaintain:
    "Maintenance finished and the file is {saved} smaller. The data from before was backed up as “{backup}”.",
  doneMaintainNothing: "Maintenance finished. The data from before was backed up as “{backup}”.",
  doneCheck: "Integrity check finished: no problems found.",
  confirmTitle: "Maintain the database",
  confirmMessage: "Maintain the database now?",
  confirmDetail:
    "The App first makes an automatic backup of the current data, then checks integrity, compacts the database and rebuilds the search index. The service stops briefly and starts again by itself. If maintenance fails, the backup stays.",
  confirmButton: "Maintain",
  cancelButton: "Cancel",
};

export function maintenanceMessages(locale: ShellLocale): MaintenanceMessages {
  return locale === "zh-TW" ? zhTW : en;
}

function timeText(locale: ShellLocale, iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function lastRunText(
  messages: MaintenanceMessages,
  locale: ShellLocale,
  last: { readonly status: "running" | "completed" | "failed"; readonly at: string } | null,
): string {
  if (last === null) return messages.lastNone;
  const time = timeText(locale, last.at);
  const template =
    last.status === "completed"
      ? messages.lastCompleted
      : last.status === "failed"
        ? messages.lastFailed
        : messages.lastRunning;
  return formatMessage(template, { time });
}

export function checkText(
  messages: MaintenanceMessages,
  locale: ShellLocale,
  check: { readonly ok: boolean; readonly at: string },
): string {
  return formatMessage(check.ok ? messages.lastCheckOk : messages.lastCheckFailed, {
    time: timeText(locale, check.at),
  });
}

export function reclaimableText(messages: MaintenanceMessages, bytes: number, suggest: boolean): string {
  return `${formatMessage(messages.reclaimable, { size: formatBackupSize(bytes) })} ${suggest ? messages.reclaimWorth : messages.reclaimNotNeeded}`;
}

function reasonText(messages: MaintenanceMessages, reason: MaintenanceFailureReason): string {
  switch (reason) {
    case "agents-running":
      return messages.agentsRunning;
    case "cancelled":
      return messages.cancelled;
    case "no-database":
      return messages.noDatabase;
    case "in-use":
      return messages.inUse;
    case "missing":
      return messages.missing;
    case "invalid":
      return messages.invalid;
    case "integrity-failed":
      return messages.integrityFailed;
    case "backup-failed":
      return messages.backupFailed;
    case "start-failed":
      return messages.startFailed;
    case "outcome-unknown":
      return messages.outcomeUnknown;
    default:
      return messages.failed;
  }
}

export function maintenanceFailureText(
  messages: MaintenanceMessages,
  locale: ShellLocale,
  result: Extract<MaintenanceRunResult, { ok: false }>,
): string {
  if (result.reason === "busy") return busyText(restoreMessages(locale), result.busy);
  const tail = result.backendRunning || result.reason === "start-failed" ? "" : ` ${messages.notRunning}`;
  const untouched = result.dataIntact && (result.reason === "agents-running" || result.reason === "cancelled");
  return `${reasonText(messages, result.reason)}${untouched && result.reason === "agents-running" ? ` ${messages.dataIntact}` : ""}${tail}`;
}

export function maintenanceSuccessText(
  messages: MaintenanceMessages,
  result: Extract<MaintenanceRunResult, { ok: true }>,
): string {
  if (result.mode === "check") return messages.doneCheck;
  const backup = result.backupFileName ?? "";
  return result.reclaimedBytes
    ? formatMessage(messages.doneMaintain, { saved: formatBackupSize(result.reclaimedBytes), backup })
    : formatMessage(messages.doneMaintainNothing, { backup });
}

export function modeLabels(messages: MaintenanceMessages, mode: MaintenanceMode, working: boolean): string {
  if (mode === "maintain") return working ? messages.maintaining : messages.maintain;
  return working ? messages.checking : messages.check;
}
