import type { RepairApi, RepairLoginItemSection } from "@work-intelligence/desktop-core";
import type { LoginItemMessages } from "@work-intelligence/desktop-core/shell/login-item-i18n";
import { loginItemNote } from "@work-intelligence/desktop-core/shell/login-item-status";
import { checkbox, hint, section } from "./dom.js";

/** The switch was changed and main has not answered yet: keeps it from being changed twice. */
let pending = false;
let failed = false;

export interface LoginItemViewHost {
  readonly api: RepairApi;
  readonly text: LoginItemMessages;
  /** A page action (a retry, a port change) is running: the switch waits. */
  readonly working: boolean;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function change(host: LoginItemViewHost, enable: boolean): Promise<void> {
  if (pending) return;
  pending = true;
  failed = false;
  host.rerender();
  try {
    const answer = await host.api.setLaunchAtLogin(enable);
    failed = !answer.ok;
  } catch {
    failed = true;
  }
  pending = false;
  host.rerender();
  host.refresh();
}

/** The 「登入時自動啟動」 card: one switch, the system's real state, and a sentence when the two disagree. */
export function loginItemSection(host: LoginItemViewHost, item: RepairLoginItemSection): HTMLElement {
  const { text } = host;
  if (!item.supported) {
    const card = section(text.heading, hint(text.unsupported));
    card.id = "login-item-section";
    return card;
  }
  const status =
    item.system === "enabled" ? text.statusOn : item.system === "disabled" ? text.statusOff : text.statusUnknown;
  const note = loginItemNote(item);
  const card = section(
    text.heading,
    hint(text.intro),
    checkbox(
      text.label,
      "launch-at-login",
      item.desired,
      !host.working && !pending,
      (checked) => void change(host, checked),
    ),
    hint(status),
    ...(note === "none" ? [] : [hint(text.notes[note])]),
    ...(failed ? [hint(text.failed)] : []),
  );
  card.id = "login-item-section";
  return card;
}
