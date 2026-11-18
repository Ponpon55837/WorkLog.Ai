import type { RepairActionId, RepairState } from "@work-intelligence/desktop-core";
import { errorMessageFor, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { databaseTone, label } from "./badge.js";
import type { ViewContext } from "./context.js";
import { button, checkbox, element, fact, section } from "./dom.js";
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

/** The database in use: its facts, the storage-risk note, and choose / open-folder actions. */
export function databaseCard(ctx: ViewContext): HTMLElement {
  const { state, messages } = ctx;
  const facts = element("dl", { className: "facts" });
  facts.append(
    ...fact(
      messages.repairDatabaseHeading,
      state.database.display === null
        ? messages.repairNoDatabase
        : element("span", { className: "path", text: state.database.display }),
    ),
    ...fact(
      messages.databaseStatusLabel,
      label(
        messages.databaseStatuses[state.database.status] ?? state.database.status,
        databaseTone(state.database.status),
      ),
    ),
    ...fact(messages.lastBackupLabel, formatBackup(state, messages)),
  );
  const content: Node[] = [facts];
  if (state.database.storageRisk) {
    content.push(storageRiskNote(state.database.storageRisk));
    if (state.database.storageRisk.canCopyToLocal)
      content.push(element("div", { className: "actions" }, [copyButton(ctx, undefined)]));
  }
  const buttons = state.actions
    .filter((action) => DATA_ACTIONS.includes(action.id))
    .map((action) =>
      button(actionLabel(action.id, messages), action.id, action.enabled && !ctx.busy, () =>
        ctx.act.perform(action.id),
      ),
    );
  content.push(element("div", { className: "actions" }, buttons));
  return section(messages.repairDatabaseHeading, ...content);
}

function candidateItem(ctx: ViewContext, candidate: RepairState["candidates"][number]): HTMLElement {
  const { messages, riskTicked } = ctx;
  // Only a database whose read-only preview said "ok" can be confirmed; one that needs a schema update only through the
  // button that says so: pressing it is the user's consent.
  const confirmLabel = candidate.needsMigration ? messages.repairConfirmMigrate : messages.repairConfirmCandidate;
  const parts: Node[] = [
    element("div", { className: "candidate-head" }, [
      element("span", { className: "path", text: candidate.display }),
      // A preview that could not run says why (the runtime is missing, the check timed out, ...).
      label(
        candidate.errorCode
          ? errorMessageFor(messages, candidate.errorCode).title
          : (messages.databaseStatuses[candidate.status] ?? candidate.status),
        candidate.errorCode ? "danger" : databaseTone(candidate.status),
      ),
    ]),
  ];
  const risk = candidate.storageRisk;
  if (risk) parts.push(storageRiskNote(risk));
  if (candidate.canConfirm) {
    if (candidate.needsMigration) parts.push(element("div", { className: "hint", text: messages.repairMigrationNote }));
    // A risky file is confirmed only after the checkbox that states why; main checks it again.
    const consentText = risk?.consent;
    const confirmButton = button(
      confirmLabel,
      `candidate:${candidate.id}`,
      !ctx.busy && (consentText === undefined || riskTicked.has(candidate.id)),
      () => ctx.act.confirm(candidate.id, candidate.needsMigration, consentText !== undefined),
    );
    if (consentText !== undefined) {
      const box = checkbox(consentText, `risk:${candidate.id}`, riskTicked.has(candidate.id), !ctx.busy);
      box.querySelector("input")?.addEventListener("change", (event) => {
        const ticked = (event.target as HTMLInputElement).checked;
        if (ticked) riskTicked.add(candidate.id);
        else riskTicked.delete(candidate.id);
        confirmButton.disabled = ctx.busy || !ticked;
      });
      parts.push(box);
    }
    parts.push(element("div", { className: "actions" }, [confirmButton]));
  } else if (!risk) {
    parts.push(element("div", { className: "hint", text: messages.repairCandidateNotUsable }));
  }
  if (risk?.canCopyToLocal) parts.push(element("div", { className: "actions" }, [copyButton(ctx, candidate.id)]));
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

export function dataPanel(ctx: ViewContext): Node[] {
  const candidates = candidatesCard(ctx);
  return candidates ? [databaseCard(ctx), candidates] : [databaseCard(ctx)];
}
