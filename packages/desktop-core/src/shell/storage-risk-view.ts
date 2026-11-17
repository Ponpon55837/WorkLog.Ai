import { needsStorageConsent, storagePolicy, type StoragePolicyRisk } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { ShellLocale } from "./i18n.js";
import { formatMessage } from "./i18n.js";
import { setupMessages } from "./setup-i18n.js";

/**
 * How a page shows risky storage (DT-08): the verdict in plain words, what can go wrong, what to do, and which controls
 * apply. Built in main from a classification, so the page holds no policy of its own.
 */
export interface StorageRiskView {
  readonly risk: StoragePolicyRisk;
  readonly label: string;
  readonly why: string;
  readonly todo: string;
  /** The App will not use it at all (a network drive). */
  readonly refused: boolean;
  /** The checkbox text; present when the user must tick it before the database may be used. */
  readonly consent?: string;
  /** A schema update on it is refused; the reason, when it matters for this database. */
  readonly migrationNote?: string;
  /** 「複製到本機磁碟並改用」 is offered. */
  readonly canCopyToLocal: boolean;
}

export interface StorageRiskViewInputs {
  readonly risk: StorageRisk | undefined;
  readonly locale: ShellLocale;
  /** The user picked this file on purpose (a browsed file), not a one-click source. */
  readonly chosenByUser: boolean;
  /** Opening it would update its schema. */
  readonly needsMigration: boolean;
}

/** The view of one classification; `undefined` when there is nothing to say (the storage is fine). */
export function buildStorageRiskView(inputs: StorageRiskViewInputs): StorageRiskView | undefined {
  const { risk } = inputs;
  const policy = storagePolicy(risk);
  if (risk === undefined || risk === "none" || !policy.note) return undefined;
  const text = setupMessages(inputs.locale);
  const entry = text.storageRisk[risk];
  const positive = policy.migrationBlocked && !policy.refused;
  return {
    risk,
    label: entry.label,
    why: entry.why,
    todo: entry.todo,
    refused: policy.refused,
    ...(needsStorageConsent(risk, inputs.chosenByUser) ? { consent: entry.consent } : {}),
    ...(positive && inputs.needsMigration
      ? { migrationNote: formatMessage(text.storageMigrationBlocked, { label: entry.label }) }
      : {}),
    // A refused (network) database can only be used as a local copy; a positive risk is offered it when its update is refused.
    canCopyToLocal: policy.refused || (positive && inputs.needsMigration),
  };
}
