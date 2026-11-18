import type { RepairApi, SystemSettingsTarget } from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { actions, button, cardBody, element, hint, section } from "./dom.js";

/** What every view knows about the old login service; where to send the user comes from main, never from the page. */
export interface LegacyFacts {
  readonly running: "running" | "stopped" | "unknown";
  /**
   * Not running now but enabled, so it starts at the next login. The status views only show the block for a stopped
   * service when this is so, which is why the repair window (no such field in its state) infers it from `stopped`.
   */
  readonly startsAtLogin?: boolean;
  /** The OS place that lists the service, for turning it off by hand; absent where the App has none to open. */
  readonly systemSettings?: SystemSettingsTarget;
  readonly portInUse?: boolean;
  readonly blocked?: boolean;
  /** 「停用舊的登入服務…」 is offered; the view adds its controls through `extra`. */
  readonly canDisable?: boolean;
}

/** How long 「仍偵測到…」 stays after 「重新檢查」, which redraws the card from a new state. */
const STILL_THERE_MS = 12_000;
let stillThereUntil = 0;

/**
 * The hand-off for turning the service off by hand: numbered steps, a button that opens the one OS place, and
 * 「重新檢查」. Open at once when the App cannot turn the service off itself; a fold-out below the App's own button
 * otherwise.
 */
function manualSteps(
  api: RepairApi,
  text: SetupMessages,
  target: SystemSettingsTarget,
  open: boolean,
  recheck: () => void,
): HTMLElement {
  const notice = hint(text.legacyStillThere);
  notice.hidden = Date.now() >= stillThereUntil;
  const failed = hint(text.legacyOpenFailed[target]);
  failed.hidden = true;
  const openButton = button(text.legacyOpenSettings[target], "open-system-settings", true, () => {
    void api
      .openSystemSettings(target)
      .then((result) => {
        failed.hidden = result.ok;
      })
      .catch(() => {
        failed.hidden = false;
      });
  });
  const recheckButton = button(text.legacyRecheck, "legacy-recheck", true, () => {
    stillThereUntil = Date.now() + STILL_THERE_MS;
    notice.hidden = false;
    void api
      .legacyRecheck()
      .catch(() => ({ ok: false }))
      .then(recheck);
  });
  const details = element("details", { className: "advanced manual-steps" }, [
    element("summary", { text: text.legacyManualHeading }),
    element(
      "ol",
      { className: "steps" },
      text.legacyManualSteps[target].map((step) => element("li", { text: step })),
    ),
    actions(openButton, recheckButton),
    failed,
    notice,
  ]);
  details.open = open;
  return details;
}

/**
 * The warning, in the words agreed: the old service may use the same database. It never asks for a command: the App
 * turns the service off itself (the view's `extra` controls), and when it cannot, the steps name the OS place to open.
 * 「仍要啟動」 is added by the view that can start.
 */
export function legacyBlock(
  api: RepairApi,
  text: SetupMessages,
  facts: LegacyFacts,
  extra: Node[] = [],
  recheck: () => void = () => undefined,
): HTMLElement {
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
  body.append(...extra);
  if (facts.systemSettings) {
    body.append(manualSteps(api, text, facts.systemSettings, facts.canDisable !== true, recheck));
  }
  return card;
}
