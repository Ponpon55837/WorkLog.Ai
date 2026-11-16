import { Notification } from "electron";
import { errorMessageFor, formatMessage } from "@work-intelligence/desktop-core";
import type { ShellState } from "./state.js";

/** One system notification for an error code (background mode); nothing when the system has no notifications. */
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
