import type { DiagnosticsPreviewResult, RepairApi } from "@work-intelligence/desktop-core";
import {
  diagnosticsSummaryLines,
  type DiagnosticsMessages,
} from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import { button, element } from "./dom.js";

/**
 * The preview of 「匯出診斷資訊」: a modal panel with the exact text that would be saved (read-only), what was masked,
 * and 「儲存檔案…」 / 「取消」. Main keeps the text; the page sends only the preview id back, so the file is the previewed
 * bytes. The panel lives outside the page's content, so the page's periodic redraw does not touch it. It is a native
 * modal dialog: focus moves into it and stays there, Esc closes it, and focus goes back to the button that opened it.
 */
export interface DiagnosticsViewHost {
  readonly api: RepairApi;
  readonly text: DiagnosticsMessages;
  /** The page's status line (a live region), for what is left to say after the panel closed. */
  readonly say: (text: string) => void;
  /** Puts focus back on the button that opened the panel. */
  readonly returnFocus: () => void;
}

type Preview = Extract<DiagnosticsPreviewResult, { ok: true }>;

function failureText(text: DiagnosticsMessages, result: Extract<DiagnosticsPreviewResult, { ok: false }>): string {
  return result.reason === "scan-failed" ? text.scanFailed : text.previewFailed;
}

/** Asks main for a preview and shows it; a refusal or failure is said on the status line. */
export async function requestDiagnosticsPreview(host: DiagnosticsViewHost): Promise<void> {
  const result = await host.api
    .previewDiagnostics()
    .catch((): DiagnosticsPreviewResult => ({ ok: false, reason: "failed" }));
  if (!result.ok) {
    host.say(failureText(host.text, result));
    return;
  }
  showPanel(host, result);
}

function showPanel(host: DiagnosticsViewHost, first: Preview): void {
  const { text } = host;
  let previewId = first.previewId;
  let saving = false;

  const panel = element("dialog", { className: "preview-dialog" });
  const heading = element("h2", { text: text.heading });
  heading.id = "diagnostics-heading";
  panel.setAttribute("aria-labelledby", heading.id);
  const box = element("textarea", { className: "preview-text" });
  box.readOnly = true;
  box.spellcheck = false;
  box.wrap = "off";
  box.setAttribute("aria-label", text.textLabel);
  const summary = element("div", { className: "preview-summary" });
  const status = element("p", { className: "hint" });
  status.setAttribute("role", "status");
  const save = button(text.save, "diagnostics-save", true, () => void saveFile(), true);
  const cancel = button(text.cancel, "diagnostics-cancel", true, () => panel.close());

  function show(preview: Preview): void {
    previewId = preview.previewId;
    box.value = preview.text;
    box.scrollTop = 0;
    summary.replaceChildren(
      ...diagnosticsSummaryLines(text, preview.report).map((line) => element("p", { className: "hint", text: line })),
    );
  }

  function setSaving(value: boolean): void {
    saving = value;
    save.disabled = value;
  }

  async function saveFile(): Promise<void> {
    if (saving) return;
    setSaving(true);
    status.textContent = "";
    const result = await host.api.saveDiagnostics(previewId).catch(() => ({ ok: false, reason: "failed" }) as const);
    if (result.ok) {
      panel.close();
      host.say(text.saved);
      return;
    }
    if (result.reason === "expired") {
      // The text on screen is no longer the one main holds: show a new one, and save only after it is read.
      const next = await host.api
        .previewDiagnostics()
        .catch((): DiagnosticsPreviewResult => ({ ok: false, reason: "failed" }));
      if (next.ok) {
        show(next);
        status.textContent = text.refreshed;
      } else status.textContent = failureText(text, next);
    } else if (result.reason !== "cancelled") {
      status.textContent = text.saveFailed;
    }
    setSaving(false);
  }

  show(first);
  panel.append(
    heading,
    element("p", { className: "hint", text: text.intro }),
    box,
    summary,
    status,
    element("div", { className: "actions" }, [save, cancel]),
  );
  panel.addEventListener("close", () => {
    panel.remove();
    host.returnFocus();
  });
  document.body.append(panel);
  panel.showModal();
  box.focus();
}
