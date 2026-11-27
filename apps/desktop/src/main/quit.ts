import { dialog } from "electron";
import {
  buildQuitNotice,
  QuitFlow,
  type BackendSupervisor,
  type LastBackupTracker,
  type ManagedBackendService,
  type OperationCoordinator,
  type StopAttempt,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

export interface QuitOptions {
  readonly state: ShellState;
  readonly supervisor: BackendSupervisor;
  readonly managed: ManagedBackendService;
  readonly coordinator: OperationCoordinator;
  readonly backend: BackendController;
  readonly lastBackup: LastBackupTracker;
  readonly log: Logger;
  readonly autoConfirm: boolean;
  readonly exit: () => void;
}

export function createQuit(options: QuitOptions): (confirmFirst: boolean) => Promise<void> {
  const { state, supervisor, managed, coordinator, backend, lastBackup } = options;

  const flow = new QuitFlow({
    confirm: async () => {
      if (options.autoConfirm) return true;
      const notice = buildQuitNotice({ locale: state.locale, lastBackup: await lastBackup.current() });
      const answer = await dialog.showMessageBox({
        type: "question",
        title: notice.title,
        message: notice.message,
        detail: notice.detail,
        buttons: [notice.confirmLabel, notice.cancelLabel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return answer.response === 0;
    },
    cancelOperation: async () => {
      const current = coordinator.current();
      if (current?.cancellable) coordinator.cancel(current.operationId);
    },
    tryManagedStop: async (): Promise<StopAttempt> => {
      backend.recovery.cancel();
      const stopped = await managed.stop();
      return stopped.status === "stopped" ? { status: "stopped", report: stopped.report } : { status: "busy" };
    },
    forceStop: () => supervisor.stop(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: options.log,
    warnIncompleteStop: async () => {
      // A background launch may show no window: the log line is the record.
      if (state.launchMode === "background") return;
      const text = state.messages();
      await dialog.showMessageBox({
        type: "warning",
        title: text.quitStopIncompleteTitle,
        message: text.quitStopIncompleteMessage,
        buttons: [text.quitStopIncompleteOk],
        noLink: true,
      });
    },
  });

  return async (confirmFirst) => {
    if ((await flow.request({ confirmFirst: confirmFirst && !options.autoConfirm })) === "exit") options.exit();
  };
}
