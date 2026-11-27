import type { RepairState } from "@work-intelligence/desktop-core";
import { errorMessageFor, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";
import { element } from "./dom.js";

export type Tone = "neutral" | "accent" | "success" | "attention" | "danger";

export function ownerTone(owner: RepairState["owner"]): Tone {
  switch (owner) {
    case "MANAGED":
      return "success";
    case "NEEDS_REPAIR":
      return "danger";
    case "PREPARING":
    case "QUIESCING":
    case "STARTING":
      return "accent";
    default:
      return "neutral";
  }
}

export function backendTone(backend: RepairState["backend"]): Tone {
  if (backend === "running") return "success";
  if (backend === "starting") return "accent";
  return backend === "crashed" ? "danger" : "neutral";
}

export function databaseTone(status: string): Tone {
  if (status === "ok") return "success";
  if (status === "unknown") return "neutral";
  return status === "unsupported-schema" || status === "needs-migration" ? "attention" : "danger";
}

export function label(text: string, tone: Tone = "neutral"): HTMLElement {
  return element("span", { className: `label label--${tone}`, text });
}

/** The pill of a database's status, or, when a preview could not run, of the error that says why. */
export function databaseLabel(messages: ShellMessages, status: string, errorCode?: string): HTMLElement {
  if (errorCode) return label(errorMessageFor(messages, errorCode).title, "danger");
  return label(messages.databaseStatuses[status] ?? status, databaseTone(status));
}
