import { Notification } from "electron";
import { errorMessageFor, formatMessage } from "@work-intelligence/desktop-core";
import type { ShellState } from "./state.js";

export function createRecoveredNotifier(state: ShellState, record?: string[]): () => void {
  return () => {
    const text = state.messages();
    record?.push(text.notifyRecoveredTitle);
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title: text.notifyRecoveredTitle, body: text.notifyRecoveredBody }).show();
    } catch {
      // macOS may suppress notifications from an ad-hoc-signed App; the success card and the Dashboard are the signal.
    }
  };
}

export function createErrorNotifier(state: ShellState): (code: string) => void {
  return (code) => {
    if (!Notification.isSupported()) return;
    const text = state.messages();
    new Notification({
      title: text.notifyTitle,
      body: formatMessage(text.notifyBody, { title: errorMessageFor(text, code).title }),
    }).show();
  };
}
