import type { RepairApi, RepairUpdateSection } from "@work-intelligence/desktop-core";
import type { UpdateMessages } from "@work-intelligence/desktop-core/shell/update-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
// Types only, from the module that has no zod: the page bundle must not pull the schemas in.
import type { UpdateCheckResult, UpdateLinkTarget } from "@work-intelligence/desktop-core/update-check/result";
import { button, element, section } from "./dom.js";

/**
 * The 「更新」 card of the repair window. The App never checks by itself: the one request starts when the user presses
 * 「檢查更新」 or the tray item. Both start it in main, and this card only displays what main reports (`update`: whether a
 * check runs and the last answer), so a redraw, a reload or a poll can never start one. The page holds no URL: it names
 * "asset" or "page" and main opens the link it kept. Release notes are untrusted text and are only ever set as
 * `textContent` in a block that keeps their line breaks; there is no markup, no link and no innerHTML.
 */
/** The button was pressed and main has not answered yet: keeps it disabled before main's own "running" state arrives. */
let pressed = false;
/** An answer the page made up when the check call itself failed (main's answers come through the state). */
let failure: UpdateCheckResult | null = null;
let linkFailed = false;
/** The last drawn state was "checking": a new one that the page did not press for itself brings the card into view. */
let wasChecking = false;
/** Where the release notes were scrolled to, per release: a redraw replaces the box and must put it back. */
let notesScroll: { readonly version: string; readonly top: number } | null = null;

export interface UpdateViewHost {
  readonly api: RepairApi;
  readonly text: UpdateMessages;
  readonly locale: string;
  /** Draw the view again from its last state. */
  readonly rerender: () => void;
  /** Read the state from main again, then draw it. */
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

/** A date or time of an ISO text, or null when the text is not a date (a bad answer must not break the page). */
function formatted(locale: string, iso: string | null, style: Intl.DateTimeFormatOptions): string | null {
  const date = iso === null ? new Date(Number.NaN) : new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(locale, style).format(date);
}

/** Remembers how far the release notes are scrolled; call before the page replaces its content. */
export function saveNotesScroll(root: ParentNode): void {
  const box = root.querySelector<HTMLElement>(".update-notes");
  if (box?.dataset.version !== undefined) notesScroll = { version: box.dataset.version, top: box.scrollTop };
}

/** Puts the release notes back where they were; call after the new content is in the document (a detached box cannot scroll). */
export function restoreNotesScroll(root: ParentNode): void {
  const box = root.querySelector<HTMLElement>(".update-notes");
  const saved = notesScroll;
  if (box && saved !== null && saved.version === box.dataset.version) box.scrollTop = saved.top;
}

function newerBlock(host: UpdateViewHost, found: Extract<UpdateCheckResult, { kind: "newer" }>): Node[] {
  const { text } = host;
  const date = formatted(host.locale, found.publishedAt, { dateStyle: "medium" });
  const actions = element("div", { className: "actions" });
  const blocks: Node[] = [
    element("p", { className: "update-newer", text: formatMessage(text.newerVersion, { version: found.version }) }),
    ...(date === null ? [] : [element("p", { className: "hint", text: formatMessage(text.published, { date }) })]),
  ];
  if (found.notes.length > 0) {
    const notes = element("div", { className: "update-notes", text: found.notes });
    notes.dataset.version = found.version;
    blocks.push(element("h3", { text: text.notesHeading }), notes);
    if (found.notesTruncated) blocks.push(element("p", { className: "hint", text: text.notesTruncated }));
  }
  if (found.asset) {
    actions.append(
      button(text.downloadAsset[found.asset.platform], "update-asset", true, () => void open(host, "asset"), true),
    );
  }
  actions.append(button(text.openPage, "update-page", true, () => void open(host, "page")));
  blocks.push(actions);
  blocks.push(
    found.asset
      ? element("p", { className: "hint", text: text.verifyHint })
      : element("p", { className: "hint", text: text.noInstaller }),
    element("p", { className: "hint update-unsigned", text: text.unsignedNote }),
  );
  if (linkFailed) blocks.push(element("p", { className: "warning-text", text: text.linkFailed }));
  return blocks;
}

/** The message of a failed check; a release-less answer and a failed secure connection each have their own words. */
function errorBlock(host: UpdateViewHost, reason: Extract<UpdateCheckResult, { kind: "error" }>["reason"]): Node[] {
  const { text } = host;
  if (reason === "tls") return [element("p", { className: "warning-text", text: text.tlsFailed })];
  if (reason === "no-release") {
    return [
      element("p", { className: "warning-text", text: text.noRelease }),
      element("div", { className: "actions" }, [
        button(text.openPage, "update-page", true, () => void open(host, "page")),
      ]),
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

/** The section's card, drawn from main's report: the running version, whether a check runs, and the last answer. */
export function updateSection(host: UpdateViewHost, update: RepairUpdateSection): HTMLElement {
  const { text } = host;
  const busy = update.checking || pressed;
  const answer = busy ? null : (failure ?? update.result);
  const card = section(
    text.heading,
    element("p", { className: "hint", text: text.intro }),
    element("p", { className: "hint", text: formatMessage(text.current, { version: update.currentVersion }) }),
    element("div", { className: "actions" }, [
      button(busy ? text.checking : text.check, "update-check", !busy, () => void check(host), true),
    ]),
    ...(answer ? answerBlock(host, answer) : []),
  );
  card.id = "update-section";
  // A check that started without this page's button (the tray item) brings the card into view; the draw only shows it.
  if (update.checking && !wasChecking && !pressed) queueMicrotask(() => card.scrollIntoView({ block: "center" }));
  wasChecking = update.checking;
  return card;
}
