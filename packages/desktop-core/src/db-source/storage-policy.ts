import type { StorageRisk, StorageRiskResult } from "./storage-risk.js";

/**
 * DT-08 policy: what each storage verdict allows. Pure, so the shell, the setup page and the tests share one table.
 *
 * - `network`: refused as the App's database (SQLite WAL is not supported over a share); copy it to a local disk.
 * - `removable`, `cloud-sync`, `hard-link` (a positive risk): never a one-click choice; the user may pick it only after
 *   a consent checkbox that states the reason; a schema update on it is refused (copy it to the local disk instead).
 * - `unknown` (detection failed or timed out): blocks the one-click choice only. It never blocks a start or a schema
 *   update, and is a soft note on the page.
 * - a symbolic link alone is evidence only.
 */

export type StoragePolicyRisk = Exclude<StorageRisk, "none">;

export interface StoragePolicy {
  /** The App may not use the database at all. */
  readonly refused: boolean;
  /** The database may be used only after an explicit consent that states the reason. */
  readonly needsConsent: boolean;
  /** A schema update on this database is refused. */
  readonly migrationBlocked: boolean;
  /** The page shows a note about the storage (every verdict but `none`). */
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

/** A positive finding (not `none`, not `unknown`): the ones that block a schema update. */
export function isPositiveRisk(risk: StorageRisk | undefined): boolean {
  return storagePolicy(risk).migrationBlocked;
}

/**
 * Whether choosing this database needs the consent checkbox. A positive risk always does. `unknown` does only for a
 * source nobody chose on purpose (one-click 沿用); a file the user browsed to has already been chosen explicitly.
 */
export function needsStorageConsent(risk: StorageRisk | undefined, chosenByUser: boolean): boolean {
  if (storagePolicy(risk).needsConsent) return true;
  return risk === "unknown" && !chosenByUser;
}

/**
 * The migration flag a start may carry: the user's consent to the update, forced off on a positive risk (the copy to
 * the local disk is the way out), never forced off for `unknown`.
 */
export function allowMigrationFor(needsMigration: boolean, risk: StorageRisk | undefined): boolean {
  return needsMigration && !storagePolicy(risk).migrationBlocked;
}

/** Whether the page must hide "use" for this source: refused storage, or an update it needs that the storage forbids. */
export function storageBlocksUse(risk: StorageRisk | undefined, needsMigration: boolean): boolean {
  const policy = storagePolicy(risk);
  return policy.refused || (needsMigration && policy.migrationBlocked);
}

/** The fact the Web status page shows; `none` shows nothing. */
export function storageRiskFact(
  result: Pick<StorageRiskResult, "risk"> | undefined,
): { risk: StoragePolicyRisk; migrationBlocked: boolean } | undefined {
  if (!result || result.risk === "none") return undefined;
  return { risk: result.risk, migrationBlocked: storagePolicy(result.risk).migrationBlocked };
}
