import type { RepairState } from "@work-intelligence/desktop-core";
import {
  errorHintFor,
  errorMessageFor,
  formatMessage,
  type ShellMessages,
} from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { backendTone, databaseLabel, label, ownerTone } from "./badge.js";
import type { ViewContext } from "./context.js";
import { candidatesCard, databaseCard, databasePath, restoreCard } from "./data-view.js";
import { actions, button, cardBody, element, facts, hint, section } from "./dom.js";
import { legacyBlock } from "./legacy-block.js";
import { legacyDisableControls, legacyDisableOutcome, type LegacyDisableHost } from "./legacy-disable-view.js";
import { isBlockingDatabase, recoveryBannerText } from "./view-model.js";

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
    return [legacyBlock(host.api, host.text, state.legacyService, controls, act.refresh)];
  }
  const outcome = legacyDisableOutcome(host);
  return outcome ? [outcome] : [];
}

/** The card shown for a moment after a repair the user started worked: the database and, when known, its project count. */
function recoveredCard(state: RepairState, recovered: NonNullable<RepairState["recovered"]>, messages: ShellMessages) {
  const rows: [string, Node | string][] = [[messages.repairDatabaseHeading, databasePath(state, messages)]];
  if (recovered.projectCount !== undefined) {
    rows.push([
      messages.repairProjectCountLabel,
      formatMessage(messages.repairProjectCount, { count: String(recovered.projectCount) }),
    ]);
  }
  const card = section(messages.repairRecovered, hint(messages.repairRecoveredHint), facts(...rows));
  card.id = "recovered";
  card.classList.add("card--success");
  return card;
}

/** The one-time card after the first run finished in this window: the Setup tab is gone, so the next step is offered here. */
function setupFinishedCard(ctx: ViewContext): HTMLElement {
  const text = setupMessages(ctx.state.locale);
  const card = section(
    text.setupHeading,
    element("p", { className: "intro", text: text.setupDone }),
    hint(text.setupNextAgents),
    actions(
      button(text.setupOpenAgents, "open-agents", true, () => ctx.act.openAgents(), true),
      button(text.setupClose, "close", true, () => ctx.act.dismissFinished()),
    ),
  );
  card.id = "setup-finished";
  card.classList.add("card--success");
  return card;
}

/**
 * One card per operation a crash interrupted: what happened (from the real state start-up recovery verified), what the
 * user can do and where, and a button that dismisses it for good. A notice that needs repair is a warning; the others are
 * calm information.
 */
function recoveryCards(ctx: ViewContext): HTMLElement[] {
  const { state, messages, act } = ctx;
  return state.recoveryNotices.map((notice) => {
    const text = recoveryBannerText(notice, messages);
    const card = section(
      messages.recoveryHeading,
      element("p", { className: "intro", text: text.message }),
      hint(text.nextStep),
      actions(
        ...(text.tab === "status"
          ? []
          : [button(text.openTabLabel, `recovery-open:${notice.id}`, true, () => act.openTab(text.tab), "link")]),
        button(messages.recoveryDismiss, `recovery-dismiss:${notice.id}`, !ctx.busy, () =>
          act.acknowledgeRecovery(notice.id),
        ),
      ),
    );
    card.dataset.id = `recovery-notice:${notice.id}`;
    card.dataset.kind = notice.kind;
    if (notice.kind === "needs-repair") card.classList.add("card--attention");
    return card;
  });
}

function serviceCard(ctx: ViewContext, blocking: boolean): HTMLElement {
  const { state, messages } = ctx;
  const rows: [string, Node | string][] = [
    [messages.ownerLabel, label(messages.owners[state.owner] ?? state.owner, ownerTone(state.owner))],
    [messages.backendLabel, label(messages.backends[state.backend] ?? state.backend, backendTone(state.backend))],
  ];
  // One line about the database; the whole card is on the Data tab (and here, while it is what blocks the service).
  if (!blocking) {
    rows.push([
      messages.databaseStatusLabel,
      element("span", { className: "inline-row" }, [
        databaseLabel(messages, state.database.status),
        button(messages.statusOpenData, "open-data-tab", true, () => ctx.act.openTab("data"), "link"),
      ]),
    ]);
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
  const card = section(messages.repairServiceHeading, facts(...rows));
  if (retry.length > 0) cardBody(card).append(actions(...retry));
  return card;
}

function errorsCard(ctx: ViewContext): HTMLElement {
  const { state, messages } = ctx;
  const errors = element("ul", { className: "list" });
  if (state.recentErrors.length === 0) errors.append(hint(messages.repairNoErrors, "li"));
  const startAnywayAvailable = state.actions.some((action) => action.id === "start-anyway");
  for (const entry of [...state.recentErrors].reverse()) {
    const message = errorMessageFor(messages, entry.code);
    errors.append(
      element("li", { className: "error-item" }, [
        element("strong", { text: message.title }),
        hint(errorHintFor(messages, entry.code, startAnywayAvailable), "div"),
        element("div", { className: "error-code", text: entry.code }),
      ]),
    );
  }
  return section(messages.repairErrorsHeading, errors);
}

export function statusPanel(ctx: ViewContext): Node[] {
  const { state, messages } = ctx;
  const finished = [...(ctx.setupFinished ? [setupFinishedCard(ctx)] : []), ...recoveryCards(ctx)];
  if (state.recovered) return [...finished, recoveredCard(state, state.recovered, messages)];
  const blocking = isBlockingDatabase(state);
  const blocks: Node[] = [...finished, ...legacyCards(ctx)];
  if (state.owner === "NEEDS_REPAIR") {
    blocks.push(element("p", { className: "flash flash--danger", text: messages.repairIntro }));
  }
  blocks.push(serviceCard(ctx, blocking));
  if (blocking) {
    blocks.push(databaseCard(ctx), restoreCard(ctx));
    const candidates = candidatesCard(ctx);
    if (candidates) blocks.push(candidates);
  }
  blocks.push(errorsCard(ctx));
  return blocks;
}
