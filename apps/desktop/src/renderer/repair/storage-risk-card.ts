import type { StorageRiskView } from "@work-intelligence/desktop-core";
import { element, hint } from "./dom.js";

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
