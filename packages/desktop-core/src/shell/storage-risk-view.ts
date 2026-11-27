import { needsStorageConsent, storagePolicy, type StoragePolicyRisk } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { ShellLocale } from "./i18n.js";
import { formatMessage } from "./i18n.js";
import { setupMessages } from "./setup-i18n.js";

export interface StorageRiskView {
  readonly risk: StoragePolicyRisk;
  readonly label: string;
  readonly why: string;
  readonly todo: string;
  readonly refused: boolean;
  readonly consent?: string;
  readonly migrationNote?: string;
  readonly canCopyToLocal: boolean;
}

export interface StorageRiskViewInputs {
  readonly risk: StorageRisk | undefined;
  readonly locale: ShellLocale;
  readonly chosenByUser: boolean;
  readonly needsMigration: boolean;
}

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
    canCopyToLocal: policy.refused || (positive && inputs.needsMigration),
  };
}
