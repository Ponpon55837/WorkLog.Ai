import type {
  MaintenanceMode,
  MaintenanceRunResult,
  RepairApi,
  RepairMaintenanceSection,
} from "@work-intelligence/desktop-core";
import {
  checkText,
  lastRunText,
  maintenanceFailureText,
  maintenanceMessages,
  maintenanceSuccessText,
  modeLabels,
  reclaimableText,
  type MaintenanceMessages,
} from "@work-intelligence/desktop-core/shell/maintenance-i18n";
import type { ShellLocale } from "@work-intelligence/desktop-core/shell/i18n";
import { actions, button, element, hint, section } from "./dom.js";

let working: MaintenanceMode | null = null;
let answer: { readonly text: string; readonly ok: boolean } | null = null;

export interface MaintenanceViewHost {
  readonly api: RepairApi;
  readonly locale: ShellLocale;
  readonly maintenance: RepairMaintenanceSection;
  readonly pageBusy: boolean;
  readonly rerender: () => void;
  readonly refresh: () => void;
}

async function run(host: MaintenanceViewHost, mode: MaintenanceMode): Promise<void> {
  if (working !== null) return;
  const text = maintenanceMessages(host.locale);
  working = mode;
  answer = null;
  host.rerender();
  const result = await host.api
    .runMaintenance(mode)
    .catch((): MaintenanceRunResult => ({ ok: false, mode, reason: "failed", dataIntact: true, backendRunning: true }));
  working = null;
  if (result.ok) answer = { text: maintenanceSuccessText(text, result), ok: true };
  else {
    answer = {
      text: maintenanceFailureText(text, host.locale, {
        ...result,
        dataIntact: result.dataIntact ?? true,
        backendRunning: result.backendRunning ?? true,
      }),
      ok: false,
    };
  }
  host.refresh();
  host.rerender();
}

function summaryLines(text: MaintenanceMessages, locale: ShellLocale, maintenance: RepairMaintenanceSection): string[] {
  const lines = [
    maintenance.reclaimableBytes === null
      ? text.reclaimableUnknown
      : reclaimableText(text, maintenance.reclaimableBytes, maintenance.suggest),
    `${text.lastRunLabel}: ${lastRunText(text, locale, maintenance.last)}`,
  ];
  if (maintenance.check) lines.push(checkText(text, locale, maintenance.check));
  return lines;
}

/** The Data tab card. */
export function maintenanceSection(host: MaintenanceViewHost): HTMLElement {
  const text = maintenanceMessages(host.locale);
  const body: Node[] = [hint(text.intro)];
  for (const line of summaryLines(text, host.locale, host.maintenance)) body.push(hint(line, "div"));
  const idle = working === null && !host.pageBusy;
  body.push(
    actions(
      button(
        modeLabels(text, "maintain", working === "maintain"),
        "maintenance-run",
        idle,
        () => void run(host, "maintain"),
        true,
      ),
      button(modeLabels(text, "check", working === "check"), "maintenance-check", idle, () => void run(host, "check")),
    ),
  );
  if (answer) {
    const line = element("p", { className: answer.ok ? "success-text" : "warning-text", text: answer.text });
    line.dataset.id = "maintenance-answer";
    line.setAttribute("role", "status");
    body.push(line);
  }
  const card = section(text.heading, ...body);
  card.id = "maintenance-section";
  return card;
}

/** The Status tab's lines: the free space and the last run, without buttons. */
export function maintenanceSummary(locale: ShellLocale, maintenance: RepairMaintenanceSection): HTMLElement {
  const text = maintenanceMessages(locale);
  const card = section(text.heading, ...summaryLines(text, locale, maintenance).map((line) => hint(line, "div")));
  card.id = "maintenance-summary";
  return card;
}
