import type { RepairApi, RepairLoginItemSection } from "@work-intelligence/desktop-core";
import type { LoginItemMessages } from "@work-intelligence/desktop-core/shell/login-item-i18n";
import { loginItemNote } from "@work-intelligence/desktop-core/shell/login-item-status";
import { button, checkbox, hint, section } from "./dom.js";

let pending = false;
let failed = false;

export interface LoginItemViewHost {
  readonly api: RepairApi;
  readonly text: LoginItemMessages;
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

export function loginItemSection(host: LoginItemViewHost, item: RepairLoginItemSection): HTMLElement {
  const { text } = host;
  if (!item.supported) {
    const card = section(text.heading, hint(text.unsupported));
    card.id = "login-item-section";
    return card;
  }
  const status =
    item.system === "enabled"
      ? text.statusOn
      : item.system === "disabled"
        ? text.statusOff
        : item.system === "needs-approval"
          ? text.statusNeedsApproval
          : text.statusUnknown;
  const openFailed = hint(text.openSettingsFailed);
  openFailed.hidden = true;
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
    ...(item.system === "needs-approval"
      ? [
          button(text.openSettings, "open-login-items", true, () => {
            void host.api
              .openSystemSettings("login-items")
              .then((result) => {
                openFailed.hidden = result.ok;
              })
              .catch(() => {
                openFailed.hidden = false;
              });
          }),
          openFailed,
        ]
      : []),
    ...(failed ? [hint(text.failed)] : []),
  );
  card.id = "login-item-section";
  return card;
}
