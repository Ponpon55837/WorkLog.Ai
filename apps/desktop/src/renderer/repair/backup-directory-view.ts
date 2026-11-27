import type {
  BackupDirectoryChooseResult,
  RepairApi,
  RepairBackupDirectorySection,
} from "@work-intelligence/desktop-core";
import {
  backupDirectoryMessages,
  backupDirectoryResultText,
} from "@work-intelligence/desktop-core/shell/backup-directory-i18n";
import type { ShellLocale } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { actions, button, element, facts, hint, path, section } from "./dom.js";

let working = false;
let answer: { readonly text: string; readonly ok: boolean } | null = null;

export interface BackupDirectoryViewHost {
  readonly api: RepairApi;
  readonly locale: ShellLocale;
  readonly pageBusy: boolean;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function change(host: BackupDirectoryViewHost): Promise<void> {
  if (working) return;
  working = true;
  answer = null;
  host.rerender();
  const result = await host.api
    .chooseBackupDirectory()
    .catch((): BackupDirectoryChooseResult => ({ ok: false, reason: "failed" }));
  working = false;
  const text = backupDirectoryMessages(host.locale);
  const risk = !result.ok && result.risk ? setupMessages(host.locale).storageRisk[result.risk].label : "";
  answer = { text: backupDirectoryResultText(text, host.locale, result, risk), ok: result.ok };
  host.refresh();
  host.rerender();
}

export function backupDirectorySection(
  host: BackupDirectoryViewHost,
  folder: RepairBackupDirectorySection,
): HTMLElement {
  const text = backupDirectoryMessages(host.locale);
  const body: Node[] = [
    hint(text.intro),
    facts([text.current, path(folder.display)]),
    hint(text.notMoved, "div"),
    actions(
      button(
        working ? text.changing : text.change,
        "backup-directory-change",
        !working && !host.pageBusy,
        () => void change(host),
      ),
    ),
  ];
  if (answer) {
    const line = element("p", { className: answer.ok ? "success-text" : "warning-text", text: answer.text });
    line.dataset.id = "backup-directory-answer";
    line.setAttribute("role", "status");
    body.push(line);
  }
  const card = section(text.heading, ...body);
  card.id = "backup-directory-section";
  return card;
}
