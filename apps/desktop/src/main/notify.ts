import { Notification } from "electron";
import { errorMessageFor, formatMessage } from "@work-intelligence/desktop-core";
import type { ShellState } from "./state.js";

/** The "ready again" notification after a user-started repair; fail-open, and recorded for tests when given a list. */
export function createRecoveredNotifier(state: ShellState, record?: string[]): () => void {
  return () => {
    const text = state.messages();
    // The record is the contract for black-box tests (a test build only): what the App tried to show.
    record?.push(text.notifyRecoveredTitle);
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title: text.notifyRecoveredTitle, body: text.notifyRecoveredBody }).show();
    } catch {
      // macOS may suppress notifications from an ad-hoc-signed App; the success card and the Dashboard are the signal.
    }
  };
}

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
