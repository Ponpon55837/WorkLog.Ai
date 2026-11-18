import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dialog } from "electron";
import { formatMessage, restoreMessages } from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { RestoreConfirmDetails } from "./restore.js";
import type { ShellState } from "./state.js";

export interface RestoreDialogsOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  /** Test build only: answer the confirmation with 「還原」 instead of showing it. */
  readonly autoConfirm: boolean;
  /** Test build only: a file whose text is the path the chooser returns (read at each use). */
  readonly chooseFileOverride?: string;
}

/** The native chooser and confirmation of 「從備份還原」; main shows them, the page never does. */
export function createRestoreDialogs(options: RestoreDialogsOptions): {
  chooseFile(): Promise<string | null>;
  confirm(details: RestoreConfirmDetails): Promise<boolean>;
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
      detail: formatMessage(details.database === null ? text.confirmDetailNoDatabase : text.confirmDetail, {
        database: details.database ?? "",
        time: details.time,
        size: details.size,
      }),
      buttons: [text.confirmButton, text.cancelButton],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const owner = window.window();
    const { response } = owner ? await dialog.showMessageBox(owner, box) : await dialog.showMessageBox(box);
    return response === 0;
  }

  return { chooseFile, confirm };
}
