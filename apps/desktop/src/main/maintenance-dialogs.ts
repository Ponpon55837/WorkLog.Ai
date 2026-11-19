import { dialog } from "electron";
import { maintenanceMessages } from "@work-intelligence/desktop-core";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

export interface MaintenanceDialogsOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  /** Test build only: answer the confirmation with 「整理」 instead of showing it. */
  readonly autoConfirm: boolean;
}

/** The native confirmation of 「整理資料庫」; main shows it, the page never does. Cancel is the default button. */
export function createMaintenanceDialogs(options: MaintenanceDialogsOptions): { confirm(): Promise<boolean> } {
  const { state, window } = options;
  return {
    async confirm() {
      if (options.autoConfirm) return true;
      const text = maintenanceMessages(state.locale);
      const box = {
        type: "question" as const,
        title: text.confirmTitle,
        message: text.confirmMessage,
        detail: text.confirmDetail,
        buttons: [text.confirmButton, text.cancelButton],
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
