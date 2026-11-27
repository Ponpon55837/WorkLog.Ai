import type { RepairApi, RepairUpdateSection } from "@work-intelligence/desktop-core";
import type { UpdateMessages } from "@work-intelligence/desktop-core/shell/update-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
// Types only, from the module without zod: the page bundle must not pull the schemas in.
import type { UpdateCheckResult, UpdateLinkTarget } from "@work-intelligence/desktop-core/update-check/result";
import { actions, button, element, hint, section } from "./dom.js";

let pressed = false;
let failure: UpdateCheckResult | null = null;
let linkFailed = false;
let wasChecking = false;
let notesScroll: { readonly version: string; readonly top: number } | null = null;

export interface UpdateViewHost {
  readonly api: RepairApi;
  readonly text: UpdateMessages;
  readonly locale: string;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function check(host: UpdateViewHost): Promise<void> {
  if (pressed) return;
  pressed = true;
  failure = null;
  linkFailed = false;
  host.rerender();
  try {
    await host.api.checkForUpdates();
  } catch {
    failure = { kind: "error", reason: "unexpected" };
  }
  pressed = false;
  host.refresh();
}

async function open(host: UpdateViewHost, target: UpdateLinkTarget): Promise<void> {
  const answer = await host.api.openUpdateLink(target).catch(() => ({ ok: false }));
  linkFailed = !answer.ok;
  host.rerender();
}

function formatted(locale: string, iso: string | null, style: Intl.DateTimeFormatOptions): string | null {
  const date = iso === null ? new Date(Number.NaN) : new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(locale, style).format(date);
}

export function saveNotesScroll(root: ParentNode): void {
  const box = root.querySelector<HTMLElement>(".update-notes");
  if (box?.dataset.version !== undefined) notesScroll = { version: box.dataset.version, top: box.scrollTop };
}

// Call after the new content is in the document: a detached box cannot scroll.
export function restoreNotesScroll(root: ParentNode): void {
  const box = root.querySelector<HTMLElement>(".update-notes");
  const saved = notesScroll;
  if (box && saved !== null && saved.version === box.dataset.version) box.scrollTop = saved.top;
}

function newerBlock(host: UpdateViewHost, found: Extract<UpdateCheckResult, { kind: "newer" }>): Node[] {
  const { text } = host;
  const date = formatted(host.locale, found.publishedAt, { dateStyle: "medium" });
  const blocks: Node[] = [
    element("p", { className: "update-newer", text: formatMessage(text.newerVersion, { version: found.version }) }),
    ...(date === null ? [] : [hint(formatMessage(text.published, { date }))]),
  ];
  if (found.notes.length > 0) {
    // Release notes are untrusted: text only, never markup.
    const notes = element("div", { className: "update-notes", text: found.notes });
    notes.dataset.version = found.version;
    blocks.push(element("h3", { text: text.notesHeading }), notes);
    if (found.notesTruncated) blocks.push(hint(text.notesTruncated));
  }
  blocks.push(
    actions(
      ...(found.asset
        ? [button(text.downloadAsset[found.asset.platform], "update-asset", true, () => void open(host, "asset"), true)]
        : []),
      button(text.openPage, "update-page", true, () => void open(host, "page")),
    ),
    hint(found.asset ? text.verifyHint : text.noInstaller),
    hint(text.unsignedNote),
  );
  if (linkFailed) blocks.push(element("p", { className: "warning-text", text: text.linkFailed }));
  return blocks;
}

function errorBlock(host: UpdateViewHost, reason: Extract<UpdateCheckResult, { kind: "error" }>["reason"]): Node[] {
  const { text } = host;
  if (reason === "tls") return [element("p", { className: "warning-text", text: text.tlsFailed })];
  if (reason === "no-release") {
    return [
      element("p", { className: "warning-text", text: text.noRelease }),
      actions(button(text.openPage, "update-page", true, () => void open(host, "page"))),
      ...(linkFailed ? [element("p", { className: "warning-text", text: text.linkFailed })] : []),
    ];
  }
  return [element("p", { className: "warning-text", text: formatMessage(text.failed, { code: reason }) })];
}

function answerBlock(host: UpdateViewHost, answer: UpdateCheckResult): Node[] {
  const { text } = host;
  switch (answer.kind) {
    case "up-to-date":
      return [element("p", { className: "success-text update-current", text: text.upToDate })];
    case "newer":
      return newerBlock(host, answer);
    case "offline":
      return [element("p", { className: "warning-text", text: answer.timedOut ? text.timedOut : text.offline })];
    case "rate-limited": {
      const time = formatted(host.locale, answer.resetAt, { dateStyle: "medium", timeStyle: "short" });
      return [
        element("p", {
          className: "warning-text",
          text: time === null ? text.rateLimited : formatMessage(text.rateLimitedUntil, { time }),
        }),
      ];
    }
    case "error":
      return errorBlock(host, answer.reason);
  }
}

export function updateSection(host: UpdateViewHost, update: RepairUpdateSection): HTMLElement {
  const { text } = host;
  const busy = update.checking || pressed;
  const answer = busy ? null : (failure ?? update.result);
  const card = section(
    text.heading,
    hint(text.intro),
    hint(formatMessage(text.current, { version: update.currentVersion })),
    actions(button(busy ? text.checking : text.check, "update-check", !busy, () => void check(host), true)),
    ...(answer ? answerBlock(host, answer) : []),
  );
  card.id = "update-section";
  if (update.checking && !wasChecking && !pressed) queueMicrotask(() => card.scrollIntoView({ block: "center" }));
  wasChecking = update.checking;
  return card;
}
