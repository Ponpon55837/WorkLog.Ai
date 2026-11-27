import type { RepairApi, SystemSettingsTarget } from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { actions, button, cardBody, element, hint, section } from "./dom.js";

export interface LegacyFacts {
  readonly running: "running" | "stopped" | "unknown";
  readonly startsAtLogin?: boolean;
  readonly systemSettings?: SystemSettingsTarget;
  readonly portInUse?: boolean;
  readonly blocked?: boolean;
  readonly canDisable?: boolean;
}

const STILL_THERE_MS = 12_000;
let stillThereUntil = 0;

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
