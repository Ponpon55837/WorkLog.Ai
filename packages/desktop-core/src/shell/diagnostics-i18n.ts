import type { DiagnosticsReport } from "./diagnostics.js";
import { formatMessage, type ShellLocale } from "./i18n.js";

export interface DiagnosticsMessages {
  readonly heading: string;
  readonly tabIntro: string;
  readonly intro: string;
  readonly textLabel: string;
  readonly summary: string;
  readonly scanMasked: string;
  readonly detailsDropped: string;
  readonly truncated: string;
  readonly save: string;
  readonly cancel: string;
  readonly saved: string;
  readonly refreshed: string;
  readonly saveFailed: string;
  readonly previewFailed: string;
  readonly scanFailed: string;
}

const zhTW: DiagnosticsMessages = {
  heading: "診斷資訊預覽",
  tabIntro:
    "需要協助時，可匯出一份診斷檔案。儲存前會先顯示完整內容，並已遮蔽個人路徑、授權碼與電子郵件；App 不會上傳或自動傳送這份檔案。",
  intro:
    "以下是將儲存的完整內容，已遮蔽個人路徑、授權碼與電子郵件，且不含工作內容。App 不會上傳這份檔案，也不會自動傳送給任何人。",
  textLabel: "診斷資訊內容（唯讀）",
  summary:
    "已遮蔽：路徑 {paths}、授權碼 {authCodes}、權杖 {tokens}、電子郵件 {emails}；略過 {omitted} 行非本 App 的輸出",
  scanMasked: "第二次掃描另外補遮蔽了 {count} 處。",
  detailsDropped: "{count} 行本 App 的紀錄只保留固定文字，已省略其後的錯誤細節。",
  truncated: "內容超過大小上限，已省略最舊的 {bytes} 位元組。",
  save: "儲存檔案…",
  cancel: "取消",
  saved: "已儲存診斷檔案。",
  refreshed: "預覽已過期，已重新產生；請確認內容後再儲存。",
  saveFailed: "無法儲存檔案，請再試一次。",
  previewFailed: "無法產生診斷資訊，請再試一次。",
  scanFailed: "最後的檢查仍發現可能的個人資訊或授權碼，為了安全沒有產生檔案。",
};

const en: DiagnosticsMessages = {
  heading: "Diagnostics preview",
  tabIntro:
    "When you need help, export a diagnostics file. The full content is shown before anything is saved, with personal paths, auth codes and e-mail addresses masked; the App does not upload or send the file anywhere.",
  intro:
    "This is the full content that will be saved, with personal paths, auth codes and e-mail addresses masked and no work content. The App does not upload this file or send it to anyone.",
  textLabel: "Diagnostics content (read-only)",
  summary:
    "Masked: paths {paths}, auth codes {authCodes}, tokens {tokens}, e-mail addresses {emails}; skipped {omitted} lines of output that were not this App's",
  scanMasked: "The second scan masked {count} more.",
  detailsDropped:
    "{count} lines of the App's own log kept only their fixed text; the error detail after it was left out.",
  truncated: "The content passed the size limit; the oldest {bytes} bytes were left out.",
  save: "Save file…",
  cancel: "Cancel",
  saved: "The diagnostics file was saved.",
  refreshed: "The preview had expired and was made again; check it before saving.",
  saveFailed: "The file could not be saved. Please try again.",
  previewFailed: "The diagnostics could not be prepared. Please try again.",
  scanFailed: "A final check still found what may be personal information or a secret, so no file was made.",
};

export function diagnosticsMessages(locale: ShellLocale): DiagnosticsMessages {
  return locale === "zh-TW" ? zhTW : en;
}

export function diagnosticsSummaryLines(messages: DiagnosticsMessages, report: DiagnosticsReport): string[] {
  const lines = [
    formatMessage(messages.summary, {
      paths: String(report.categories.paths),
      authCodes: String(report.categories.authCodes),
      tokens: String(report.categories.tokens),
      emails: String(report.categories.emails),
      omitted: String(report.omittedOutputLines),
    }),
  ];
  if (report.maskedInScan > 0) lines.push(formatMessage(messages.scanMasked, { count: String(report.maskedInScan) }));
  if ((report.droppedDetails ?? 0) > 0)
    lines.push(formatMessage(messages.detailsDropped, { count: String(report.droppedDetails) }));
  if (report.truncatedBytes > 0)
    lines.push(formatMessage(messages.truncated, { bytes: String(report.truncatedBytes) }));
  return lines;
}
