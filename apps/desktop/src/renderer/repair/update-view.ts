import type { RepairApi, RepairUpdateSection } from "@work-intelligence/desktop-core";
import type { UpdateMessages } from "@work-intelligence/desktop-core/shell/update-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import type { UpdateCheckResult, UpdateLinkTarget } from "@work-intelligence/desktop-core/update-check/result";
import { button, element, section } from "./dom.js";

/**
 * The 「更新」 card of the repair window. The App never checks by itself: the one request starts when the user presses
 * 「檢查更新」 (or the tray item, which opens this card and asks the page to press it for them). The page holds no URL: it
 * names "asset" or "page" and main opens the link it kept. Release notes are untrusted text and are only ever set as
 * `textContent` in a block that keeps their line breaks; there is no markup, no link and no innerHTML.
 */
let checking = false;
let result: UpdateCheckResult | null = null;
let linkFailed = false;
/**
 * Main already checked the answer against its schema (zod stays out of this bundle); this only keeps a refusal such as
 * `{ ok: false, reason: "invalid" }` from being drawn as a result.
 */
const KINDS: readonly string[] = ["up-to-date", "newer", "offline", "rate-limited", "error"];

function isResult(value: unknown): value is UpdateCheckResult {
  return typeof value === "object" && value !== null && KINDS.includes((value as { kind?: string }).kind ?? "");
}

/** Sections whose tray request was already carried out: a redraw of the same state must not check again. */
const started = new WeakSet<RepairUpdateSection>();

export interface UpdateViewHost {
  readonly api: RepairApi;
  readonly text: UpdateMessages;
  readonly locale: string;
  /** Draw the view again from its last state. */
  readonly rerender: () => void;
}

async function check(host: UpdateViewHost): Promise<void> {
  if (checking) return;
  checking = true;
  result = null;
  linkFailed = false;
  host.rerender();
  try {
    const answer: unknown = await host.api.checkForUpdates();
    result = isResult(answer) ? answer : { kind: "error", reason: "bad-shape" };
  } catch {
    result = { kind: "error", reason: "unexpected" };
  }
  checking = false;
  host.rerender();
}

async function open(host: UpdateViewHost, target: UpdateLinkTarget): Promise<void> {
  const answer = await host.api.openUpdateLink(target).catch(() => ({ ok: false }));
  linkFailed = !answer.ok;
  host.rerender();
}

function formatDate(locale: string, iso: string | null): string | null {
  if (iso === null) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

function formatTime(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function newerBlock(host: UpdateViewHost, found: Extract<UpdateCheckResult, { kind: "newer" }>): Node[] {
  const { text } = host;
  const date = formatDate(host.locale, found.publishedAt);
  const actions = element("div", { className: "actions" });
  const blocks: Node[] = [
    element("p", { className: "update-newer", text: formatMessage(text.newerVersion, { version: found.version }) }),
    ...(date === null ? [] : [element("p", { className: "hint", text: formatMessage(text.published, { date }) })]),
  ];
  if (found.notes.length > 0) {
    blocks.push(
      element("h3", { text: text.notesHeading }),
      element("div", { className: "update-notes", text: found.notes }),
    );
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

function answerBlock(host: UpdateViewHost, answer: UpdateCheckResult): Node[] {
  const { text } = host;
  switch (answer.kind) {
    case "up-to-date":
      return [element("p", { className: "success-text update-current", text: text.upToDate })];
    case "newer":
      return newerBlock(host, answer);
    case "offline":
      return [element("p", { className: "warning-text", text: answer.timedOut ? text.timedOut : text.offline })];
    case "rate-limited":
      return [
        element("p", {
          className: "warning-text",
          text:
            answer.resetAt === null
              ? text.rateLimited
              : formatMessage(text.rateLimitedUntil, { time: formatTime(host.locale, answer.resetAt) }),
        }),
      ];
    case "error":
      return [element("p", { className: "warning-text", text: formatMessage(text.failed, { code: answer.reason }) })];
  }
}

/** The section's card. `update` is main's snapshot: the running version and whether the tray asked for a check. */
export function updateSection(host: UpdateViewHost, update: RepairUpdateSection): HTMLElement {
  const { text } = host;
  const card = section(
    text.heading,
    element("p", { className: "hint", text: text.intro }),
    element("p", { className: "hint", text: formatMessage(text.current, { version: update.currentVersion }) }),
    element("div", { className: "actions" }, [
      button(checking ? text.checking : text.check, "update-check", !checking, () => void check(host), true),
    ]),
    ...(result ? answerBlock(host, result) : []),
  );
  card.id = "update-section";
  if (update.startCheck && !started.has(update)) {
    started.add(update);
    queueMicrotask(() => {
      card.scrollIntoView({ block: "center" });
      void check(host);
    });
  }
  return card;
}
