import type { CopyCommandTarget, RepairApi } from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { button, cardBody, element, hint, section } from "./dom.js";

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
  /** 「停用舊的登入服務…」 is offered; the view adds its controls through `extra`. */
  readonly canDisable?: boolean;
}

function commandRow(
  api: RepairApi,
  text: SetupMessages,
  note: string,
  command: string,
  target: CopyCommandTarget,
): HTMLElement {
  const copy = button(text.legacyCopy, `copy:${target}`, true, () => {
    void api.copyCommand(target).then((result) => {
      if (result.ok) copy.textContent = text.legacyCopied;
    });
  });
  return element("div", { className: "command" }, [
    hint(note, "div"),
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
  const card = section(
    text.legacyHeading,
    element("p", { className: "warning-text", text: facts.portInUse ? text.legacyPortInUse : text.legacyWarning }),
    hint(running),
  );
  card.classList.add("card--attention");
  card.id = "legacy-service";
  const body = cardBody(card);
  if (facts.running === "stopped" && !facts.portInUse && facts.startsAtLogin !== false) {
    body.append(hint(text.legacyStartsAtLogin));
  }
  if (facts.blocked) body.append(hint(text.legacyBlocked));
  if (facts.removeCommand) {
    body.append(commandRow(api, text, text.legacyRemoveHint, facts.removeCommand, "legacy-remove"));
  }
  body.append(
    commandRow(
      api,
      text,
      facts.removeCommand ? text.legacyFallbackHint : text.legacyRemoveHint,
      facts.fallbackRemoveCommand,
      "legacy-fallback",
    ),
    ...extra,
  );
  return card;
}
