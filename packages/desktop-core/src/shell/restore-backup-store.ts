import { randomUUID } from "node:crypto";

export const RESTORE_BACKUP_TTL_MS = 10 * 60 * 1000;
export const RESTORE_BACKUP_MAX_PER_SENDER = 60;

interface Held<T> {
  readonly backupId: string;
  readonly entry: T;
  readonly expiresAt: number;
  readonly source: "listed" | "picked";
}

export interface RestoreClaim<T> {
  readonly entry: T;
  release(): void;
}

export interface RestoreBackupStoreOptions {
  readonly clock: () => number;
  readonly ttlMs?: number;
  readonly newId?: () => string;
}

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

  putListed(senderId: number, entries: readonly T[]): string[] {
    return this.put(senderId, "listed", entries);
  }

  putPicked(senderId: number, entry: T): string {
    return this.put(senderId, "picked", [entry])[0] as string;
  }

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
