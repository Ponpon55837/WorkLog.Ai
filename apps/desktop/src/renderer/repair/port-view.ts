import type { PortChangeResult, RepairApi, RepairPortSection } from "@work-intelligence/desktop-core";
import type { PortMessages } from "@work-intelligence/desktop-core/shell/port-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import { actions, button, element, hint, section } from "./dom.js";

let draft = "";
let answer: { readonly text: string; readonly ok: boolean; readonly note?: string } | null = null;
let applying = false;
const scrolledTo = new WeakSet<RepairPortSection>();

export interface PortViewHost {
  readonly api: RepairApi;
  readonly text: PortMessages;
  readonly working: boolean;
  readonly focusPort: boolean;
  readonly rerender: () => void;
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
    ...(shown === null ? [] : [hint(formatMessage(text.current, { port: String(shown) }))]),
    hint(text.intro),
    ...(port.handoffHeld ? [hint(text.handoffNote)] : []),
    element("label", { className: "field" }, [
      element("span", { className: "field-label", text: text.inputLabel }),
      input,
    ]),
    actions(
      button(
        applying ? text.applying : text.apply,
        "port-apply",
        !applying && !host.working,
        () => void apply(host, port),
        true,
      ),
    ),
    ...(answer ? [element("p", { className: answer.ok ? "success-text" : "warning-text", text: answer.text })] : []),
    ...(answer?.note ? [hint(answer.note)] : []),
  );
  card.id = "port-section";
  if (port.focus && host.focusPort && !scrolledTo.has(port)) {
    scrolledTo.add(port);
    queueMicrotask(() => {
      card.scrollIntoView({ block: "center" });
      input.focus();
    });
  }
  return card;
}
