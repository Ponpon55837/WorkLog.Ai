import type { ShellLocale } from "./i18n.js";
import type { PortProblem } from "./port-policy.js";

/** The strings of the port change: the Settings tab's section and the native confirmation. */
export interface PortMessages {
  readonly heading: string;
  /** `{port}` is the port the backend serves now. */
  readonly current: string;
  readonly intro: string;
  readonly inputLabel: string;
  readonly apply: string;
  readonly applying: string;
  /** `{port}` is the new port; the Dashboard reopens there. */
  readonly done: string;
  /** Shown after `done` when the change threw away an idle staged import preview. */
  readonly importPreviewDiscarded: string;
  readonly unchanged: string;
  readonly cancelled: string;
  readonly occupied: string;
  readonly notPermitted: string;
  readonly busyOperation: string;
  readonly busyActivity: string;
  readonly busyUnknown: string;
  /** `{port}` is the old port the backend is back on. */
  readonly failedRolledBack: string;
  readonly failedNotRunning: string;
  readonly invalid: string;
  /** Pasted preferences of the Dashboard page wait in memory for this change. */
  readonly handoffNote: string;
  readonly problems: Readonly<Record<PortProblem, string>>;
  /** The native confirmation: `{from}` and `{to}` are ports. */
  readonly confirmMessage: string;
  readonly confirmDetail: string;
  /** Added to the detail when a staged import preview exists: the restart discards it. */
  readonly confirmImportNote: string;
  readonly confirmButton: string;
  readonly cancelButton: string;
}

const zhTW: PortMessages = {
  heading: "連接埠",
  current: "目前的連接埠：{port}",
  intro: "輸入 1024 到 65535 之間的連接埠。變更時服務會短暫重新啟動，並在新的位址重新開啟 Dashboard。",
  inputLabel: "新的連接埠",
  apply: "變更連接埠",
  applying: "正在變更連接埠…",
  done: "已改用連接埠 {port}，Dashboard 已在新的位址開啟。",
  importPreviewDiscarded: "未完成的匯入預覽已捨棄，請在專案頁重新選擇檔案。",
  unchanged: "這已經是目前的連接埠，沒有變更。",
  cancelled: "已取消，沒有變更。",
  occupied: "這個連接埠已被其他程式使用，沒有變更任何設定。請換一個連接埠。",
  notPermitted: "作業系統不允許使用這個連接埠（例如 Windows 保留的範圍），沒有變更任何設定。請換一個連接埠。",
  busyOperation: "App 正在處理另一項操作，請稍後再試。",
  busyActivity: "Dashboard 正在匯入、備份或匯出資料，請等它完成後再變更連接埠。",
  busyUnknown: "暫時無法確認 Dashboard 是否正在處理資料，請稍後再試。",
  failedRolledBack: "無法改用新的連接埠，已回到原來的連接埠 {port}，設定沒有變更。",
  failedNotRunning: "無法改用新的連接埠，原來的連接埠也沒能啟動。請在這裡選另一個連接埠，或按「重試」。",
  invalid: "連接埠不正確。",
  handoffNote: "已記下 Dashboard 的顯示偏好，變更後會一併帶到新的位址。",
  problems: {
    "not-a-number": "請輸入數字。",
    "out-of-range": "連接埠必須在 1024 到 65535 之間。",
    "below-1024": "1024 以下的連接埠不能使用；請輸入 1024 到 65535。",
    "browser-restricted": "瀏覽器會封鎖這個連接埠，Dashboard 將無法開啟；請換一個。",
  },
  confirmMessage: "把連接埠從 {from} 改成 {to}？",
  confirmDetail: "Dashboard 會在新的位址重新開啟，已開啟的頁面中尚未儲存的編輯會遺失。",
  confirmImportNote: "已暫存、等待確認的匯入預覽也會被捨棄，需要重新選擇檔案。",
  confirmButton: "變更",
  cancelButton: "取消",
};

const en: PortMessages = {
  heading: "Port",
  current: "Current port: {port}",
  intro: "Enter a port from 1024 to 65535. The service restarts briefly, and the Dashboard reopens at the new address.",
  inputLabel: "New port",
  apply: "Change port",
  applying: "Changing the port…",
  done: "Now using port {port}; the Dashboard opened at the new address.",
  importPreviewDiscarded: "The unfinished import preview was discarded. Choose the file again on the Projects page.",
  unchanged: "That is already the current port; nothing changed.",
  cancelled: "Cancelled; nothing changed.",
  occupied: "Another program is using this port. Nothing was changed. Pick another port.",
  notPermitted:
    "The operating system does not allow this port (for example a range Windows reserves). Nothing was changed. Pick another port.",
  busyOperation: "The App is busy with another operation. Try again in a moment.",
  busyActivity: "The Dashboard is importing, backing up or exporting. Change the port after it finishes.",
  busyUnknown: "Could not tell whether the Dashboard is busy with your data. Try again in a moment.",
  failedRolledBack: "The new port could not be used; the service is back on the old port {port} and nothing changed.",
  failedNotRunning:
    "The new port could not be used, and the old port did not start either. Pick another port here, or press Retry.",
  invalid: "That port is not valid.",
  handoffNote: "The Dashboard's display preferences are kept and carried to the new address.",
  problems: {
    "not-a-number": "Enter a number.",
    "out-of-range": "The port must be from 1024 to 65535.",
    "below-1024": "Ports below 1024 cannot be used; enter 1024 to 65535.",
    "browser-restricted": "Browsers block this port, so the Dashboard could not open; pick another.",
  },
  confirmMessage: "Change the port from {from} to {to}?",
  confirmDetail: "The Dashboard reopens at the new address, and unsaved edits in pages that are open are lost.",
  confirmImportNote:
    "The staged import preview waiting for your confirmation is also discarded; choose the file again.",
  confirmButton: "Change",
  cancelButton: "Cancel",
};

export function portMessages(locale: ShellLocale): PortMessages {
  return locale === "zh-TW" ? zhTW : en;
}
