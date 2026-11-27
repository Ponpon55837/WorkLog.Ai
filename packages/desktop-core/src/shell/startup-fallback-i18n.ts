import { formatMessage, type ShellLocale } from "./i18n.js";
import type { StartupFallbackNote } from "./startup-fallback.js";

export interface StartupFallbackStrings {
  readonly heading: string;
  readonly restored: string;
  readonly restoredOtherDatabase: string;
  readonly failed: string;
  readonly dataUntouched: string;
}

const zhTW: StartupFallbackStrings = {
  heading: "已回到上次正常的設定",
  restored:
    "連接埠 {wanted} 無法使用，所以服務改用上次正常運作的連接埠 {used}（當時的版本是 {version}）。你設定的連接埠沒有被更改；關閉占用 {wanted} 的程式後重新啟動，就會回到 {wanted}。",
  restoredOtherDatabase: "注意：這個資料庫和上次正常運作時使用的不同。",
  failed: "連接埠 {wanted} 無法使用，改用上次正常運作的連接埠 {tried} 也失敗了，所以停在修復畫面。",
  dataUntouched: "你的資料沒有被更動。",
};

const en: StartupFallbackStrings = {
  heading: "Rolled back to the last working setup",
  restored:
    "Port {wanted} could not be used, so the service runs on port {used}, the one that last worked (with version {version}). The port you chose was not changed; close whatever holds {wanted} and restart to return to it.",
  restoredOtherDatabase: "Note: this is not the database that ran there last time.",
  failed:
    "Port {wanted} could not be used, and the port that last worked ({tried}) failed too, so the App stays in repair.",
  dataUntouched: "Your data was not changed.",
};

export function startupFallbackMessages(locale: ShellLocale): StartupFallbackStrings {
  return locale === "zh-TW" ? zhTW : en;
}

export function startupFallbackText(locale: ShellLocale, note: StartupFallbackNote): string {
  const text = startupFallbackMessages(locale);
  if (note.kind === "port-restored") {
    const base = formatMessage(text.restored, {
      wanted: String(note.wantedPort),
      used: String(note.usedPort),
      version: note.runtimeVersion,
    });
    return note.sameDatabase ? base : `${base} ${text.restoredOtherDatabase}`;
  }
  const failed = formatMessage(text.failed, { wanted: String(note.wantedPort), tried: String(note.triedPort) });
  return `${failed} ${text.dataUntouched}`;
}
