import type { CopyCommandTarget, RepairApi } from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { button, element } from "./dom.js";

/** What every view knows about the old login service; the commands come from main's detection, never from the page. */
export interface LegacyFacts {
  readonly running: "running" | "stopped" | "unknown";
  /**
   * Not running now but enabled, so it starts at the next login. The status views only show the block for a stopped
   * service when this is so, which is why the repair window (no such field in its state) infers it from `stopped`.
   */
  readonly startsAtLogin?: boolean;
  readonly removeCommand?: string;
  readonly fallbackRemoveCommand: string;
  readonly portInUse?: boolean;
  readonly blocked?: boolean;
}

function commandRow(
  api: RepairApi,
  text: SetupMessages,
  hint: string,
  command: string,
  target: CopyCommandTarget,
): HTMLElement {
  const copy = button(text.legacyCopy, `copy:${target}`, true, () => {
    void api.copyCommand(target).then((result) => {
      if (result.ok) copy.textContent = text.legacyCopied;
    });
  });
  return element("div", { className: "command" }, [
    element("div", { className: "hint", text: hint }),
    element("code", { className: "command-text", text: command }),
    copy,
  ]);
}

/**
 * The warning, word for word as agreed: the old service (`pnpm bootstrap`) may use the same database. It shows the exact
 * removal command with a copy button; "仍要啟動" is added by the view that can start.
 */
export function legacyBlock(api: RepairApi, text: SetupMessages, facts: LegacyFacts, extra: Node[] = []): HTMLElement {
  const running =
    facts.running === "running"
      ? text.legacyRunning
      : facts.running === "stopped"
        ? text.legacyStopped
        : text.legacyUnknown;
  const card = element("section", { className: "card warning" }, [
    element("h2", { text: text.legacyHeading }),
    element("p", { className: "warning-text", text: facts.portInUse ? text.legacyPortInUse : text.legacyWarning }),
    element("p", { className: "hint", text: running }),
  ]);
  if (facts.running === "stopped" && !facts.portInUse && facts.startsAtLogin !== false) {
    card.append(element("p", { className: "hint", text: text.legacyStartsAtLogin }));
  }
  card.id = "legacy-service";
  if (facts.blocked) card.append(element("p", { className: "hint", text: text.legacyBlocked }));
  if (facts.removeCommand) {
    card.append(commandRow(api, text, text.legacyRemoveHint, facts.removeCommand, "legacy-remove"));
    card.append(commandRow(api, text, text.legacyFallbackHint, facts.fallbackRemoveCommand, "legacy-fallback"));
  } else {
    card.append(commandRow(api, text, text.legacyRemoveHint, facts.fallbackRemoveCommand, "legacy-fallback"));
  }
  card.append(...extra);
  return card;
}
