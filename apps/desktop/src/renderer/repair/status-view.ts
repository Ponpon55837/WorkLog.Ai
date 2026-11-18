import type { RepairState } from "@work-intelligence/desktop-core";
import {
  errorHintFor,
  errorMessageFor,
  formatMessage,
  type ShellMessages,
} from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { backendTone, databaseTone, label, ownerTone } from "./badge.js";
import type { ViewContext } from "./context.js";
import { candidatesCard, databaseCard } from "./data-view.js";
import { button, cardBody, element, fact, section } from "./dom.js";
import { legacyBlock } from "./legacy-block.js";
import { legacyDisableControls, legacyDisableOutcome, type LegacyDisableHost } from "./legacy-disable-view.js";
import { isBlockingDatabase } from "./view-model.js";

/**
 * The Status tab: a compact summary of the service (who runs it, whether it runs, the database in one line), what
 * went wrong lately, and the retry. When the database is what blocks the service, the whole database card and the
 * databases found are here too, so nobody has to look for them on another tab.
 */

/** The old-service card with 「停用舊的登入服務…」, or after a disable only its outcome. */
function legacyCards(ctx: ViewContext): Node[] {
  const { state, act } = ctx;
  const host: LegacyDisableHost = {
    api: act.api,
    text: setupMessages(state.locale),
    rerender: act.rerender,
    refresh: act.refresh,
  };
  if (state.legacyService) {
    const controls = legacyDisableControls(host, state.legacyService.canDisable, !ctx.busy);
    return [legacyBlock(host.api, host.text, state.legacyService, controls)];
  }
  const outcome = legacyDisableOutcome(host);
  return outcome ? [outcome] : [];
}

/** The card shown for a moment after a repair the user started worked: the database and, when known, its project count. */
function recoveredCard(state: RepairState, recovered: NonNullable<RepairState["recovered"]>, messages: ShellMessages) {
  const facts = element("dl", { className: "facts" });
  facts.append(
    ...fact(
      messages.repairDatabaseHeading,
      state.database.display === null
        ? messages.repairNoDatabase
        : element("span", { className: "path", text: state.database.display }),
    ),
  );
  if (recovered.projectCount !== undefined) {
    facts.append(
      ...fact(
        messages.repairProjectCountLabel,
        formatMessage(messages.repairProjectCount, { count: String(recovered.projectCount) }),
      ),
    );
  }
  const card = section(
    messages.repairRecovered,
    element("p", { className: "hint", text: messages.repairRecoveredHint }),
    facts,
  );
  card.id = "recovered";
  card.classList.add("card--success");
  return card;
}

function serviceCard(ctx: ViewContext, blocking: boolean): HTMLElement {
  const { state, messages } = ctx;
  const facts = element("dl", { className: "facts" });
  facts.append(
    ...fact(messages.ownerLabel, label(messages.owners[state.owner] ?? state.owner, ownerTone(state.owner))),
    ...fact(
      messages.backendLabel,
      label(messages.backends[state.backend] ?? state.backend, backendTone(state.backend)),
    ),
  );
  // One line about the database; the whole card is on the Data tab (and here, while it is what blocks the service).
  if (!blocking) {
    facts.append(
      ...fact(
        messages.databaseStatusLabel,
        element("span", { className: "inline-row" }, [
          label(
            messages.databaseStatuses[state.database.status] ?? state.database.status,
            databaseTone(state.database.status),
          ),
          button(messages.statusOpenData, "open-data-tab", true, () => ctx.act.openTab("data"), "link"),
        ]),
      ),
    );
  }
  const retry = state.actions
    .filter((action) => action.id === "retry-start" || action.id === "start-anyway")
    .map((action) =>
      button(
        action.id === "retry-start" ? messages.actionRetry : setupMessages(state.locale).legacyStartAnyway,
        action.id,
        action.enabled && !ctx.busy,
        () => ctx.act.perform(action.id),
        true,
      ),
    );
  const card = section(messages.repairServiceHeading, facts);
  if (retry.length > 0) cardBody(card).append(element("div", { className: "actions" }, retry));
  return card;
}

function errorsCard(ctx: ViewContext): HTMLElement {
  const { state, messages } = ctx;
  const errors = element("ul", { className: "list" });
  if (state.recentErrors.length === 0)
    errors.append(element("li", { className: "hint", text: messages.repairNoErrors }));
  const startAnywayAvailable = state.actions.some((action) => action.id === "start-anyway");
  for (const entry of [...state.recentErrors].reverse()) {
    const message = errorMessageFor(messages, entry.code);
    errors.append(
      element("li", { className: "error-item" }, [
        element("strong", { text: message.title }),
        element("div", { className: "hint", text: errorHintFor(messages, entry.code, startAnywayAvailable) }),
        element("div", { className: "error-code", text: entry.code }),
      ]),
    );
  }
  return section(messages.repairErrorsHeading, errors);
}

export function statusPanel(ctx: ViewContext): Node[] {
  const { state, messages } = ctx;
  if (state.recovered) return [recoveredCard(state, state.recovered, messages)];
  const blocking = isBlockingDatabase(state);
  const blocks: Node[] = [...legacyCards(ctx)];
  if (state.owner === "NEEDS_REPAIR") {
    const flash = element("p", { className: "flash flash--danger", text: messages.repairIntro });
    blocks.push(flash);
  }
  blocks.push(serviceCard(ctx, blocking));
  if (blocking) {
    blocks.push(databaseCard(ctx));
    const candidates = candidatesCard(ctx);
    if (candidates) blocks.push(candidates);
  }
  blocks.push(errorsCard(ctx));
  return blocks;
}
