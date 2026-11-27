import { dialog } from "electron";
import { backupDirectoryMessages, formatMessage, setupMessages } from "@work-intelligence/desktop-core";
import type { StorageRiskResult } from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface BackupDirectoryDialogsOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly autoConfirm: boolean;
}

export function createBackupDirectoryDialogs(options: BackupDirectoryDialogsOptions): {
  chooseFolder(): Promise<string | null>;
  confirmRisk(risk: Exclude<StorageRiskResult["risk"], "none">): Promise<boolean>;
} {
  const { state, window } = options;
  return {
    async chooseFolder() {
      const text = backupDirectoryMessages(state.locale);
      const dialogOptions = {
        title: text.folderTitle,
        properties: ["openDirectory" as const, "createDirectory" as const],
      };
      const owner = window.window();
      const picked = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      const folder = picked.filePaths[0];
      return picked.canceled || !folder ? null : folder;
    },
    async confirmRisk(risk) {
      if (options.autoConfirm) return true;
      const text = backupDirectoryMessages(state.locale);
      const label = setupMessages(state.locale).storageRisk[risk].label;
      const box = {
        type: "warning" as const,
        title: text.riskTitle,
        message: text.riskMessage,
        detail: formatMessage(text.riskDetail, { label }),
        buttons: [text.riskButton, text.cancelButton],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const owner = window.window();
      const { response } = owner ? await dialog.showMessageBox(owner, box) : await dialog.showMessageBox(box);
      return response === 0;
    },
  };
}
