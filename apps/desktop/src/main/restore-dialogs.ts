import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dialog } from "electron";
import { formatMessage, restoreMessages } from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { RelocateChoice, RelocateDetails, RestoreConfirmDetails } from "./restore.js";
import type { ShellState } from "./state.js";

export interface RestoreDialogsOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  /** Test build only: answer the confirmation with 「還原」 instead of showing it. */
  readonly autoConfirm: boolean;
  /** Test build only: a file whose text is the path the chooser returns (read at each use). */
  readonly chooseFileOverride?: string;
}

/** The decision of the question about missing project folders in the test build: keep the old paths, never block on a dialog. */
const AUTO_RELOCATE: RelocateChoice = "skip";

/** The native chooser and confirmation of 「從備份還原」; main shows them, the page never does. */
export function createRestoreDialogs(options: RestoreDialogsOptions): {
  chooseFile(): Promise<string | null>;
  confirm(details: RestoreConfirmDetails): Promise<boolean>;
  relocate(details: RelocateDetails): Promise<RelocateChoice>;
  chooseFolder(): Promise<string | null>;
} {
  const { state, window } = options;

  async function chooseFile(): Promise<string | null> {
    if (options.chooseFileOverride !== undefined) {
      try {
        const chosen = readFileSync(options.chooseFileOverride, "utf8").trim();
        return isAbsolute(chosen) ? chosen : null;
      } catch {
        return null;
      }
    }
    const text = restoreMessages(state.locale);
    const owner = window.window();
    const dialogOptions = {
      title: text.pickTitle,
      properties: ["openFile" as const],
      filters: [
        { name: text.pickFilter, extensions: ["sqlite", "sqlite3", "db", "bak"] },
        { name: "*", extensions: ["*"] },
      ],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const file = picked.filePaths[0];
    return picked.canceled || !file ? null : file;
  }

  async function confirm(details: RestoreConfirmDetails): Promise<boolean> {
    if (options.autoConfirm) return true;
    const text = restoreMessages(state.locale);
    const box = {
      type: "warning" as const,
      title: text.confirmTitle,
      message: text.confirmMessage,
      detail:
        formatMessage(details.database === null ? text.confirmDetailNoDatabase : text.confirmDetail, {
          database: details.database ?? "",
          time: details.time,
          size: details.size,
        }) +
        (details.remapped > 0
          ? `\n\n${formatMessage(text.confirmRemapLine, { mapped: String(details.remapped) })}`
          : ""),
      buttons: [text.confirmButton, text.cancelButton],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const owner = window.window();
    const { response } = owner ? await dialog.showMessageBox(owner, box) : await dialog.showMessageBox(box);
    return response === 0;
  }

  async function relocate(details: RelocateDetails): Promise<RelocateChoice> {
    if (options.autoConfirm) return AUTO_RELOCATE;
    const text = restoreMessages(state.locale);
    const values = {
      total: String(details.total),
      missing: String(details.missing),
      mapped: String(details.mapped),
    };
    const box = {
      type: "question" as const,
      title: text.relocateTitle,
      message: formatMessage(text.relocateMessage, { ...values, missing: String(details.missing + details.mapped) }),
      detail: [
        details.noMatch ? text.relocateNoMatch : "",
        formatMessage(details.mapped > 0 ? text.relocateDetailPartial : text.relocateDetail, values),
      ]
        .filter((line) => line.length > 0)
        .join("\n\n"),
      buttons: [
        details.mapped > 0 ? text.relocateChooseAnother : text.relocateChoose,
        text.relocateSkip,
        text.cancelButton,
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const owner = window.window();
    const { response } = owner ? await dialog.showMessageBox(owner, box) : await dialog.showMessageBox(box);
    return response === 0 ? "choose" : response === 1 ? "skip" : "cancel";
  }

  async function chooseFolder(): Promise<string | null> {
    const text = restoreMessages(state.locale);
    const owner = window.window();
    const dialogOptions = { title: text.relocateFolderTitle, properties: ["openDirectory" as const] };
    const picked = owner
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const folder = picked.filePaths[0];
    return picked.canceled || !folder ? null : folder;
  }

  return { chooseFile, confirm, relocate, chooseFolder };
}
