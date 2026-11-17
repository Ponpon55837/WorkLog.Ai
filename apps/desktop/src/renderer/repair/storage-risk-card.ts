import type { StorageRiskView } from "@work-intelligence/desktop-core";
import { element } from "./dom.js";

/**
 * The note about risky storage (DT-08): what it is, why it matters and what to do, and, when a schema update is refused,
 * why. The consent checkbox and the copy button are added by the view that owns the action. All text comes from main.
 */
export function storageRiskNote(view: StorageRiskView): HTMLElement {
  const note = element("div", { className: "storage-risk" }, [
    element("strong", { text: view.label }),
    element("div", { className: "hint", text: view.why }),
    element("div", { className: "hint", text: view.todo }),
  ]);
  if (view.migrationNote) note.append(element("div", { className: "hint", text: view.migrationNote }));
  note.dataset.risk = view.risk;
  return note;
}
