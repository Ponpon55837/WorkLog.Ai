import type { OperationKind } from "../operations/journal-record.js";

/** What can hold the App's single action lock: a coordinator operation, or the copy to the local disk (no operation). */
export type RepairBusyWhat = OperationKind | "copy-to-local" | "login-item";

/** Why a request was refused as busy; the page maps it to one sentence (typed, never free text from main). */
export type RepairBusyReason =
  | { readonly source: "operation"; readonly what: RepairBusyWhat }
  /** The Dashboard is importing, backing up or exporting. */
  | { readonly source: "activity" }
  | { readonly source: "unknown" };
