import type { RepairApi, RepairState, RepairActionId } from "@work-intelligence/desktop-core";
import {
  errorHintFor,
  errorMessageFor,
  formatMessage,
  shellMessages,
  type ShellMessages,
} from "@work-intelligence/desktop-core/shell/i18n";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { mountAgents } from "./agents-view.js";
import { element, fact, section } from "./dom.js";
import { legacyBlock } from "./legacy-block.js";
import { legacyDisableControls, legacyDisableOutcome, type LegacyDisableHost } from "./legacy-disable-view.js";
import { mountSetup } from "./setup-view.js";

declare global {
  interface Window {
    readonly workIntelligenceRepair: RepairApi;
  }
}

const REFRESH_MS = 4000;

const app = document.getElementById("app") as HTMLElement;
const statusRegion = document.getElementById("status") as HTMLElement;
let current: RepairState | undefined;
let working = false;

function say(text: string): void {
  statusRegion.textContent = text;
}

function formatBackup(state: RepairState, messages: ShellMessages): string {
  const { lastBackup } = state;
  if (lastBackup.status === "none") return messages.quitNoBackup;
  if (lastBackup.status === "unknown") return messages.quitUnknownBackup;
  return new Intl.DateTimeFormat(state.locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(lastBackup.at),
  );
}

function actionLabel(id: RepairActionId, messages: ShellMessages): string {
  const labels: Record<RepairActionId, string> = {
    "retry-start": messages.actionRetry,
    "choose-database": messages.actionChooseDatabase,
    "open-database-folder": messages.actionOpenDatabaseFolder,
    "open-backups-folder": messages.actionOpenBackups,
    "open-logs-folder": messages.actionOpenLogs,
    "export-diagnostics": messages.actionExport,
    "start-anyway": setupMessages(current?.locale ?? "en").legacyStartAnyway,
  };
  return labels[id];
}

function button(label: string, id: string, enabled: boolean, onClick: () => void, primary = false): HTMLButtonElement {
  const node = element("button", { text: label, className: primary ? "primary" : "" });
  node.type = "button";
  node.dataset.id = id;
  node.disabled = !enabled || working;
  node.addEventListener("click", onClick);
  return node;
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
  card.classList.add("success");
  return card;
}

function render(state: RepairState): void {
  const messages = shellMessages(state.locale);
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined;
  document.documentElement.lang = state.locale === "zh-TW" ? "zh-Hant" : "en";
  document.title = messages.repairWindowTitle;

  if (state.recovered) {
    app.replaceChildren(
      element("h1", { text: messages.repairHeading }),
      recoveredCard(state, state.recovered, messages),
    );
    app.setAttribute("aria-busy", "false");
    return;
  }

  const facts = element("dl", { className: "facts" });
  facts.append(
    ...fact(messages.ownerLabel, messages.owners[state.owner] ?? state.owner),
    ...fact(messages.backendLabel, messages.backends[state.backend] ?? state.backend),
  );

  const databaseFacts = element("dl", { className: "facts" });
  databaseFacts.append(
    ...fact(
      messages.repairDatabaseHeading,
      state.database.display === null
        ? messages.repairNoDatabase
        : element("span", { className: "path", text: state.database.display }),
    ),
    ...fact(messages.databaseStatusLabel, messages.databaseStatuses[state.database.status] ?? state.database.status),
    ...fact(messages.lastBackupLabel, formatBackup(state, messages)),
  );

  const errors = element("ul", { className: "list" });
  if (state.recentErrors.length === 0) errors.append(element("li", { text: messages.repairNoErrors }));
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

  const actions = element("div", { className: "actions" });
  for (const action of state.actions) {
    actions.append(
      button(
        actionLabel(action.id, messages),
        action.id,
        action.enabled,
        () => void perform(action.id, state),
        action.id === "retry-start" || action.id === "start-anyway",
      ),
    );
  }

  const blocks: Node[] = [
    element("h1", { text: messages.repairHeading }),
    element("p", { className: "intro", text: messages.repairIntro }),
    ...legacyCards(state),
    section(messages.repairServiceHeading, facts),
    section(messages.repairDatabaseHeading, databaseFacts),
    section(messages.repairErrorsHeading, errors),
  ];
  if (state.candidates.length > 0) {
    const list = element("ul", { className: "list" });
    for (const candidate of state.candidates) {
      // Only a database whose read-only preview said "ok" can be confirmed; one that needs a schema update only through
      // the button that says so: pressing it is the user's consent.
      const label = candidate.needsMigration ? messages.repairConfirmMigrate : messages.repairConfirmCandidate;
      const parts: (Node | string)[] = [
        element("span", { className: "path", text: candidate.display }),
        " ",
        element("span", {
          className: "hint",
          // A preview that could not run says why (the runtime is missing, the check timed out, ...).
          text: candidate.errorCode
            ? errorMessageFor(messages, candidate.errorCode).title
            : (messages.databaseStatuses[candidate.status] ?? candidate.status),
        }),
        " ",
      ];
      if (candidate.canConfirm) {
        if (candidate.needsMigration)
          parts.push(element("div", { className: "hint", text: messages.repairMigrationNote }));
        parts.push(
          button(label, `candidate:${candidate.id}`, true, () => void confirm(candidate.id, candidate.needsMigration)),
        );
      } else {
        parts.push(element("div", { className: "hint", text: messages.repairCandidateNotUsable }));
      }
      list.append(element("li", {}, parts));
    }
    blocks.push(section(messages.repairCandidates, list));
  }
  blocks.push(section(messages.repairActionsHeading, actions));

  app.replaceChildren(...blocks);
  app.setAttribute("aria-busy", "false");
  if (focusedId) app.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
}

/** The old-service card with 「停用舊的登入服務…」, or after a disable only its outcome. */
function legacyCards(state: RepairState): Node[] {
  const host: LegacyDisableHost = {
    api: window.workIntelligenceRepair,
    text: setupMessages(state.locale),
    rerender: () => {
      if (current) render(current);
    },
    refresh: () => void refresh(),
  };
  if (state.legacyService) {
    const controls = legacyDisableControls(host, state.legacyService.canDisable, !working);
    return [legacyBlock(host.api, host.text, state.legacyService, controls)];
  }
  const outcome = legacyDisableOutcome(host);
  return outcome ? [outcome] : [];
}

function failureText(messages: ShellMessages, errorCode: string | undefined): string {
  return errorCode ? errorMessageFor(messages, errorCode).title : messages.repairFailedGeneric;
}

async function guarded(task: (messages: ShellMessages) => Promise<void>): Promise<void> {
  if (!current || working) return;
  const messages = shellMessages(current.locale);
  working = true;
  say(messages.repairBusy);
  render(current);
  try {
    await task(messages);
  } catch {
    say(messages.repairFailedGeneric);
  } finally {
    working = false;
    await refresh();
  }
}

/** The answer to a request that did not succeed: a restart in progress is shown as such, never as an error. */
function failedAnswer(
  messages: ShellMessages,
  result: { readonly reason: string; readonly errorCode?: string },
): string {
  return result.reason === "busy" ? messages.repairRestarting : failureText(messages, result.errorCode);
}

async function confirm(candidateId: string, allowMigration: boolean): Promise<void> {
  await guarded(async (messages) => {
    const result = await window.workIntelligenceRepair.confirmDatabase(candidateId, allowMigration);
    say(result.ok ? messages.repairDone : failedAnswer(messages, result));
  });
}

async function perform(id: RepairActionId, state: RepairState): Promise<void> {
  const api = window.workIntelligenceRepair;
  await guarded(async (messages) => {
    if (id === "start-anyway") {
      // Starting next to the old login service is the user's explicit choice, asked once more in plain words.
      if (!window.confirm(setupMessages(state.locale).legacyStartAnywayConfirm)) return;
      const result = await api.startAnyway(state.retryOperationId);
      say(result.ok ? messages.repairDone : failedAnswer(messages, result));
    } else if (id === "retry-start") {
      const result = await api.retryStart(state.retryOperationId);
      say(result.ok ? messages.repairDone : failedAnswer(messages, result));
    } else if (id === "choose-database") {
      const result = await api.chooseDatabase();
      say(result.ok || result.reason === "cancelled" ? "" : messages.repairFailedGeneric);
    } else if (id === "export-diagnostics") {
      const result = await api.exportDiagnostics();
      say(result.ok ? messages.repairDone : result.reason === "cancelled" ? "" : messages.repairFailedGeneric);
    } else {
      const target = id === "open-database-folder" ? "database" : id === "open-backups-folder" ? "backups" : "logs";
      const result = await api.openFolder(target);
      say(result.ok ? "" : messages.repairFailedGeneric);
    }
  });
}

async function refresh(): Promise<void> {
  try {
    current = await window.workIntelligenceRepair.getState();
    if (!working) render(current);
  } catch {
    if (current) say(formatMessage(shellMessages(current.locale).repairFailedGeneric, {}));
  }
}

/** Main decides which page this window shows: repair, first-run setup or the Agent page. */
async function mount(): Promise<void> {
  const api = window.workIntelligenceRepair;
  const view = await api.getView().catch(() => "repair" as const);
  if (view === "setup") return mountSetup(app, say, api);
  if (view === "agents") return mountAgents(app, say, api);
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

void mount();
