import type { DesktopFacts } from "@work-intelligence/schema";
import { storageRiskFact } from "../db-source/storage-policy.js";
import type { StorageRiskResult } from "../db-source/storage-risk.js";
import type { RestartOutcome } from "./backend-recovery.js";

export const STORAGE_NETWORK_CODE = "DB_STORAGE_NETWORK";

export interface StartStorageDeps {
  readonly risk: StorageRiskResult | undefined;
  currentFacts(): DesktopFacts;
  stopBackend(): Promise<void>;
  updateFacts(facts: DesktopFacts): Promise<boolean>;
}

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
