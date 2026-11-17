import type { DesktopFacts } from "@work-intelligence/schema";
import { storageRiskFact } from "../db-source/storage-policy.js";
import type { StorageRiskResult } from "../db-source/storage-risk.js";
import type { RestartOutcome } from "./backend-recovery.js";

/** The error code the repair page shows when the committed database turns out to be on a network share. */
export const STORAGE_NETWORK_CODE = "DB_STORAGE_NETWORK";

export interface StartStorageDeps {
  /** The classifier's verdict for the committed database; undefined when it could not be asked. */
  readonly risk: StorageRiskResult | undefined;
  /** The facts the running backend already carries (legacy service, port), without the storage verdict. */
  currentFacts(): DesktopFacts;
  /** Stops the running backend and records that it is stopped. */
  stopBackend(): Promise<void>;
  /** Sends the merged facts to the running backend. */
  updateFacts(facts: DesktopFacts): Promise<boolean>;
}

/**
 * DT-08 at start: the committed database is classified beside the backend bring-up, never before it, so a slow or failed
 * detection never delays or blocks a start. After a good start: `network` stops the backend and fails the start with the
 * network code (the repair page then offers the copy to the local disk); any other positive risk, and `unknown`, only
 * add the verdict to the facts the Web status page shows. A start that already failed is returned unchanged.
 */
export async function applyStartTimeStorageRisk(
  outcome: RestartOutcome | undefined,
  deps: StartStorageDeps,
): Promise<RestartOutcome | undefined> {
  if (!outcome?.ok || !deps.risk) return outcome;
  if (deps.risk.risk === "network") {
    await deps.stopBackend();
    return { ok: false, code: STORAGE_NETWORK_CODE };
  }
  const fact = storageRiskFact(deps.risk);
  if (!fact) return outcome;
  await deps.updateFacts({ ...deps.currentFacts(), storageRisk: fact });
  return outcome;
}
