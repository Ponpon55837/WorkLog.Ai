import type { LegacyDisableConfirmResult, LegacyDisablePreview, RepairApi } from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { button, element } from "./dom.js";

/**
 * 「停用舊的登入服務…」 inside the old-service card: a read-only preview in plain words (the commands only under
 * 「詳細步驟」), then 「停用」, which main confirms once more natively. The state lives here, across the views'
 * periodic re-renders, so a preview or a result is not lost when the page refreshes.
 */
type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "preview"; readonly preview: LegacyDisablePreview }
  | { readonly kind: "result"; readonly message: string; readonly ok: boolean; readonly offerStart: boolean };

let phase: Phase = { kind: "idle" };

export interface LegacyDisableHost {
  readonly api: RepairApi;
  readonly text: SetupMessages;
  /** Draw the view again from its last state. */
  readonly rerender: () => void;
  /** Ask main for a fresh state (the old service may be gone now). */
  readonly refresh: () => void;
}

function resultMessage(text: SetupMessages, result: LegacyDisableConfirmResult): string {
  if (result.ok) return result.offerStart ? text.legacyDisableDoneStart : text.legacyDisableDone;
  switch (result.reason) {
    case "changed":
      return text.legacyDisableChanged;
    case "still-running":
      return text.legacyDisableStillRunning;
    case "database-check-failed":
      return text.legacyDisableCheckFailed;
    case "busy":
      return text.legacyDisableBusyOther;
    case "failed":
      return result.removed ? text.legacyDisableFailedPartly : text.legacyDisableFailed;
    default:
      return text.legacyDisableFailed;
  }
}

async function openPreview(host: LegacyDisableHost): Promise<void> {
  phase = { kind: "working" };
  host.rerender();
  const result = await host.api.legacyDisablePreview().catch(() => ({ ok: false, reason: "unavailable" }) as const);
  phase = result.ok
    ? { kind: "preview", preview: result.preview }
    : { kind: "result", ok: false, offerStart: false, message: host.text.legacyDisableUnavailable };
  host.rerender();
}

async function confirm(host: LegacyDisableHost, preview: LegacyDisablePreview): Promise<void> {
  phase = { kind: "working" };
  host.rerender();
  const result = await host.api
    .legacyDisableConfirm(preview.previewId, preview.busy)
    .catch((): LegacyDisableConfirmResult => ({ ok: false, reason: "failed" }));
  if (!result.ok && (result.reason === "cancelled" || result.reason === "invalid")) {
    // Cancelled in the native dialog: back to the same preview, nothing happened.
    phase = result.reason === "cancelled" ? { kind: "preview", preview } : { kind: "idle" };
  } else {
    phase = {
      kind: "result",
      ok: result.ok,
      offerStart: result.ok && result.offerStart,
      message: resultMessage(host.text, result),
    };
  }
  host.rerender();
  host.refresh();
}

async function startNow(host: LegacyDisableHost): Promise<void> {
  phase = { kind: "working" };
  host.rerender();
  const result = await host.api.legacyStartNow().catch(() => ({ ok: false as const, reason: "failed" as const }));
  phase = result.ok
    ? { kind: "idle" }
    : { kind: "result", ok: false, offerStart: false, message: host.text.legacyDisableBusyOther };
  host.rerender();
  host.refresh();
}

function previewPanel(host: LegacyDisableHost, preview: LegacyDisablePreview): HTMLElement {
  const { text } = host;
  const lines: string[] = [preview.running ? text.legacyDisableIntro : text.legacyDisableNotRunning];
  if (preview.running) lines.push(preview.hardStop ? text.legacyDisableHardStop : text.legacyDisableGraceful);
  if (preview.sameDatabase) lines.push(text.legacyDisableSameDatabase);
  const steps = element(
    "ol",
    { className: "steps" },
    preview.steps.map((step) => element("li", {}, [element("code", { className: "command-text", text: step })])),
  );
  const panel = element("div", { className: "legacy-disable" }, [
    element("h3", { text: text.legacyDisableHeading }),
    ...lines.map((line) => element("p", { text: line })),
    ...(preview.busy ? [element("p", { className: "warning-text", text: text.legacyDisableBusy })] : []),
    element("details", { className: "advanced" }, [element("summary", { text: text.legacyDisableSteps }), steps]),
    element("div", { className: "actions" }, [
      button(
        preview.busy ? text.legacyDisableConfirmBusy : text.legacyDisableConfirm,
        "legacy-disable-confirm",
        true,
        () => void confirm(host, preview),
        true,
      ),
      button(text.legacyDisableCancel, "legacy-disable-cancel", true, () => {
        phase = { kind: "idle" };
        host.rerender();
      }),
    ]),
  ]);
  panel.id = "legacy-disable";
  return panel;
}

function resultPanel(host: LegacyDisableHost, result: Extract<Phase, { kind: "result" }>): HTMLElement {
  const panel = element("div", { className: "legacy-disable" }, [
    element("p", { className: result.ok ? "success-text" : "warning-text", text: result.message }),
  ]);
  if (result.offerStart) {
    panel.append(
      element("div", { className: "actions" }, [
        button(host.text.legacyStartNow, "legacy-start-now", true, () => void startNow(host), true),
      ]),
    );
  }
  panel.id = "legacy-disable-result";
  return panel;
}

/** The controls to append to the old-service card; nothing when the App cannot disable this definition. */
export function legacyDisableControls(host: LegacyDisableHost, canDisable: boolean, enabled: boolean): Node[] {
  if (phase.kind === "preview") return [previewPanel(host, phase.preview)];
  if (phase.kind === "result") return [resultPanel(host, phase)];
  if (!canDisable) return [];
  return [
    element("div", { className: "actions" }, [
      button(host.text.legacyDisable, "legacy-disable", enabled && phase.kind === "idle", () => void openPreview(host)),
    ]),
  ];
}

/** After a disable the card is gone (no old service any more): the outcome and 「立即啟動」 stay on their own. */
export function legacyDisableOutcome(host: LegacyDisableHost): HTMLElement | null {
  if (phase.kind !== "result") return null;
  const card = element("section", { className: "card" }, [resultPanel(host, phase)]);
  return card;
}
