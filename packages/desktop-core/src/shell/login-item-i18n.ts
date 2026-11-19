import type { ShellLocale } from "./i18n.js";
import type { LoginItemNote } from "./login-item-status.js";

/** The strings of the Settings tab's login-item switch. None of them is, or contains, a command. */
export interface LoginItemMessages {
  readonly heading: string;
  readonly label: string;
  readonly intro: string;
  readonly statusOn: string;
  readonly statusOff: string;
  readonly statusUnknown: string;
  readonly statusNeedsApproval: string;
  readonly openSettings: string;
  readonly openSettingsFailed: string;
  readonly unsupported: string;
  readonly failed: string;
  readonly notes: Readonly<Record<Exclude<LoginItemNote, "none">, string>>;
}

const zhTW: LoginItemMessages = {
  heading: "登入時自動啟動",
  label: "登入電腦時自動啟動 WorkLog.Ai",
  intro: "開啟後，登入電腦時 App 會在背景啟動，不會跳出視窗。你可以隨時在這裡關閉。",
  statusOn: "目前實際狀態：已開啟",
  statusOff: "目前實際狀態：已關閉",
  statusUnknown: "目前實際狀態：無法確認",
  statusNeedsApproval: "目前實際狀態：需要在系統設定核准",
  openSettings: "開啟系統設定的登入項目",
  openSettingsFailed: "無法開啟系統設定，請自行從系統設定進入登入項目。",
  unsupported: "這個作業系統不支援登入時自動啟動。",
  failed: "無法變更這項設定，請稍後再試。",
  notes: {
    "disabled-by-system":
      "你已開啟這項設定，但系統設定裡的啟動項目被關掉了，所以登入時不會自動啟動。請在系統的啟動項目設定中重新允許 WorkLog.Ai。",
    "needs-approval":
      "你已開啟這項設定，但系統還在等你核准這個啟動項目，核准前登入時不會自動啟動。請在系統設定的登入項目中核准 WorkLog.Ai。",
    "enabled-outside-app": "你在這裡把它關閉了，但系統的登入項目仍有 WorkLog.Ai。請在系統設定的啟動項目中移除。",
    unknown: "無法從系統確認實際狀態，下方開關只代表你在 App 裡的選擇。",
  },
};

const en: LoginItemMessages = {
  heading: "Start at login",
  label: "Start WorkLog.Ai when I sign in",
  intro:
    "When on, the App starts in the background when you sign in, without opening a window. You can turn it off here at any time.",
  statusOn: "Current system state: on",
  statusOff: "Current system state: off",
  statusUnknown: "Current system state: could not be confirmed",
  statusNeedsApproval: "Current system state: needs approval in System Settings",
  openSettings: "Open Login Items in System Settings",
  openSettingsFailed: "Could not open System Settings. Open Login Items there yourself.",
  unsupported: "This operating system does not support starting at login.",
  failed: "Could not change this setting. Try again later.",
  notes: {
    "disabled-by-system":
      "You turned this on, but the system's startup settings have WorkLog.Ai turned off, so it will not start at login. Allow WorkLog.Ai again in the system's startup settings.",
    "needs-approval":
      "You turned this on, but the system is waiting for you to approve the login item, so it will not start at login yet. Approve WorkLog.Ai in the system's login items settings.",
    "enabled-outside-app":
      "You turned this off here, but the system still lists WorkLog.Ai as a login item. Remove it in the system's startup settings.",
    unknown: "The system's actual state could not be confirmed; the switch only shows your choice in the App.",
  },
};

export function loginItemMessages(locale: ShellLocale): LoginItemMessages {
  return locale === "zh-TW" ? zhTW : en;
}
