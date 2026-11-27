import type { OperationKind } from "../operations/journal-record.js";

export type RepairBusyWhat = OperationKind | "copy-to-local" | "login-item" | "backup-directory";

export type RepairBusyReason =
  | { readonly source: "operation"; readonly what: RepairBusyWhat }
  | { readonly source: "activity" }
  | { readonly source: "unknown" };
