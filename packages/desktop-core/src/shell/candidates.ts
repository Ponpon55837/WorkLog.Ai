import type { DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { DatabasePreviewResult } from "../backend/backend-supervisor.js";
import { needsStorageConsent, storagePolicy } from "../db-source/storage-policy.js";
import type { StorageRisk } from "../db-source/storage-risk.js";
import type { DbProbeStatus } from "../db-source/types.js";

/** What a read-only preflight found out about a database the user picked. */
export interface CandidatePreview {
  readonly status: DbProbeStatus;
  /** Opening it would write the schema (an empty file, or an older version): needs the user's explicit consent. */
  readonly needsMigration: boolean;
  readonly identity?: DesktopDatabaseIdentity;
  /** The preview itself could not run: the real backend error code (RUNTIME_MISSING, CHILD_START_TIMEOUT, ...). */
  readonly errorCode?: string;
}

export interface CandidateEntry {
  readonly id: string;
  /** The real path; it stays in main. */
  readonly path: string;
  readonly preview: CandidatePreview | undefined;
  /** What kind of storage the file is on (DT-08); undefined until it was classified. */
  readonly storageRisk?: StorageRisk;
}

export type ConfirmCheck =
  | {
      readonly ok: true;
      readonly entry: CandidateEntry;
      readonly preview: CandidatePreview;
      /** What the preview read; the start must find this very database. */
      readonly identity: DesktopDatabaseIdentity;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown"
        | "not-previewed"
        | "not-usable"
        | "migration-consent-required"
        /** A network drive: the App never uses it. */
        | "storage-refused"
        /** A removable disk, a sync folder or a hard link cannot take a schema update; copy it to the local disk. */
        | "migration-blocked-by-storage"
        | "storage-consent-required";
    };

/** The preview of the supervisor's preflight as the page shows it; a preview that could not run is `unreadable`. */
export function previewToCandidate(result: DatabasePreviewResult): CandidatePreview {
  if (result.outcome === "failed") return { status: "unreadable", needsMigration: false, errorCode: result.code };
  const { preflight } = result;
  // Without the identity nothing can be confirmed against the file: an `ok` that carries none is not usable.
  if (preflight.status === "ok" && !preflight.identity) return { status: "unreadable", needsMigration: false };
  return {
    status: preflight.status,
    needsMigration: result.willMigrate,
    ...(preflight.identity ? { identity: preflight.identity } : {}),
  };
}

/**
 * The databases the user picked in the repair window, by opaque id. At most `capacity` are kept (the oldest goes first).
 * Only a database whose preview says `ok` may be confirmed, and one that needs a schema update only with consent.
 */
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

  /**
   * Whether `id` may be confirmed now; `allowMigration` is the user's explicit consent to a schema update and
   * `acknowledgeStorageRisk` the ticked checkbox that states why its storage is risky (DT-08).
   */
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
    // A file the user browsed to was chosen on purpose, so only a positive risk asks for the checkbox.
    if (needsStorageConsent(entry.storageRisk, true) && !acknowledgeStorageRisk) {
      return { ok: false, reason: "storage-consent-required" };
    }
    return { ok: true, entry, preview, identity: preview.identity };
  }
}
