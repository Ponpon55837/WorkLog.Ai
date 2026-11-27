import type {
  RepairApi,
  RestoreBackupView,
  RestoreListResult,
  RestorePickResult,
  RestoreRunResult,
} from "@work-intelligence/desktop-core";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import {
  formatBackupSize,
  pickFailureText,
  runFailureText,
  runSuccessText,
  type RestoreMessages,
} from "@work-intelligence/desktop-core/shell/restore-i18n";
import { actions, button, element, facts, hint, path, section } from "./dom.js";

type ListedOk = Extract<RestoreListResult, { ok: true }>;
type ListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: ListedOk }
  | { readonly kind: "failed" };

let listState: ListState = { kind: "idle" };
let picked: RestoreBackupView | null = null;
let answer: { readonly text: string; readonly ok: boolean } | null = null;
let working = false;

export interface RestoreViewHost {
  readonly api: RepairApi;
  readonly text: RestoreMessages;
  readonly locale: string;
  readonly pageBusy: boolean;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function load(host: RestoreViewHost): Promise<void> {
  listState = { kind: "loading" };
  host.rerender();
  const result = await host.api.restoreList().catch((): RestoreListResult => ({ ok: false, reason: "failed" }));
  listState = result.ok ? { kind: "ready", result } : { kind: "failed" };
  host.rerender();
}

async function choose(host: RestoreViewHost): Promise<void> {
  if (working) return;
  working = true;
  answer = null;
  host.rerender();
  const result = await host.api.restorePick().catch((): RestorePickResult => ({ ok: false, reason: "failed" }));
  working = false;
  if (result.ok) {
    picked = result.backup;
  } else if (result.reason !== "cancelled") {
    picked = null;
    answer = { text: pickFailureText(host.text, result), ok: false };
  }
  host.rerender();
}

async function restore(host: RestoreViewHost, backup: RestoreBackupView): Promise<void> {
  if (working || backup.backupId === undefined) return;
  working = true;
  answer = null;
  host.rerender();
  const result = await host.api
    .restoreRun(backup.backupId)
    .catch((): RestoreRunResult => ({ ok: false, reason: "failed", dataIntact: true, backendRunning: true }));
  working = false;
  if (result.ok) answer = { text: runSuccessText(host.text, result), ok: true };
  else {
    answer = {
      text: runFailureText(host.text, {
        ...result,
        dataIntact: result.dataIntact ?? true,
        backendRunning: result.backendRunning ?? true,
      }),
      ok: false,
    };
  }
  // The one-time ids are spent or stale: list again.
  picked = null;
  host.refresh();
  await load(host);
}

function when(host: RestoreViewHost, backup: RestoreBackupView): string {
  if (backup.createdAt === null) return host.text.unknownTime;
  const date = new Date(backup.createdAt);
  return Number.isNaN(date.getTime())
    ? host.text.unknownTime
    : new Intl.DateTimeFormat(host.locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function backupItem(host: RestoreViewHost, backup: RestoreBackupView, id: string): HTMLElement {
  const { text } = host;
  const parts: Node[] = [
    element("div", { className: "candidate-head" }, [
      element("strong", { text: text.labels[backup.label] }),
      path(backup.fileName),
    ]),
    facts([text.factTime, when(host, backup)], [text.factSize, formatBackupSize(backup.bytes)]),
  ];
  if (backup.schemaVersion !== null && backup.projects !== null && backup.sessions !== null) {
    const content = formatMessage(text.factContent, {
      projects: String(backup.projects),
      sessions: String(backup.sessions),
    });
    parts.push(
      hint(`${formatMessage(text.factVersion, { version: String(backup.schemaVersion) })} · ${content}`, "div"),
    );
  }
  if (backup.problem !== null) {
    const reason = element("p", { className: "warning-text", text: text.problems[backup.problem] });
    reason.dataset.id = `${id}-problem`;
    parts.push(reason);
  } else {
    parts.push(
      actions(
        button(
          working ? text.restoring : text.restore,
          `${id}-run`,
          !working && !host.pageBusy && backup.backupId !== undefined,
          () => void restore(host, backup),
          true,
        ),
      ),
    );
  }
  const item = element("li", { className: "candidate" }, parts);
  item.dataset.id = id;
  return item;
}

/** The card. The first draw asks main for the list; later draws use what is held here. */
export function restoreSection(host: RestoreViewHost): HTMLElement {
  const { text } = host;
  if (listState.kind === "idle") queueMicrotask(() => void load(host));
  const body: Node[] = [hint(text.intro)];
  const ready = listState.kind === "ready" ? listState.result : null;
  if (ready?.agentsRunning) {
    const warning = element("p", { className: "warning-text", text: text.agentsRunning });
    warning.dataset.id = "restore-agents";
    body.push(warning);
  }
  if (picked) {
    const list = element("ul", { className: "list" });
    list.append(backupItem(host, picked, "restore-picked"));
    body.push(list);
  }
  if (listState.kind === "loading" || listState.kind === "idle") body.push(hint(text.loading));
  else if (listState.kind === "failed") body.push(element("p", { className: "warning-text", text: text.listFailed }));
  else if (ready) {
    if (ready.noDatabase) body.push(hint(text.noDatabase));
    else {
      if (!ready.directoryReadable) body.push(hint(text.folderUnreadable));
      else if (ready.backups.length === 0) body.push(hint(text.noBackups));
      if (ready.backups.length > 0) {
        const list = element("ul", { className: "list" });
        ready.backups.forEach((backup, index) => list.append(backupItem(host, backup, `restore-item-${index}`)));
        body.push(element("h3", { className: "card-subhead", text: text.listHeading }), list);
      }
    }
  }
  const noDatabase = ready?.noDatabase === true;
  body.push(
    actions(
      button(text.chooseFile, "restore-choose", !working && !host.pageBusy && !noDatabase, () => void choose(host)),
      button(text.refresh, "restore-refresh", !working && listState.kind !== "loading", () => void load(host), "link"),
    ),
  );
  if (answer) {
    const line = element("p", { className: answer.ok ? "success-text" : "warning-text", text: answer.text });
    line.dataset.id = "restore-answer";
    line.setAttribute("role", "status");
    body.push(line);
  }
  const card = section(text.heading, ...body);
  card.id = "restore-section";
  return card;
}
