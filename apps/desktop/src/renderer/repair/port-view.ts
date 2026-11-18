import type { PortChangeResult, RepairApi, RepairPortSection } from "@work-intelligence/desktop-core";
import type { PortMessages } from "@work-intelligence/desktop-core/shell/port-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import { button, element, section } from "./dom.js";

/**
 * The 「連接埠」 section of the repair window: the port in use, an input and 「變更連接埠」. The page only sends what the
 * user typed; main validates it and runs the change. The draft and the last answer live here, across the periodic
 * re-renders, so typing is not lost when the page refreshes.
 */
let draft = "";
let answer: { readonly text: string; readonly ok: boolean; readonly note?: string } | null = null;
let applying = false;
/** Sections already scrolled to: a redraw of the same state must not scroll again. */
const scrolledTo = new WeakSet<RepairPortSection>();

export interface PortViewHost {
  readonly api: RepairApi;
  readonly text: PortMessages;
  /** Another page action is running (or a start): the button waits. */
  readonly working: boolean;
  /** Draw the view again from its last state. */
  readonly rerender: () => void;
  /** Ask main for a fresh state (the port or the service changed). */
  readonly refresh: () => void;
}

function answerText(text: PortMessages, result: PortChangeResult, current: number | null): string {
  if (result.ok) {
    return result.changed ? formatMessage(text.done, { port: String(result.port) }) : text.unchanged;
  }
  if (result.rolledBack === false) return text.failedNotRunning;
  switch (result.reason) {
    case "invalid":
      return result.problem ? text.problems[result.problem] : text.invalid;
    case "occupied":
      return text.occupied;
    case "not-permitted":
      return text.notPermitted;
    case "busy":
      return result.busy === "activity"
        ? text.busyActivity
        : result.busy === "unknown"
          ? text.busyUnknown
          : text.busyOperation;
    case "cancelled":
      return text.cancelled;
    default:
      return formatMessage(text.failedRolledBack, { port: current === null ? "" : String(current) });
  }
}

async function apply(host: PortViewHost, port: RepairPortSection): Promise<void> {
  applying = true;
  answer = null;
  host.rerender();
  const result = await host.api.portChange(draft).catch((): PortChangeResult => ({ ok: false, reason: "failed" }));
  applying = false;
  answer = {
    text: answerText(host.text, result, port.port),
    ok: result.ok,
    ...(result.ok && result.changed && result.discardedImportPreview ? { note: host.text.importPreviewDiscarded } : {}),
  };
  if (result.ok && result.changed) draft = "";
  host.rerender();
  host.refresh();
}

/** The section's card. `port` is main's snapshot of the setting and the running port. */
export function portSection(host: PortViewHost, port: RepairPortSection): HTMLElement {
  const { text } = host;
  const input = element("input", { className: "text-input" });
  input.type = "text";
  input.inputMode = "numeric";
  input.id = "port-input";
  input.dataset.id = "port-input";
  input.autocomplete = "off";
  input.value = draft;
  input.disabled = applying || host.working;
  input.setAttribute("aria-label", text.inputLabel);
  input.addEventListener("input", () => {
    draft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !input.disabled) void apply(host, port);
  });
  const shown = port.activePort ?? port.port;
  const card = section(
    text.heading,
    ...(shown === null
      ? []
      : [element("p", { className: "hint", text: formatMessage(text.current, { port: String(shown) }) })]),
    element("p", { className: "hint", text: text.intro }),
    ...(port.handoffHeld ? [element("p", { className: "hint", text: text.handoffNote })] : []),
    element("label", { className: "field" }, [
      element("span", { className: "field-label", text: text.inputLabel }),
      input,
    ]),
    element("div", { className: "actions" }, [
      button(
        applying ? text.applying : text.apply,
        "port-apply",
        !applying && !host.working,
        () => void apply(host, port),
        true,
      ),
    ]),
    ...(answer ? [element("p", { className: answer.ok ? "success-text" : "warning-text", text: answer.text })] : []),
    ...(answer?.note ? [element("p", { className: "hint", text: answer.note })] : []),
  );
  card.id = "port-section";
  // The tray item (or the Dashboard's link) asked for the section: main reports it in one state only.
  if (port.focus && !scrolledTo.has(port)) {
    scrolledTo.add(port);
    queueMicrotask(() => {
      card.scrollIntoView({ block: "center" });
      input.focus();
    });
  }
  return card;
}
