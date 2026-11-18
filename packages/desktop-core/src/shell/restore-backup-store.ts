import { randomUUID } from "node:crypto";

/** How long a listed or chosen backup waits for the user to confirm the restore. */
export const RESTORE_BACKUP_TTL_MS = 10 * 60 * 1000;
/** Most tokens one window holds at once (the listed backups plus the one the user chose). */
export const RESTORE_BACKUP_MAX_PER_SENDER = 60;

interface Held<T> {
  readonly backupId: string;
  readonly entry: T;
  readonly expiresAt: number;
  /** A listing replaces the earlier listing; a chosen file replaces the earlier chosen file; neither touches the other. */
  readonly source: "listed" | "picked";
}

/** A backup taken for restoring: what main holds for the token, and a way to hand it back when the restore did not start. */
export interface RestoreClaim<T> {
  readonly entry: T;
  /** The restore never started (a refusal, a cancelled dialog): the same token may be used again, until it expires. */
  release(): void;
}

export interface RestoreBackupStoreOptions {
  /** Milliseconds clock; injected for tests. */
  readonly clock: () => number;
  readonly ttlMs?: number;
  /** A new unguessable id; injected for tests. */
  readonly newId?: () => string;
}

/**
 * The backups main keeps in memory for the restore flow. The page never holds a path: `list` and `pick` hand it opaque ids
 * (backupId), and `run` sends one back. Each id is bound to the window that asked, is gone after the time limit and is single
 * use; an id that is unknown, expired, used or made for another window all look the same: no claim. The same model as the
 * diagnostics preview store, with several entries per window.
 */
export class RestoreBackupStore<T> {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly newId: () => string;
  private readonly held = new Map<number, Map<string, Held<T>>>();

  constructor(options: RestoreBackupStoreOptions) {
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? RESTORE_BACKUP_TTL_MS;
    this.newId = options.newId ?? randomUUID;
  }

  /** Keeps `entries` for `senderId` as its listing (the earlier listing is gone) and returns their ids, in order. */
  putListed(senderId: number, entries: readonly T[]): string[] {
    return this.put(senderId, "listed", entries);
  }

  /** Keeps the chosen `entry` for `senderId` (the earlier chosen file is gone) and returns its id. */
  putPicked(senderId: number, entry: T): string {
    return this.put(senderId, "picked", [entry])[0] as string;
  }

  /** Takes the entry of `backupId` for `senderId` (single use), or undefined when it cannot be taken. */
  claim(senderId: number, backupId: string): RestoreClaim<T> | undefined {
    this.pruneExpired();
    const mine = this.held.get(senderId);
    const found = mine?.get(backupId);
    if (!mine || !found) return undefined;
    mine.delete(backupId);
    return {
      entry: found.entry,
      release: () => {
        const again = this.held.get(senderId) ?? new Map<string, Held<T>>();
        // A newer listing of the same kind wins; an expired token is not brought back.
        const replaced = [...again.values()].some((other) => other.source === found.source);
        if (!replaced && this.clock() < found.expiresAt) {
          again.set(backupId, found);
          this.held.set(senderId, again);
        }
      },
    };
  }

  private put(senderId: number, source: Held<T>["source"], entries: readonly T[]): string[] {
    this.pruneExpired();
    const mine = this.held.get(senderId) ?? new Map<string, Held<T>>();
    for (const [id, other] of mine) if (other.source === source) mine.delete(id);
    const expiresAt = this.clock() + this.ttlMs;
    const ids: string[] = [];
    for (const entry of entries.slice(0, Math.max(0, RESTORE_BACKUP_MAX_PER_SENDER - mine.size))) {
      const backupId = this.newId();
      mine.set(backupId, { backupId, entry, expiresAt, source });
      ids.push(backupId);
    }
    this.held.set(senderId, mine);
    return ids;
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const [senderId, mine] of this.held) {
      for (const [id, entry] of mine) if (now >= entry.expiresAt) mine.delete(id);
      if (mine.size === 0) this.held.delete(senderId);
    }
  }
}
