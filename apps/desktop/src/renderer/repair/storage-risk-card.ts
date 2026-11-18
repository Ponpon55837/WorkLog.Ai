import type { StorageRiskView } from "@work-intelligence/desktop-core";
import { element, hint } from "./dom.js";

/**
 * The note about risky storage (DT-08): what it is, why it matters and what to do, and, when a schema update is refused,
 * why. The consent checkbox and the copy button are added by the view that owns the action. All text comes from main.
 */
export function storageRiskNote(view: StorageRiskView): HTMLElement {
  const note = element("div", { className: "storage-risk" }, [
    element("strong", { text: view.label }),
    hint(view.why, "div"),
    hint(view.todo, "div"),
  ]);
  if (view.migrationNote) note.append(hint(view.migrationNote, "div"));
  note.dataset.risk = view.risk;
  return note;
}
