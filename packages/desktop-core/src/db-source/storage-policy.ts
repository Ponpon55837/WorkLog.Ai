import type { StorageRisk, StorageRiskResult } from "./storage-risk.js";

export type StoragePolicyRisk = Exclude<StorageRisk, "none">;

export interface StoragePolicy {
  readonly refused: boolean;
  readonly needsConsent: boolean;
  readonly migrationBlocked: boolean;
  readonly note: boolean;
}

const POLICY: Readonly<Record<StorageRisk, StoragePolicy>> = {
  none: { refused: false, needsConsent: false, migrationBlocked: false, note: false },
  network: { refused: true, needsConsent: false, migrationBlocked: true, note: true },
  removable: { refused: false, needsConsent: true, migrationBlocked: true, note: true },
  "cloud-sync": { refused: false, needsConsent: true, migrationBlocked: true, note: true },
  "hard-link": { refused: false, needsConsent: true, migrationBlocked: true, note: true },
  unknown: { refused: false, needsConsent: false, migrationBlocked: false, note: true },
};

export function storagePolicy(risk: StorageRisk | undefined): StoragePolicy {
  return POLICY[risk ?? "none"];
}

export function isPositiveRisk(risk: StorageRisk | undefined): boolean {
  return storagePolicy(risk).migrationBlocked;
}

export function needsStorageConsent(risk: StorageRisk | undefined, chosenByUser: boolean): boolean {
  if (storagePolicy(risk).needsConsent) return true;
  return risk === "unknown" && !chosenByUser;
}

export function allowMigrationFor(needsMigration: boolean, risk: StorageRisk | undefined): boolean {
  return needsMigration && !storagePolicy(risk).migrationBlocked;
}

export function storageBlocksUse(risk: StorageRisk | undefined, needsMigration: boolean): boolean {
  const policy = storagePolicy(risk);
  return policy.refused || (needsMigration && policy.migrationBlocked);
}

export function storageRiskFact(
  result: Pick<StorageRiskResult, "risk"> | undefined,
): { risk: StoragePolicyRisk; migrationBlocked: boolean } | undefined {
  if (!result || result.risk === "none") return undefined;
  return { risk: result.risk, migrationBlocked: storagePolicy(result.risk).migrationBlocked };
}
