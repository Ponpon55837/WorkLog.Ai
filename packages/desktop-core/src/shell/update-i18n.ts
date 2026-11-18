import type { UpdatePlatform } from "../update-check/result.js";
import type { ShellLocale } from "./i18n.js";

/** The strings of the manual update check: the tray item and the repair window's 「更新」 card. */
export interface UpdateMessages {
  readonly trayCheckUpdates: string;
  readonly heading: string;
  /** The App never checks by itself: pressing the button is the consent to ask GitHub. */
  readonly intro: string;
  /** `{version}` is the running version. */
  readonly current: string;
  readonly check: string;
  readonly checking: string;
  readonly upToDate: string;
  /** `{version}` is the newer version. */
  readonly newerVersion: string;
  /** `{date}` is the publish date. */
  readonly published: string;
  readonly notesHeading: string;
  readonly notesTruncated: string;
  readonly downloadAsset: Readonly<Record<UpdatePlatform, string>>;
  readonly openPage: string;
  readonly verifyHint: string;
  /** ADR-38: the installers are not signed. */
  readonly unsignedNote: string;
  /** Windows on ARM, Linux and other platforms: only the release page is offered. */
  readonly noInstaller: string;
  readonly offline: string;
  readonly timedOut: string;
  /** `{time}` is when GitHub lifts the limit. */
  readonly rateLimitedUntil: string;
  readonly rateLimited: string;
  /** `{code}` is a short reason code. */
  readonly failed: string;
  readonly linkFailed: string;
}

const zhTW: UpdateMessages = {
  trayCheckUpdates: "檢查更新…",
  heading: "更新",
  intro: "App 不會自動檢查更新。按下「檢查更新」後，才會連線到 GitHub 查詢最新版本。",
  current: "目前版本：{version}",
  check: "檢查更新",
  checking: "正在檢查更新…",
  upToDate: "已是最新版本",
  newerVersion: "有新版本：{version}",
  published: "發佈日期：{date}",
  notesHeading: "更新內容",
  notesTruncated: "完整內容請見發行頁面",
  downloadAsset: { windows: "下載 Windows 安裝檔", macos: "下載 macOS 安裝檔" },
  openPage: "開啟發行頁面",
  verifyHint: "下載後，請用發行頁面上的 SHA256SUMS.txt 驗證檔案。",
  unsignedNote:
    "安裝檔未經簽署（macOS 為 ad-hoc 簽署，Windows 未簽署），安裝時 Gatekeeper 或 SmartScreen 可能出現提示。請手動安裝，你的資料會保留。",
  noInstaller: "這個平台沒有提供安裝檔，請到發行頁面查看。",
  offline: "無法連線到 GitHub，請確認網路後再試一次。",
  timedOut: "連線逾時，請確認網路後再試一次。",
  rateLimitedUntil: "GitHub 暫時限制了查詢次數，請在 {time} 之後再試。",
  rateLimited: "GitHub 暫時限制了查詢次數，請稍後再試。",
  failed: "無法取得更新資訊，請稍後再試。（代碼：{code}）",
  linkFailed: "無法開啟連結。",
};

const en: UpdateMessages = {
  trayCheckUpdates: "Check for updates…",
  heading: "Updates",
  intro:
    "The App never checks for updates by itself. Only when you press 'Check for updates' does it ask GitHub for the latest version.",
  current: "Current version: {version}",
  check: "Check for updates",
  checking: "Checking for updates…",
  upToDate: "You are up to date",
  newerVersion: "A newer version is available: {version}",
  published: "Published: {date}",
  notesHeading: "Release notes",
  notesTruncated: "See the release page for the full text",
  downloadAsset: { windows: "Download the Windows installer", macos: "Download the macOS installer" },
  openPage: "Open the release page",
  verifyHint: "After downloading, verify the file with SHA256SUMS.txt from the release page.",
  unsignedNote:
    "The installers are not signed (ad-hoc signed on macOS, unsigned on Windows), so Gatekeeper or SmartScreen may show a prompt. Install manually; your data is kept.",
  noInstaller: "No installer is published for this platform; see the release page.",
  offline: "Cannot reach GitHub. Check your network and try again.",
  timedOut: "The connection timed out. Check your network and try again.",
  rateLimitedUntil: "GitHub is limiting requests for now. Try again after {time}.",
  rateLimited: "GitHub is limiting requests for now. Try again later.",
  failed: "Could not get the update information. Try again later. (code: {code})",
  linkFailed: "Could not open the link.",
};

export function updateMessages(locale: ShellLocale): UpdateMessages {
  return locale === "zh-TW" ? zhTW : en;
}
