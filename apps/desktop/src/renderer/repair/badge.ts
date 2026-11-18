import type { RepairState } from "@work-intelligence/desktop-core";
import { element } from "./dom.js";

/** A status pill (UiLabel): the text always says the state, the tone only adds to it. */
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
  return status === "unsupported-schema" ? "attention" : "danger";
}

export function label(text: string, tone: Tone = "neutral"): HTMLElement {
  return element("span", { className: `label label--${tone}`, text });
}
