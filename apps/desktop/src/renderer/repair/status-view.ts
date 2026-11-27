import type { RepairState } from "@work-intelligence/desktop-core";
import {
  errorHintFor,
  busyReasonText,
  errorMessageFor,
  formatMessage,
  shellMessages,
  type ShellMessages,
} from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { backendTone, databaseLabel, label, ownerTone } from "./badge.js";
import type { ViewContext } from "./context.js";
import { candidatesCard, databaseCard, databasePath, restoreCard } from "./data-view.js";
import { actions, button, cardBody, element, facts, hint, section } from "./dom.js";
import { legacyBlock } from "./legacy-block.js";
import {
  startupFallbackMessages,
  startupFallbackText,
} from "@work-intelligence/desktop-core/shell/startup-fallback-i18n";
import { maintenanceSummary } from "./maintenance-view.js";
import { legacyDisableControls, legacyDisableOutcome, type LegacyDisableHost } from "./legacy-disable-view.js";
import { isBlockingDatabase, recoveryBannerText, retryIsPrimary } from "./view-model.js";

function legacyCards(ctx: ViewContext): Node[] {
  const { state, act } = ctx;
  const host: LegacyDisableHost = {
    api: act.api,
    text: setupMessages(state.locale),
    busyText: (reason) => busyReasonText(shellMessages(state.locale), reason),
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
    if (notice.kind === "needs-repair" || notice.kind === "journal-unreadable") card.classList.add("card--attention");
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
        // While the database waits for an update, the update button on the database card is the main one.
        action.id !== "retry-start" || retryIsPrimary(state),
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

/** What was rolled back to the last working setup, in plain words; shown while it applies and when it did not help. */
function fallbackCard(state: RepairState): HTMLElement {
  const note = state.fallback as NonNullable<RepairState["fallback"]>;
  const card = section(
    startupFallbackMessages(state.locale).heading,
    element("p", { text: startupFallbackText(state.locale, note) }),
  );
  card.id = "startup-fallback";
  card.classList.add(note.kind === "port-restored" ? "card--attention" : "card--danger");
  return card;
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
  if (state.fallback) blocks.push(fallbackCard(state));
  blocks.push(serviceCard(ctx, blocking));
  if (blocking) {
    blocks.push(databaseCard(ctx), restoreCard(ctx));
    const candidates = candidatesCard(ctx);
    if (candidates) blocks.push(candidates);
  }
  if (state.maintenance && !blocking) blocks.push(maintenanceSummary(state.locale, state.maintenance));
  blocks.push(errorsCard(ctx));
  return blocks;
}
