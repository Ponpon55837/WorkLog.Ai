import type { DiagnosticsPreviewResult, RepairApi } from "@work-intelligence/desktop-core";
import {
  diagnosticsSummaryLines,
  type DiagnosticsMessages,
} from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import { openModal } from "./dialog.js";
import { button, element, hint } from "./dom.js";

export interface DiagnosticsViewHost {
  readonly api: RepairApi;
  readonly text: DiagnosticsMessages;
  readonly say: (text: string) => void;
  readonly returnFocus: () => void;
}

type Preview = Extract<DiagnosticsPreviewResult, { ok: true }>;

let open = false;

function failureText(text: DiagnosticsMessages, result: Extract<DiagnosticsPreviewResult, { ok: false }>): string {
  return result.reason === "scan-failed" ? text.scanFailed : text.previewFailed;
}

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
  host.say("");
  showDialog(host, result);
}

function showDialog(host: DiagnosticsViewHost, first: Preview): void {
  const { text } = host;
  let previewId = first.previewId;
  let saving = false;
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
      // The text on screen is no longer the one main holds: show the new one and save only after it is read.
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
  // Focusing the box may move its caret to the end and scroll there.
  box.scrollTop = 0;
  box.setSelectionRange(0, 0);
  modal.dialog.addEventListener("close", () => {
    open = false;
  });
}
