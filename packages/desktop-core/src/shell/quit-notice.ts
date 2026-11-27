import { formatMessage, shellMessages, type ShellLocale } from "./i18n.js";
import type { LastBackupInfo } from "./last-backup.js";

export interface QuitNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface QuitNoticeInputs {
  readonly locale: ShellLocale;
  readonly lastBackup: LastBackupInfo;
  readonly timeZone?: string;
}

function formatLocalTime(iso: string, locale: ShellLocale, timeZone: string | undefined): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function buildQuitNotice(inputs: QuitNoticeInputs): QuitNotice {
  const messages = shellMessages(inputs.locale);
  const { lastBackup } = inputs;
  let detail = messages.quitUnknownBackup;
  if (lastBackup.status === "none") detail = messages.quitNoBackup;
  if (lastBackup.status === "known") {
    const time = formatLocalTime(lastBackup.at, inputs.locale, inputs.timeZone);
    if (time) detail = formatMessage(messages.quitLastBackup, { time });
  }
  return {
    title: messages.quitTitle,
    message: messages.quitMessage,
    detail,
    confirmLabel: messages.quitConfirm,
    cancelLabel: messages.quitCancel,
  };
}
