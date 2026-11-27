import type {
  LegacyDisableConfirmResult,
  LegacyDisablePreview,
  RepairApi,
  RepairBusyReason,
} from "@work-intelligence/desktop-core";
import type { SetupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import { actions, button, element } from "./dom.js";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "preview"; readonly preview: LegacyDisablePreview }
  | { readonly kind: "result"; readonly message: string; readonly ok: boolean; readonly offerStart: boolean };

let phase: Phase = { kind: "idle" };

export interface LegacyDisableHost {
  readonly api: RepairApi;
  readonly text: SetupMessages;
  readonly busyText: (reason: RepairBusyReason | undefined) => string;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

function resultMessage(host: LegacyDisableHost, result: LegacyDisableConfirmResult): string {
  const { text } = host;
  if (result.ok) {
    if (result.databaseUnverified) return text.legacyDisableCheckUnverified;
    return result.offerStart ? text.legacyDisableDoneStart : text.legacyDisableDone;
  }
  switch (result.reason) {
    case "changed":
      return text.legacyDisableChanged;
    case "still-running":
      return text.legacyDisableStillRunning;
    case "database-check-failed":
      return text.legacyDisableCheckFailed;
    case "busy":
      return result.busyReason ? host.busyText(result.busyReason) : text.legacyDisableBusyOther;
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
  if (!result.ok && result.reason === "now-busy") {
    phase = { kind: "preview", preview: { ...preview, busy: true } };
  } else if (!result.ok && (result.reason === "cancelled" || result.reason === "invalid")) {
    phase = result.reason === "cancelled" ? { kind: "preview", preview } : { kind: "idle" };
  } else {
    phase = {
      kind: "result",
      ok: result.ok,
      offerStart: result.ok && result.offerStart,
      message: resultMessage(host, result),
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
    : {
        kind: "result",
        ok: false,
        offerStart: false,
        message:
          "busyReason" in result && result.busyReason
            ? host.busyText(result.busyReason)
            : host.text.legacyDisableBusyOther,
      };
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
    actions(
      button(
        preview.busy ? text.legacyDisableConfirmBusy : text.legacyDisableConfirm,
        "legacy-disable-confirm",
        true,
        () => void confirm(host, preview),
        "danger",
      ),
      button(text.legacyDisableCancel, "legacy-disable-cancel", true, () => {
        phase = { kind: "idle" };
        host.rerender();
      }),
    ),
  ]);
  panel.id = "legacy-disable";
  return panel;
}

function resultPanel(host: LegacyDisableHost, result: Extract<Phase, { kind: "result" }>): HTMLElement {
  const panel = element("div", { className: "legacy-disable" }, [
    element("p", { className: result.ok ? "success-text" : "warning-text", text: result.message }),
  ]);
  if (result.offerStart) {
    panel.append(actions(button(host.text.legacyStartNow, "legacy-start-now", true, () => void startNow(host), true)));
  }
  panel.id = "legacy-disable-result";
  return panel;
}

export function legacyDisableControls(host: LegacyDisableHost, canDisable: boolean, enabled: boolean): Node[] {
  if (phase.kind === "preview") return [previewPanel(host, phase.preview)];
  if (phase.kind === "result") return [resultPanel(host, phase)];
  if (!canDisable) return [];
  return [
    actions(
      button(host.text.legacyDisable, "legacy-disable", enabled && phase.kind === "idle", () => void openPreview(host)),
    ),
  ];
}

export function legacyDisableOutcome(host: LegacyDisableHost): HTMLElement | null {
  if (phase.kind !== "result") return null;
  return element("section", { className: "card" }, [
    element("div", { className: "card-body" }, [resultPanel(host, phase)]),
  ]);
}
