import type { RepairActionId, RepairState } from "@work-intelligence/desktop-core";
import type { ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { restoreMessages } from "@work-intelligence/desktop-core/shell/restore-i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { databaseLabel } from "./badge.js";
import type { ViewContext } from "./context.js";
import { actions, button, checkbox, element, facts, hint, path, section } from "./dom.js";
import { restoreSection } from "./restore-view.js";
import { storageRiskNote } from "./storage-risk-card.js";

/** The Data tab: the database in use and what can be done with it, the backups, the logs and the databases found. */

const DATA_ACTIONS: readonly RepairActionId[] = [
  "choose-database",
  "open-database-folder",
  "open-backups-folder",
  "open-logs-folder",
];

function formatBackup(state: RepairState, messages: ShellMessages): string {
  const { lastBackup } = state;
  if (lastBackup.status === "none") return messages.quitNoBackup;
  if (lastBackup.status === "unknown") return messages.quitUnknownBackup;
  return new Intl.DateTimeFormat(state.locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(lastBackup.at),
  );
}

function actionLabel(id: RepairActionId, messages: ShellMessages): string {
  const labels: Partial<Record<RepairActionId, string>> = {
    "choose-database": messages.actionChooseDatabase,
    "open-database-folder": messages.actionOpenDatabaseFolder,
    "open-backups-folder": messages.actionOpenBackups,
    "open-logs-folder": messages.actionOpenLogs,
  };
  return labels[id] ?? id;
}

/** 「複製到本機磁碟並改用」 for a candidate, or (no id) for the App's own database. */
function copyButton(ctx: ViewContext, candidateId: string | undefined): HTMLButtonElement {
  return button(
    setupMessages(ctx.state.locale).storageCopyToLocal,
    candidateId === undefined ? "copy-to-local" : `copy-to-local:${candidateId}`,
    !ctx.busy,
    () => ctx.act.copyToLocal(candidateId),
  );
}

/** The database file in use, or the words for "none". */
export function databasePath(state: RepairState, messages: ShellMessages): Node | string {
  return state.database.display === null ? messages.repairNoDatabase : path(state.database.display);
}

/** The database in use: its facts, the storage-risk note, and choose / open-folder actions. */
export function databaseCard(ctx: ViewContext): HTMLElement {
  const { state, messages } = ctx;
  const content: Node[] = [
    facts(
      [messages.repairDatabaseHeading, databasePath(state, messages)],
      [messages.databaseStatusLabel, databaseLabel(messages, state.database.status)],
      [messages.lastBackupLabel, formatBackup(state, messages)],
    ),
  ];
  if (state.database.storageRisk) {
    content.push(storageRiskNote(state.database.storageRisk));
    if (state.database.storageRisk.canCopyToLocal) content.push(actions(copyButton(ctx, undefined)));
  }
  const buttons = state.actions
    .filter((action) => DATA_ACTIONS.includes(action.id))
    .map((action) =>
      button(actionLabel(action.id, messages), action.id, action.enabled && !ctx.busy, () =>
        ctx.act.perform(action.id),
      ),
    );
  content.push(actions(...buttons));
  return section(messages.repairDatabaseHeading, ...content);
}

function candidateItem(ctx: ViewContext, candidate: RepairState["candidates"][number]): HTMLElement {
  const { messages, riskTicked } = ctx;
  // Only a database whose read-only preview said "ok" can be confirmed; one that needs a schema update only through the
  // button that says so: pressing it is the user's consent.
  const confirmLabel = candidate.needsMigration ? messages.repairConfirmMigrate : messages.repairConfirmCandidate;
  const parts: Node[] = [
    element("div", { className: "candidate-head" }, [
      path(candidate.display),
      // A preview that could not run says why (the runtime is missing, the check timed out, ...).
      databaseLabel(messages, candidate.status, candidate.errorCode),
    ]),
  ];
  const risk = candidate.storageRisk;
  if (risk) parts.push(storageRiskNote(risk));
  if (candidate.canConfirm) {
    if (candidate.needsMigration) parts.push(hint(messages.repairMigrationNote, "div"));
    // A risky file is confirmed only after the checkbox that states why; main checks it again.
    const consentText = risk?.consent;
    const confirmButton = button(
      confirmLabel,
      `candidate:${candidate.id}`,
      !ctx.busy && (consentText === undefined || riskTicked.has(candidate.id)),
      () => ctx.act.confirm(candidate.id, candidate.needsMigration, consentText !== undefined),
    );
    if (consentText !== undefined) {
      parts.push(
        checkbox(consentText, `risk:${candidate.id}`, riskTicked.has(candidate.id), !ctx.busy, (ticked) => {
          if (ticked) riskTicked.add(candidate.id);
          else riskTicked.delete(candidate.id);
          confirmButton.disabled = ctx.busy || !ticked;
        }),
      );
    }
    parts.push(actions(confirmButton));
  } else if (!risk) {
    parts.push(hint(messages.repairCandidateNotUsable, "div"));
  }
  if (risk?.canCopyToLocal) parts.push(actions(copyButton(ctx, candidate.id)));
  return element("li", { className: "candidate" }, parts);
}

/** The databases found to choose from; null when there are none. */
export function candidatesCard(ctx: ViewContext): HTMLElement | null {
  const { state, messages } = ctx;
  if (state.candidates.length === 0) return null;
  const list = element("ul", { className: "list" });
  for (const candidate of state.candidates) list.append(candidateItem(ctx, candidate));
  return section(messages.repairCandidates, list);
}

/** 「從備份還原」: the backups of the database in use and a file chooser. Reachable while the database is missing too. */
export function restoreCard(ctx: ViewContext): HTMLElement {
  return restoreSection({
    api: ctx.act.api,
    text: restoreMessages(ctx.state.locale),
    locale: ctx.state.locale,
    pageBusy: ctx.busy,
    rerender: ctx.act.rerender,
    refresh: ctx.act.refresh,
  });
}

export function dataPanel(ctx: ViewContext): Node[] {
  const candidates = candidatesCard(ctx);
  return candidates ? [databaseCard(ctx), restoreCard(ctx), candidates] : [databaseCard(ctx), restoreCard(ctx)];
}
