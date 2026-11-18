import type { DiagnosticsPreviewResult, RepairApi } from "@work-intelligence/desktop-core";
import {
  diagnosticsSummaryLines,
  type DiagnosticsMessages,
} from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import { openModal } from "./dialog.js";
import { button, element, hint } from "./dom.js";

/**
 * The preview of 「匯出診斷資訊」: a modal dialog with the exact text that would be saved (read-only), what was masked,
 * and 「儲存檔案…」 / 「取消」. Main keeps the text; the page sends only the preview id back, so the file is the previewed
 * bytes. The dialog lives in the overlay root, outside every tab panel, so a tab change or the page's periodic redraw
 * does not touch it. It is a native modal dialog: focus moves into it and stays there, Esc closes it, and focus goes
 * back to the button that opened it. Only one preview is open at a time.
 */
export interface DiagnosticsViewHost {
  readonly api: RepairApi;
  readonly text: DiagnosticsMessages;
  /** The page's status line (a live region), for what is left to say after the dialog closed. */
  readonly say: (text: string) => void;
  /** Puts focus back where the dialog was opened from, when that control has been redrawn since. */
  readonly returnFocus: () => void;
}

type Preview = Extract<DiagnosticsPreviewResult, { ok: true }>;

let open = false;

function failureText(text: DiagnosticsMessages, result: Extract<DiagnosticsPreviewResult, { ok: false }>): string {
  return result.reason === "scan-failed" ? text.scanFailed : text.previewFailed;
}

/** Asks main for a preview and shows it; a refusal or failure is said on the status line. */
export async function requestDiagnosticsPreview(host: DiagnosticsViewHost): Promise<void> {
  if (open) return;
  open = true;
  const result = await host.api
    .previewDiagnostics()
    .catch((): DiagnosticsPreviewResult => ({ ok: false, reason: "failed" }));
  if (!result.ok) {
    open = false;
    host.say(failureText(host.text, result));
    return;
  }
  // The "working" line of the button that asked is over: it must not stay on the page behind the modal.
  host.say("");
  showDialog(host, result);
}

function showDialog(host: DiagnosticsViewHost, first: Preview): void {
  const { text } = host;
  let previewId = first.previewId;
  let saving = false;
  /** Closes the dialog; set once it is open (the buttons are made before it). */
  let closeDialog = (): void => undefined;

  const box = element("textarea", { className: "preview-text" });
  box.readOnly = true;
  box.spellcheck = false;
  box.wrap = "off";
  box.setAttribute("aria-label", text.textLabel);
  const summary = element("div", { className: "preview-summary" });
  const status = hint("");
  status.setAttribute("role", "status");
  const save = button(text.save, "diagnostics-save", true, () => void saveFile(), true);
  const cancel = button(text.cancel, "diagnostics-cancel", true, () => closeDialog());

  function show(preview: Preview): void {
    previewId = preview.previewId;
    box.value = preview.text;
    box.scrollTop = 0;
    summary.replaceChildren(...diagnosticsSummaryLines(text, preview.report).map((line) => hint(line)));
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
      closeDialog();
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
  const modal = openModal({
    title: text.heading,
    headingId: "diagnostics-heading",
    className: "preview-dialog",
    body: [hint(text.intro), box, summary, status],
    footer: [cancel, save],
    returnFocus: host.returnFocus,
    initialFocus: () => box,
    canClose: () => !saving,
  });
  closeDialog = modal.close;
  // Focusing the box may move its caret to the end and scroll there; the text is read from the top.
  box.scrollTop = 0;
  box.setSelectionRange(0, 0);
  modal.dialog.addEventListener("close", () => {
    open = false;
  });
}
