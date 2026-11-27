import type { DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { DatabasePreviewResult } from "../backend/backend-supervisor.js";
import { needsStorageConsent, storagePolicy } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { DbProbeStatus } from "../db-source/types.js";

export interface CandidatePreview {
  readonly status: DbProbeStatus;
  readonly needsMigration: boolean;
  readonly identity?: DesktopDatabaseIdentity;
  readonly errorCode?: string;
}

export interface CandidateEntry {
  readonly id: string;
  readonly path: string;
  readonly preview: CandidatePreview | undefined;
  readonly storageRisk?: StorageRisk;
}

export type ConfirmCheck =
  | {
      readonly ok: true;
      readonly entry: CandidateEntry;
      readonly preview: CandidatePreview;
      readonly identity: DesktopDatabaseIdentity;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown"
        | "not-previewed"
        | "not-usable"
        | "migration-consent-required"
        | "storage-refused"
        | "migration-blocked-by-storage"
        | "storage-consent-required";
    };

export function previewToCandidate(result: DatabasePreviewResult): CandidatePreview {
  if (result.outcome === "failed") return { status: "unreadable", needsMigration: false, errorCode: result.code };
  const { preflight } = result;
  if (preflight.status === "ok" && !preflight.identity) return { status: "unreadable", needsMigration: false };
  return {
    status: preflight.status,
    needsMigration: result.willMigrate,
    ...(preflight.identity ? { identity: preflight.identity } : {}),
  };
}

export class CandidateRegistry {
  private readonly capacity: number;
  private readonly newId: () => string;
  private readonly entries = new Map<string, CandidateEntry>();

  constructor(newId: () => string, capacity = 5) {
    this.newId = newId;
    this.capacity = capacity;
  }

  add(path: string): string {
    for (const [id, entry] of this.entries) {
      if (entry.path === path) this.entries.delete(id);
    }
    while (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    const id = this.newId();
    this.entries.set(id, { id, path, preview: undefined });
    return id;
  }

  setPreview(id: string, preview: CandidatePreview): void {
    const entry = this.entries.get(id);
    if (entry) this.entries.set(id, { ...entry, preview });
  }

  setStorageRisk(id: string, risk: StorageRisk): void {
    const entry = this.entries.get(id);
    if (entry) this.entries.set(id, { ...entry, storageRisk: risk });
  }

  get(id: string): CandidateEntry | undefined {
    return this.entries.get(id);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  list(): readonly CandidateEntry[] {
    return [...this.entries.values()];
  }

  checkConfirm(id: string, allowMigration: boolean, acknowledgeStorageRisk = false): ConfirmCheck {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: "unknown" };
    const { preview } = entry;
    if (!preview) return { ok: false, reason: "not-previewed" };
    if (preview.status !== "ok" || !preview.identity) return { ok: false, reason: "not-usable" };
    const policy = storagePolicy(entry.storageRisk);
    if (policy.refused) return { ok: false, reason: "storage-refused" };
    if (preview.needsMigration && policy.migrationBlocked) {
      return { ok: false, reason: "migration-blocked-by-storage" };
    }
    if (preview.needsMigration && !allowMigration) return { ok: false, reason: "migration-consent-required" };
    if (needsStorageConsent(entry.storageRisk, true) && !acknowledgeStorageRisk) {
      return { ok: false, reason: "storage-consent-required" };
    }
    return { ok: true, entry, preview, identity: preview.identity };
  }
}
